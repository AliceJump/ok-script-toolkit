import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { injectWebviewLocalization, projectLocale, tr } from './localization';
import { loadToolboxState, saveToolboxState } from './toolboxState';

/** 单个任务的元信息 */
interface TaskInfo {
  module: string;
  className: string;
  /** 显示名：优先任务的 name，回退类名 */
  displayName: string;
}

/** 任务列表请求结果 */
interface TaskListResult {
  ok: boolean;
  error?: string;
  tasks?: TaskInfo[];
  /** config 模块路径：`src.config` 或 `config`（取决于 config.py 所在位置） */
  configModule?: string;
}

/** 每个任务可编辑的一项参数（对应项目任务 default_config 里的一个 key） */
interface TaskParamField {
  key: string;
  displayKey?: string;
  /** 默认值（决定控件类型：bool→开关、int/float→数字、str→文本框、list→多选/列表） */
  default?: unknown;
  /** 当前已保存值 */
  value?: unknown;
  /** config_type 元信息（drop_down / multi_selection 的 options 等） */
  type?: Record<string, unknown>;
  /** config_description 说明 */
  desc?: string;
  displayDesc?: string;
}

/** 从项目任务类采集到的 schema */
interface TaskSchema {
  /** 该任务可编辑的参数列表（按 default_config 顺序） */
  fields: TaskParamField[];
  /** 是否采集失败（broken） */
  broken?: boolean;
  error?: string;
  displayName?: string;
  description?: string;
  kind?: 'onetime' | 'trigger';
  /** 项目声明的配置分组/子任务树：组名 -> 字段或子组 key。 */
  configGroups?: Record<string, string[]>;
  groupLabels?: Record<string, string>;
  /** register_config_groups 生成的分组下拉字段。 */
  groupSelector?: string;
  locale?: string;
}

/** 每个任务的独立配置（持久化到 .vscode/ok-script-toolkit-tasks.json） */
interface TaskConfig {
  /** 透传给 ok-script / 项目级 argparse 的额外命令行参数（UI 已移除，历史配置仍生效）。 */
  extraArgs?: string;
  /** 仅对当前任务子进程生效的环境变量（UI 已移除，历史配置仍生效）。 */
  env?: Record<string, string>;
  /** 自动停止超时（秒）；0 或未设置表示不限时。 */
  timeout?: number;
  /** 任务参数覆盖：key=任务 default_config 的 key，value=覆盖值 */
  params?: Record<string, unknown>;
}

/** 所有任务配置的持久化结构 */
interface TaskConfigStore {
  projects: Record<string, { tasks: Record<string, TaskConfig> }>;
}

/** schema 采集结果（刷新时全量 import 项目任务后落盘缓存） */
interface SchemaProbeResult {
  ok: boolean;
  error?: string;
  schemas?: Record<string, TaskSchema>;
  /** 参与采集的任务总数 */
  total?: number;
}

/** 扩展根目录下 python/ 脚本的绝对路径 */
export function pythonScript(extensionUri: vscode.Uri, name: string): string {
  return path.join(extensionUri.fsPath, 'python', name);
}

/** 解析 Python 子进程 stdout 中最后一个 JSON 行（前面的输出可能是日志） */
export function parseJsonFromStdout(stdout: string): any {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* 跳过非 JSON 行 */ }
  }
  return null;
}

/** 解析额外参数：优先接受 JSON 字符串数组，否则按 shell 风格引号拆分。 */
function parseExtraArgs(value: string | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch { /* 回退到引号拆分 */ }

  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  if (quote) throw new Error(tr('Extra arguments contain an unclosed quote'));
  if (current) args.push(current);
  return args;
}

interface PythonResult {
  stdout: string;
  stderr: string;
}

/** 异步运行 Python，避免耗时探针阻塞 VS Code 扩展宿主。 */
export function runPython(
  pythonPath: string,
  args: string[],
  projectDir: string,
  timeout: number,
): Promise<PythonResult> {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  return new Promise((resolve, reject) => {
    cp.execFile(pythonPath, args, {
      cwd: projectDir,
      env,
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        // 项目脚本约定：失败时往 stdout 末尾打印 {"ok": false, "error": "..."}；
        // 优先回传结构化错误，其次 stderr，最后才是通用命令失败信息。
        const parsed = parseJsonFromStdout(stdout || '');
        const message = (parsed && typeof parsed.error === 'string' && parsed.error)
          || stderr?.trim()
          || error.message;
        reject(new Error(message));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * 用 Python 子进程 + AST 安全解析 ok-script 项目的 src/config.py，
 * 提取 onetime_tasks / trigger_tasks 注册表，不导入任何模块。
 */
async function parseConfigTasks(extensionUri: vscode.Uri, projectDir: string, pythonPath: string): Promise<TaskListResult> {
  try {
    const result = await runPython(
      pythonPath,
      [pythonScript(extensionUri, 'parse_config_tasks.py'), projectDir],
      projectDir,
      15000,
    );
    const parsed = parseJsonFromStdout(result.stdout || '');
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || tr('Failed to parse task list') };
    }
    const configModule = parsed.config_module || 'src.config';
    const tasks: TaskInfo[] = [
      ...(parsed.onetime || []),
      ...(parsed.trigger || []),
    ].map((t: any) => ({
      module: t.module,
      className: t['class'] || t.class,
      displayName: t.name || t['class'] || t.module,
    }));
    return { ok: true, tasks, configModule };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 运行单个任务（headless，不启动 GUI）——spawn python/run_task.py。
 *
 * 参数覆盖经环境变量 OK_LANG_HINTS_INJECT 传入：{"module::TaskClassName": {key: value}}。
 * run_task.py 内猴子补丁 BaseTask.load_config，在任务加载配置后把 params 覆盖进
 * self.config（仅内存，不写 configs/*.json，不污染项目配置）。
 */
function buildRunTaskCommand(extensionUri: vscode.Uri, task: TaskInfo, configModule: string): string[] {
  return [
    pythonScript(extensionUri, 'run_task.py'),
    '--task', task.className,
    '--task-module', task.module,
    '--config-module', configModule,
  ];
}

/**
 * 用 Python 子进程 + 全量 import 采集项目所有任务的配置 schema —— spawn
 * python/probe_task_schemas.py。复用 ok-script 的 OK(config) + TaskManager
 * 初始化来实例化任务，拿到经过继承链合并的真实 default_config / config_type /
 * config_description / 已保存 config。逐任务 try/except 容错，坏任务标记 broken。
 */
async function probeTaskSchemas(
  extensionUri: vscode.Uri,
  projectDir: string,
  pythonPath: string,
  locale: string,
  poDirectory: string,
): Promise<SchemaProbeResult> {
  try {
    const result = await runPython(
      pythonPath,
      [pythonScript(extensionUri, 'probe_task_schemas.py'), projectDir, locale, poDirectory],
      projectDir,
      120000,
    );
    const parsed = parseJsonFromStdout(result.stdout || '');
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || tr('Failed to collect task schema') };
    }
    return { ok: true, schemas: parsed.schemas, total: parsed.total };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 解析 ok-script 项目路径与 Python 解释器（工具箱与任务启动器共用）。
 * 配置未填写时，自动检测当前工作区根目录（若含 src/config.py 则视为 ok-script 项目）。
 */
export function resolveProjectContext(): { projectDir: string; pythonPath: string; fromConfig: boolean } {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
  let projectDir = cfg.get<string>('okScriptProjectPath') || '';
  let fromConfig = true;
  projectDir = projectDir.replace(/^~/, process.env.USERPROFILE || '');
  projectDir = projectDir.replace(/[\\/]+$/, '');

  if (!projectDir) {
    // 自动检测：工作区根目录是否本身就是 ok-script 项目
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (root && (fs.existsSync(path.join(root, 'src', 'config.py')) || fs.existsSync(path.join(root, 'config.py')))) {
      projectDir = root;
      fromConfig = false;
    }
  }

  const python = cfg.get<string>('okScriptPython') || '';
  let pythonPath = python;
  if (!pythonPath) {
    const venvPy = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
    pythonPath = fs.existsSync(venvPy) ? venvPy : 'python';
  }
  return { projectDir, pythonPath, fromConfig };
}

/** 侧边栏任务启动视图 */
export class TaskLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.taskLauncher';

  /** 当前活跃实例：工具箱经此向运行中的任务转发浮层开关命令 */
  static current: TaskLauncherViewProvider | undefined;

  private readonly output: vscode.OutputChannel;
  private running = false;
  private currentTask: TaskInfo | undefined;
  private configModule = 'src.config';
  private childProcess: cp.ChildProcess | null = null;
  private stopRequested = false;
  private timedOutRequested = false;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private view: vscode.WebviewView | null = null;
  private currentProjectDir = '';
  private refreshGeneration = 0;
  /** 每任务独立配置（内存缓存 + 持久化到 .vscode/ok-script-toolkit-tasks.json） */
  private taskConfigs: Record<string, TaskConfig> = {};
  private knownTasks: TaskInfo[] = [];
  /** 采集到的任务参数 schema（缓存到 .vscode/ok-script-toolkit-schema.json） */
  private schemas: Record<string, TaskSchema> = {};
  /** 任务是否已被 run_task.py 确认暂停（以 stdout 标记行为准） */
  private paused = false;
  /** 调试浮层当前是否生效（启动沿用工具箱状态，运行中经 overlay_* 标记同步） */
  private overlayActive = false;
  /** stdout 按行扫描的未完结残留（标记行可能跨 chunk 到达） */
  private stdoutRemainder = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
  ) {
    this.output = vscode.window.createOutputChannel(tr('ok-script Task Launcher'));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    TaskLauncherViewProvider.current = this;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'taskLauncher')],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.refreshTasks(view);
          // webview 重建后同步当前运行状态，避免切换侧边栏再回来时按钮状态丢失
          if (this.running && this.currentTask) {
            void view.webview.postMessage({ type: 'running', task: this.currentTask, running: true, paused: this.paused });
          }
          break;
        case 'refresh':
          await this.refreshTasks(view);
          break;
        case 'launch':
          if (this.isKnownTask(msg.task)) await this.launchTask(view, msg.task);
          break;
        case 'stop':
          await this.stopTask();
          break;
        case 'pause':
          this.sendControlCommand(view, 'pause');
          break;
        case 'resume':
          this.sendControlCommand(view, 'resume');
          break;
        case 'saveConfig':
          if (this.isKnownTask(msg.task)) await this.saveTaskConfig(msg.task, this.sanitizeTaskConfig(msg.task, msg.config));
          break;
        case 'loadConfigs':
          await this.loadTaskConfigs();
          break;
      }
    });
  }

  private isKnownTask(task: unknown): task is TaskInfo {
    if (!task || typeof task !== 'object') return false;
    const candidate = task as Partial<TaskInfo>;
    if (typeof candidate.module !== 'string' || typeof candidate.className !== 'string') return false;
    return this.knownTasks.some((task) => task.module === candidate.module && task.className === candidate.className);
  }

  private sanitizeTaskConfig(task: TaskInfo, value: unknown): TaskConfig {
    if (!value || typeof value !== 'object') return {};
    const raw = value as Record<string, unknown>;
    const config: TaskConfig = {};
    if (typeof raw.extraArgs === 'string' && raw.extraArgs.trim()) config.extraArgs = raw.extraArgs.trim();
    if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) {
      config.timeout = Math.min(raw.timeout, 7 * 24 * 60 * 60);
    }
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      const env: Record<string, string> = {};
      for (const [key, item] of Object.entries(raw.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string') env[key] = item;
      }
      if (Object.keys(env).length) config.env = env;
    }
    if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
      const schemaFields = this.schemas[this.taskKey(task)]?.fields;
      const params: Record<string, unknown> = {};
      if (!schemaFields?.length) {
        // schema 未就绪（或采集失败）时原样保留，避免自动保存误删既有参数覆盖
        Object.assign(params, raw.params as Record<string, unknown>);
      } else {
        const allowed = new Set(schemaFields.map((field) => field.key));
        for (const [key, item] of Object.entries(raw.params as Record<string, unknown>)) {
          if (allowed.has(key)) params[key] = item;
        }
      }
      if (Object.keys(params).length) config.params = params;
    }
    return config;
  }

  /** .vscode 目录下 ok-script-toolkit 数据文件的绝对路径 */
  private dataFile(name: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.join(root, '.vscode', name);
  }

  /** 读取 .vscode/ok-script-toolkit-tasks.json（每任务独立配置持久化） */
  private loadTaskConfigs(projectDir = this.currentProjectDir): void {
    try {
      const p = this.dataFile('ok-script-toolkit-tasks.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskConfigStore> & { tasks?: Record<string, TaskConfig> };
        // 兼容旧版顶层 tasks 格式；保存后自动迁移为按项目隔离的 projects。
        this.taskConfigs = raw.projects?.[projectDir]?.tasks || raw.tasks || {};
      } else {
        this.taskConfigs = {};
      }
    } catch (e) {
      this.taskConfigs = {};
      void vscode.window.showWarningMessage(tr('Failed to read task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    if (this.view) {
      void this.view.webview.postMessage({ type: 'taskConfigs', configs: this.taskConfigs });
    }
  }

  /** 保存单个任务的配置到 .vscode/ok-script-toolkit-tasks.json */
  private async saveTaskConfig(task: TaskInfo, config: TaskConfig): Promise<void> {
    const key = `${task.module}::${task.className}`;
    const nextConfigs = { ...this.taskConfigs, [key]: config };
    try {
      const p = this.dataFile('ok-script-toolkit-tasks.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      let store: TaskConfigStore = { projects: {} };
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskConfigStore>;
        if (raw.projects && typeof raw.projects === 'object') {
          store = { projects: raw.projects };
        }
      }
      store.projects[this.currentProjectDir] = { tasks: nextConfigs };
      fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
    } catch (e) {
      const message = tr('Failed to save task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      });
      void vscode.window.showErrorMessage(message);
      if (this.view) {
        void this.view.webview.postMessage({ type: 'status', level: 'error', text: message });
      }
      return;
    }
    this.taskConfigs = nextConfigs;
    // webview 在发送 saveConfig 前已自行同步内存状态并显示“已自动保存”，
    // 这里不再回推 taskConfigs（回推会触发整列表重渲染，打断正在进行的编辑）。
  }

  /** 读取 schema 缓存；无缓存时返回空 */
  private loadSchemaCache(projectDir: string, locale: string): Record<string, TaskSchema> {
    try {
      const p = this.dataFile('ok-script-toolkit-schema.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SchemaProbeResult & { projectDir?: string; locale?: string };
        const cachedLocale = raw.locale || Object.values(raw.schemas || {})[0]?.locale;
        return raw.projectDir === projectDir && cachedLocale === locale ? raw.schemas || {} : {};
      }
    } catch { /* 忽略损坏的缓存 */ }
    return {};
  }

  /** 写入 schema 缓存 */
  private saveSchemaCache(projectDir: string, locale: string, schemas: Record<string, TaskSchema>): void {
    try {
      const p = this.dataFile('ok-script-toolkit-schema.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ ok: true, projectDir, locale, schemas }, null, 2), 'utf-8');
    } catch { /* 缓存失败不阻塞 */ }
  }

  /**
   * 读取配置获取项目路径和 Python 解释器（见 resolveProjectContext）。
   */
  private getConfig(): { projectDir: string; pythonPath: string; fromConfig: boolean } {
    return resolveProjectContext();
  }

  private async refreshTasks(view: vscode.WebviewView): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.knownTasks = [];
    const { projectDir, pythonPath, fromConfig } = this.getConfig();
    const locale = projectLocale();
    if (!projectDir) {
      void view.webview.postMessage({ type: 'tasks', tasks: [], schemas: {} });
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: tr('No ok-script project was found. Configure okScriptToolkit.okScriptProjectPath or open a folder containing src/config.py.'),
      });
      return;
    }
    if (!fs.existsSync(projectDir)) {
      void view.webview.postMessage({ type: 'tasks', tasks: [], schemas: {} });
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: tr('Project directory does not exist: {path}', { path: projectDir }),
      });
      return;
    }
    // 先读缓存（可能有上次采集的 schema，先让 UI 能用）
    this.currentProjectDir = projectDir;
    this.schemas = this.loadSchemaCache(projectDir, locale);
    this.loadTaskConfigs(projectDir);
    const result = await parseConfigTasks(this.extensionUri, projectDir, pythonPath);
    if (generation !== this.refreshGeneration) return;
    if (!result.ok) {
      void view.webview.postMessage({ type: 'tasks', tasks: [], schemas: {} });
      void view.webview.postMessage({
        type: 'status',
        level: 'error',
        text: tr('Failed to load task list: {error}', { error: result.error || tr('Unknown error') }),
      });
      return;
    }
    if (result.configModule) this.configModule = result.configModule;
    const tasks = (result.tasks || []).map((task) => ({
      ...task,
      displayName: this.schemas[this.taskKey(task)]?.displayName || task.displayName,
    }));
    this.knownTasks = tasks;
    await view.webview.postMessage({ type: 'tasks', tasks, schemas: this.schemas });
    void view.webview.postMessage({
      type: 'status',
      level: 'ok',
      text: fromConfig
        ? tr('Loaded {count} tasks', { count: tasks.length })
        : tr('Workspace project detected · Loaded {count} tasks', { count: tasks.length }),
    });

    // 后台全量 import 采集 schema（失败不影响任务列表，仅提示）
    void this.probeSchemasInBackground(view, projectDir, pythonPath, locale, generation);
  }

  /** 后台采集任务参数 schema：全量 import 项目任务，成功则缓存并回推给 UI */
  private async probeSchemasInBackground(
    view: vscode.WebviewView,
    projectDir: string,
    pythonPath: string,
    locale: string,
    generation: number,
  ): Promise<void> {
    const poDirectory = vscode.workspace.getConfiguration('okScriptToolkit').get<string>('poDirectory') || 'i18n';
    const probe = await probeTaskSchemas(
      this.extensionUri,
      projectDir,
      pythonPath,
      locale,
      poDirectory,
    );
    if (generation !== this.refreshGeneration || projectDir !== this.currentProjectDir) return;
    if (!probe.ok || !probe.schemas) {
      void view.webview.postMessage({
        type: 'status',
        level: 'warn',
        text: tr('Failed to collect task parameter schema (launch is still available): {error}', {
          error: probe.error || tr('Unknown error'),
        }),
      });
      return;
    }
    this.schemas = probe.schemas;
    this.saveSchemaCache(projectDir, locale, probe.schemas);
    const brokenCount = Object.values(probe.schemas).filter((s) => s.broken).length;
    // 只回推 schema 更新，让 UI 把已展开的任务卡片渲染出参数表单
    void view.webview.postMessage({ type: 'schemas', schemas: this.schemas });
    if (!this.running) {
      void view.webview.postMessage({
        type: 'status',
        level: 'ok',
        text: brokenCount
          ? tr('Loaded {count} tasks; parameter schema is ready ({broken} failed)', {
              count: probe.total ?? 0,
              broken: brokenCount,
            })
          : tr('Loaded {count} tasks; parameter schema is ready', { count: probe.total ?? 0 }),
      });
    }
  }

  private async launchTask(view: vscode.WebviewView, task: TaskInfo): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage(tr('A task is already running. Wait for it to finish or stop it first.'));
      return;
    }
    const { projectDir, pythonPath } = this.getConfig();
    if (!projectDir) {
      void vscode.window.showErrorMessage(tr('The ok-script project path is not configured.'));
      return;
    }
    if (!fs.existsSync(projectDir)) {
      void vscode.window.showErrorMessage(tr('Project directory does not exist: {path}', { path: projectDir }));
      return;
    }
    if (!fs.existsSync(pythonPath) && pythonPath !== 'python') {
      void vscode.window.showErrorMessage(tr('Python interpreter does not exist: {path}', { path: pythonPath }));
      return;
    }
    this.currentTask = task;
    this.running = true;
    this.stopRequested = false;
    this.timedOutRequested = false;
    this.paused = false;
    this.stdoutRemainder = '';
    this.output.clear();
    this.output.appendLine(tr('▶ Launch task: {task} ({module})', { task: task.displayName, module: task.module }));
    this.output.appendLine(tr('Project: {path}', { path: projectDir }));
    this.output.appendLine(tr('Python: {path}', { path: pythonPath }));
    // 带出该任务的独立配置（params 参数覆盖注入运行时）
    const cfg = this.getTaskConfig(task);
    if (cfg?.params && Object.keys(cfg.params).length > 0) {
      this.output.appendLine(tr('Parameter overrides: {count}', { count: Object.keys(cfg.params).length }));
    }
    this.output.show(true);
    void view.webview.postMessage({ type: 'running', task, running: true });

    let extraArgs: string[];
    try {
      extraArgs = parseExtraArgs(cfg.extraArgs);
    } catch (e) {
      this.running = false;
      const message = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(tr('Failed to launch task: {error}', { error: message }));
      void view.webview.postMessage({ type: 'running', task, running: false, error: message });
      return;
    }
    const args = [...buildRunTaskCommand(this.extensionUri, task, this.configModule), '--', ...extraArgs];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      ...(cfg.env || {}),
    };
    // 参数注入通过环境变量传递（避免命令行长度/转义问题）
    if (cfg?.params && Object.keys(cfg.params).length > 0) {
      childEnv.OK_LANG_HINTS_INJECT = JSON.stringify({ [this.taskKey(task)]: cfg.params });
    }
    // 工具箱共享配置：任务启动无感沿用调试浮层开关与游戏连接
    const toolbox = loadToolboxState(projectDir);
    this.overlayActive = toolbox.overlay === true;
    if (this.overlayActive) {
      childEnv.OK_TOOLKIT_USE_OVERLAY = '1';
      this.output.appendLine(tr('▶ Debug overlay: enabled'));
    }
    if (toolbox.game) {
      // 实际复用由 connect_game.py 写入的 configs/devices.json selected_hwnd 驱动，
      // 这里仅记录连接来源，便于确认任务与工具箱操作的是同一个窗口。
      this.output.appendLine(tr('Reusing game connection from toolbox: {title} (PID {pid})', {
        title: toolbox.game.title || String(toolbox.game.hwnd),
        pid: toolbox.game.pid,
      }));
    }
    this.childProcess = cp.spawn(pythonPath, args, {
      cwd: projectDir,
      windowsHide: true,
      // 强制子进程以 UTF-8 编码输出，与 Python 端 reconfigure 配合彻底解决乱码
      env: childEnv,
    });
    // 子进程退出瞬间向 stdin 写入会以 error 事件异步报错（EPIPE），
    // 不挂监听会变成扩展宿主未捕获异常
    this.childProcess.stdin?.on('error', () => { /* 忽略 EPIPE */ });
    this.childProcess.stdout?.on('data', (d) => {
      const text = d.toString('utf8');
      this.scanControlMarkers(text);
      this.output.append(text);
    });
    this.childProcess.stderr?.on('data', (d) => this.output.append(d.toString('utf8')));
    this.childProcess.on('error', (err) => {
      this.clearTimeoutTimer();
      this.running = false;
      this.childProcess = null;
      this.output.appendLine('');
      this.output.appendLine(tr('❌ Failed to start Python process: {error}', { error: err.message }));
      void vscode.window.showErrorMessage(tr('Failed to launch task: {error}', { error: err.message }));
      void view.webview.postMessage({ type: 'running', task, running: false, error: err.message });
    });
    this.childProcess.on('close', (code) => {
      this.clearTimeoutTimer();
      const stopped = this.stopRequested;
      const timedOut = this.timedOutRequested;
      this.running = false;
      this.paused = false;
      this.overlayActive = false;
      this.stdoutRemainder = '';
      this.childProcess = null;
      this.output.appendLine('');
      this.output.appendLine(stopped
        ? tr('⏹ Task stopped')
        : code === 0
          ? tr('✅ Task completed')
          : tr('❌ Task exit code: {code}', { code: code ?? 'null' }));
      void view.webview.postMessage({
        type: 'running',
        task,
        running: false,
        code,
        stopped,
        timedOut,
        error: !stopped && code !== 0 ? tr('Task exit code: {code}', { code: code ?? 'null' }) : undefined,
      });
    });
    if (cfg.timeout && cfg.timeout > 0) {
      const timeoutSeconds = cfg.timeout;
      this.timeoutTimer = setTimeout(() => {
        if (this.running && this.childProcess) {
          this.output.appendLine('');
          this.output.appendLine(tr('⏱ Timeout reached after {seconds} seconds; stopping task...', {
            seconds: timeoutSeconds,
          }));
          void this.stopTask(true);
        }
      }, timeoutSeconds * 1000);
    }
  }

  /** 向任务子进程 stdin 发送运行期控制命令（run_task.py 按行读取 pause/resume） */
  private sendControlCommand(view: vscode.WebviewView, command: 'pause' | 'resume'): void {
    if (!this.running || !this.childProcess) {
      void vscode.window.showWarningMessage(tr('No task is currently running.'));
      return;
    }
    const stdin = this.childProcess.stdin;
    if (!stdin || !stdin.writable) {
      const message = tr('Failed to send command to the task process: {error}', { error: 'stdin unavailable' });
      void vscode.window.showErrorMessage(message);
      this.output.appendLine(message);
      return;
    }
    this.output.appendLine('');
    this.output.appendLine(command === 'pause' ? tr('⏸ Pausing task…') : tr('▶ Resuming task…'));
    try {
      stdin.write(`${command}\n`);
    } catch (err) {
      const message = tr('Failed to send command to the task process: {error}', {
        error: err instanceof Error ? err.message : String(err),
      });
      void vscode.window.showErrorMessage(message);
      this.output.appendLine(message);
    }
  }

  /** 暂停状态以 run_task.py 的确认标记为准；翻转时同步日志与 webview */
  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.output.appendLine(paused ? tr('⏸ Task paused') : tr('▶ Task resumed'));
    if (this.view) {
      void this.view.webview.postMessage({ type: 'paused', paused });
    }
  }

  /** 调试浮层以 run_task.py 的确认标记为准；翻转时同步日志并回写工具箱共享状态 */
  private setOverlayActive(active: boolean): void {
    if (this.overlayActive === active) return;
    this.overlayActive = active;
    this.output.appendLine(active ? tr('▶ Debug overlay: enabled') : tr('⏹ Debug overlay: disabled'));
    if (this.currentProjectDir) {
      saveToolboxState(this.currentProjectDir, { overlay: active });
    }
  }

  /**
   * 工具箱浮层开关 → 运行中任务即时生效（stdin overlay_on/off 命令）。
   * 无运行任务时返回 false，开关状态由工具箱直接持久化、下次启动沿用。
   */
  setOverlayEnabled(enabled: boolean): boolean {
    const stdin = this.childProcess?.stdin;
    if (!this.running || !stdin || !stdin.writable) return false;
    this.output.appendLine(enabled ? tr('▶ Enabling debug overlay…') : tr('⏹ Disabling debug overlay…'));
    try {
      stdin.write(enabled ? 'overlay_on\n' : 'overlay_off\n');
    } catch (err) {
      this.output.appendLine(tr('Failed to send command to the task process: {error}', {
        error: err instanceof Error ? err.message : String(err),
      }));
      return false;
    }
    return true;
  }

  /** 按行扫描 stdout，识别 run_task.py 输出的控制标记（标记行可能跨 chunk 到达） */
  private scanControlMarkers(text: string): void {
    const combined = this.stdoutRemainder + text;
    const lines = combined.split(/\r?\n/);
    this.stdoutRemainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.includes('OK_TOOLKIT_PAUSED')) {
        this.setPaused(true);
      } else if (line.includes('OK_TOOLKIT_RESUMED')) {
        this.setPaused(false);
      } else if (line.includes('OK_TOOLKIT_OVERLAY_ON')) {
        this.setOverlayActive(true);
      } else if (line.includes('OK_TOOLKIT_OVERLAY_OFF')) {
        this.setOverlayActive(false);
      } else if (line.includes('OK_TOOLKIT_ERROR:')) {
        const error = line.slice(line.indexOf('OK_TOOLKIT_ERROR:') + 'OK_TOOLKIT_ERROR:'.length).trim();
        if (this.view && error) {
          void this.view.webview.postMessage({
            type: 'status',
            level: 'error',
            text: tr('Task control command failed: {error}', { error }),
          });
        }
      }
    }
  }

  /** 读取某任务的独立配置（无则返回默认空配置） */
  private getTaskConfig(task: TaskInfo): TaskConfig {
    return this.taskConfigs[this.taskKey(task)] || {};
  }

  private taskKey(task: TaskInfo): string {
    return `${task.module}::${task.className}`;
  }

  private async stopTask(timedOut = false): Promise<void> {
    if (!this.running || !this.childProcess || !this.view) {
      void vscode.window.showWarningMessage(tr('No task is currently running.'));
      return;
    }
    
    this.output.appendLine('');
    this.output.appendLine(timedOut ? tr('⏱ Stopping timed-out task...') : tr('⏹ Stopping task...'));
    this.stopRequested = true;
    this.timedOutRequested = timedOut;
    void this.view.webview.postMessage({ type: 'running', task: this.currentTask, running: true, stopping: true, timedOut });
    
    // 尝试优雅终止
    try {
      if (process.platform === 'win32') {
        // Windows: 使用 taskkill（异步 spawn，避免阻塞扩展宿主）
        const pid = this.childProcess.pid;
        if (!pid) {
          throw new Error(tr('Unable to get the process PID'));
        }
        await new Promise<void>((resolve, reject) => {
          const taskkill = cp.spawn('taskkill', ['/F', '/T', '/PID', pid.toString()], {
            windowsHide: true,
            env: process.env,
          });
          let stderr = '';
          taskkill.stderr?.on('data', (d) => { stderr += d.toString(); });
          taskkill.on('error', reject);
          taskkill.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(stderr.trim() || tr('taskkill exit code {code}', { code: code ?? 'null' })));
            }
          });
        });
      } else {
        // Unix-like: 发送 SIGTERM
        this.childProcess.kill('SIGTERM');
      }
    } catch (err) {
      this.stopRequested = false;
      this.timedOutRequested = false;
      const error = err instanceof Error ? err.message : String(err);
      this.output.appendLine(tr('❌ Failed to stop task: {error}', { error }));
      void vscode.window.showErrorMessage(tr('Failed to stop task: {error}', { error }));
      void this.view.webview.postMessage({
        type: 'running',
        task: this.currentTask,
        running: true,
        error: tr('Failed to stop: {error}', { error }),
      });
    }
  }

  /** 释放资源（output channel 由扩展生命周期统一关闭） */
  dispose(): void {
    this.clearTimeoutTimer();
    if (TaskLauncherViewProvider.current === this) TaskLauncherViewProvider.current = undefined;
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.output.dispose();
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  /** 读取任务启动器 Webview 外壳并注入 CSP 与本地资源 URI。 */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2, 14);
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'taskLauncher', 'index.html');
    let html = '';
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch (e) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${tr('Error')}</title></head><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px">${tr('Unable to read view file: {error}', { error: e instanceof Error ? e.message : String(e) })}</body></html>`;
    }
    const resource = (name: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'taskLauncher', name),
    ).toString(true);
    return injectWebviewLocalization(
      html
        .split('__CSP_NONCE__').join(nonce)
        .split('__CSP_SOURCE__').join(webview.cspSource)
        .split('__STYLE_URI__').join(resource('taskLauncher.css'))
        .split('__CORE_SCRIPT_URI__').join(resource('core.js'))
        .split('__FIELDS_SCRIPT_URI__').join(resource('fields.js'))
        .split('__CONFIG_PANEL_SCRIPT_URI__').join(resource('configPanel.js'))
        .split('__TASK_CARD_SCRIPT_URI__').join(resource('taskCard.js'))
        .split('__APP_SCRIPT_URI__').join(resource('app.js')),
    );
  }
}