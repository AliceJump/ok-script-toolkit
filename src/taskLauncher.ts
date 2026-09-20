import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { injectWebviewLocalization, projectLocale, tr } from './localization';
import { resolveProjectDir } from './projectConfig';
import { loadToolboxState, notifyExecutorRunning, saveToolboxState } from './toolboxState';
import { errorPage, getNonce } from './webviewHtml';

/** 单个任务的元信息 */
interface TaskInfo {
  module: string;
  className: string;
  /** 显示名：优先任务的 name，回退类名 */
  displayName: string;
  /**
   * 任务类型：触发任务走「勾选启用 → 入列轮询」，一次性任务走「启动 → 入队执行一次」。
   * 由 parse_config_tasks.py 直接给出，不依赖 schema 采集完成。
   */
  kind?: 'onetime' | 'trigger';
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

/**
 * 每个任务的独立配置（持久化到 .vscode/ok-script-toolkit-tasks.json）。
 *
 * extraArgs / env 是历史字段：常驻执行器把全部任务跑在同一个进程里，进程级参数
 * 无法再按任务区分，因此不再生效（仅保留数据，不做删除）。UI 早已移除这两项。
 */
interface TaskConfig {
  extraArgs?: string;
  env?: Record<string, string>;
  /** 任务参数覆盖：key=任务 default_config 的 key，value=覆盖值 */
  params?: Record<string, unknown>;
}

/** 单个项目的持久化数据 */
interface ProjectStore {
  tasks: Record<string, TaskConfig>;
  /** 已勾选「启用」的触发任务 key（module::Class），重开面板 / IDE 自动入列 */
  enabledTriggers?: string[];
}

/** 所有任务配置的持久化结构 */
interface TaskConfigStore {
  projects: Record<string, ProjectStore>;
}

/** schema 采集结果（刷新时全量 import 项目任务后落盘缓存） */
interface SchemaProbeResult {
  ok: boolean;
  error?: string;
  schemas?: Record<string, TaskSchema>;
  /** 参与采集的任务总数 */
  total?: number;
}

/** 常驻执行器回推的状态快照（对应 run_executor.py 的 OK_TOOLKIT_STATE 标记行） */
interface ExecutorSnapshot {
  paused?: boolean;
  /** 当前正在执行的任务 key（module::Class），空闲时为 null */
  current?: string | null;
  currentIsTrigger?: boolean;
  /** 执行器侧的触发任务启用状态（权威值，宿主据此回写勾选集合） */
  triggers?: { key?: string; enabled?: boolean }[];
  /** 一次性任务等待队列 */
  onetimeQueue?: string[];
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
      ...(parsed.onetime || []).map((t: any) => ({ ...t, kind: 'onetime' })),
      ...(parsed.trigger || []).map((t: any) => ({ ...t, kind: 'trigger' })),
    ].map((t: any) => ({
      module: t.module,
      className: t['class'] || t.class,
      displayName: t.name || t['class'] || t.module,
      kind: t.kind === 'trigger' ? 'trigger' : 'onetime',
    }));
    return { ok: true, tasks, configModule };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 常驻执行器命令行：单一进程连接游戏并轮询全部已启用的触发任务。
 *
 * 与旧 run_task.py 的差异见 python/run_executor.py 顶部说明——旧路径走
 * `ok.run_task(config, task=<单个任务>)`，框架会把 executor.trigger_tasks 收窄成
 * 单个任务并 disable 其余触发任务，因此无法多触发任务串连轮询。
 */
function buildExecutorCommand(extensionUri: vscode.Uri, configModule: string): string[] {
  return [
    pythonScript(extensionUri, 'run_executor.py'),
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
  // 项目根解析统一走 projectConfig.resolveProjectDir()。这里原先是本文件与
  // screenshotCapture.ts 各复制一份同样的逻辑，两处容易漂移成"界面与脚本看的不是
  // 同一目录"。fromConfig 表示"来自显式设置"而不是自动探测到的。
  const projectDir = resolveProjectDir();
  const fromConfig = (cfg.get<string>('okScriptProjectPath') || '').trim().length > 0;

  const python = cfg.get<string>('okScriptPython') || '';
  let pythonPath = python;
  if (!pythonPath) {
    const venvPy = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
    pythonPath = fs.existsSync(venvPy) ? venvPy : 'python';
  }
  return { projectDir, pythonPath, fromConfig };
}

/** 强制结束执行器进程的超时（秒）：收到 stop 后仍未退出则 taskkill 兜底 */
const FORCE_KILL_DELAY_MS = 12000;

/** 参数覆盖推送防抖（毫秒）：表单自动保存很频繁，合并后再推给执行器 */
const PARAMS_PUSH_DEBOUNCE_MS = 400;

/**
 * 侧边栏任务启动视图。
 *
 * 进程模型：整个项目只维持 **一个常驻执行器进程**（python/run_executor.py）——
 * 它连接一次游戏，然后按 ok-script 框架原生的 TaskExecutor 循环轮询所有已启用的
 * 触发任务；一次性任务以入队方式交给同一个执行器跑一次。
 * 因此本类不再有「当前任务 / 单进程」语义，改为维护执行器会话与启用集合。
 */
export class TaskLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.taskLauncher';

  /** 当前活跃实例：工具箱经此向运行中的任务转发浮层开关命令 */
  static current: TaskLauncherViewProvider | undefined;

  private readonly output: vscode.OutputChannel;
  private configModule = 'src.config';
  private view: vscode.WebviewView | null = null;
  private currentProjectDir = '';
  private refreshGeneration = 0;
  /** 每任务独立配置（内存缓存 + 持久化到 .vscode/ok-script-toolkit-tasks.json） */
  private taskConfigs: Record<string, TaskConfig> = {};
  private knownTasks: TaskInfo[] = [];
  /** 采集到的任务参数 schema（缓存到 .vscode/ok-script-toolkit-schema.json） */
  private schemas: Record<string, TaskSchema> = {};

  // ── 执行器会话 ───────────────────────────────────────────────────────
  /** 常驻执行器子进程；null 表示执行器未启动 */
  private executor: cp.ChildProcess | null = null;
  /** 已发出启动命令、尚未收到 OK_TOOLKIT_EXECUTOR_READY */
  private connecting = false;
  /** 执行器回推的最新状态快照 */
  private snapshot: ExecutorSnapshot = {};
  /** 已勾选「启用」的触发任务 key；执行器启动时作为 OK_TOOLKIT_TRIGGERS 传入 */
  private enabledTriggers = new Set<string>();
  /** 调试浮层当前是否生效（启动沿用工具箱状态，运行中经 overlay_* 标记同步） */
  private overlayActive = false;
  /** stdout 按行扫描的未完结残留（标记行可能跨 chunk 到达） */
  private stdoutRemainder = '';
  /** stop 之后的强制结束兜底定时器 */
  private forceKillTimer: NodeJS.Timeout | undefined;
  /** 参数覆盖推送防抖定时器 */
  private paramsTimer: NodeJS.Timeout | undefined;

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
          // webview 重建后同步执行器状态，避免切换侧边栏再回来时状态丢失
          this.pushExecutorState(view);
          break;
        case 'refresh':
          await this.refreshTasks(view);
          break;
        case 'triggerSet':
          if (this.isKnownTask(msg.task)) await this.setTriggerEnabled(view, msg.task, msg.enabled === true);
          break;
        case 'enqueue':
          if (this.isKnownTask(msg.task)) await this.enqueueOnetime(view, msg.task);
          break;
        case 'startExecutor':
          await this.startExecutor(view);
          break;
        case 'pause':
          this.writeCommand('pause');
          break;
        case 'resume':
          this.writeCommand('resume');
          break;
        case 'stopCurrent':
          this.writeCommand('task_disable');
          break;
        case 'stopExecutor':
          this.stopExecutor();
          break;
        case 'saveConfig':
          if (this.isKnownTask(msg.task)) this.saveTaskConfig(msg.task, this.sanitizeTaskConfig(msg.task, msg.config));
          break;
        case 'loadConfigs':
          this.loadTaskConfigs();
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
    const existing = this.taskConfigs[this.taskKey(task)] || {};
    if (!value || typeof value !== 'object') return {};
    const raw = value as Record<string, unknown>;
    const config: TaskConfig = {};
    if (typeof raw.extraArgs === 'string' && raw.extraArgs.trim()) config.extraArgs = raw.extraArgs.trim();
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
    // 历史字段（extraArgs/env）即使 UI 不再提交也保留，避免自动保存把旧数据清掉
    if (!config.extraArgs && existing.extraArgs) config.extraArgs = existing.extraArgs;
    if (!config.env && existing.env) config.env = existing.env;
    return config;
  }

  /** .vscode 目录下 ok-script-toolkit 数据文件的绝对路径 */
  private dataFile(name: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.join(root, '.vscode', name);
  }

  /** 读取 .vscode/ok-script-toolkit-tasks.json（每任务配置 + 触发任务启用集合） */
  private loadTaskConfigs(projectDir = this.currentProjectDir): void {
    try {
      const p = this.dataFile('ok-script-toolkit-tasks.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskConfigStore> & {
          tasks?: Record<string, TaskConfig>;
          enabledTriggers?: string[];
        };
        // 兼容旧版顶层 tasks 格式；保存后自动迁移为按项目隔离的 projects。
        const entry = raw.projects?.[projectDir];
        this.taskConfigs = entry?.tasks || raw.tasks || {};
        const triggers = entry?.enabledTriggers || raw.enabledTriggers || [];
        this.enabledTriggers = new Set(triggers.filter((key) => typeof key === 'string'));
      } else {
        this.taskConfigs = {};
        this.enabledTriggers = new Set();
      }
    } catch (e) {
      this.taskConfigs = {};
      this.enabledTriggers = new Set();
      void vscode.window.showWarningMessage(tr('Failed to read task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    if (this.view) {
      void this.view.webview.postMessage({ type: 'taskConfigs', configs: this.taskConfigs });
    }
  }

  /** 保存单个任务的配置（内存更新 + 落盘 + 推送参数覆盖给运行中的执行器） */
  private saveTaskConfig(task: TaskInfo, config: TaskConfig): void {
    this.taskConfigs = { ...this.taskConfigs, [this.taskKey(task)]: config };
    if (!this.saveStore()) return;
    // 执行器是常驻进程，参数覆盖必须即时推送才能生效（否则要重启执行器）
    this.scheduleParamsPush();
  }

  /** 把任务配置与启用集合写回 .vscode/ok-script-toolkit-tasks.json */
  private saveStore(): boolean {
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
      const existing = store.projects[this.currentProjectDir] || { tasks: {} };
      store.projects[this.currentProjectDir] = {
        ...existing,
        tasks: this.taskConfigs,
        enabledTriggers: [...this.enabledTriggers],
      };
      fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
      return true;
    } catch (e) {
      const message = tr('Failed to save task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      });
      void vscode.window.showErrorMessage(message);
      this.view?.webview.postMessage({ type: 'status', level: 'error', text: message });
      return false;
    }
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
      kind: task.kind || this.schemas[this.taskKey(task)]?.kind,
    }));
    this.knownTasks = tasks;
    await view.webview.postMessage({ type: 'tasks', tasks, schemas: this.schemas });
    this.pushExecutorState(view);
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
    if (!this.executor) {
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

  // ── 执行器生命周期 ───────────────────────────────────────────────────

  /**
   * 勾选 / 取消勾选触发任务：更新持久化集合，执行器运行中则即时入列 / 出列。
   *
   * 注意这里**不会**拉起执行器 —— 勾选只是「记录我要跑哪些触发任务」的意图，
   * 不等于「现在开始跑」。想真正启动请点工具栏的启动按钮（`startExecutor`）。
   * 执行器已在运行时勾选依然即时生效。
   */
  private async setTriggerEnabled(view: vscode.WebviewView, task: TaskInfo, enabled: boolean): Promise<void> {
    const key = this.taskKey(task);
    if (enabled) this.enabledTriggers.add(key);
    else this.enabledTriggers.delete(key);
    this.saveStore();
    this.pushExecutorState(view);
    // 执行器没起过：只记状态，等显式启动时按集合入列
    if (!this.executor) return;
    this.writeCommand(enabled ? `trigger_enable ${key}` : `trigger_disable ${key}`);
  }

  /** 显式启动执行器（工具栏按钮）：环境不满足时会在 UI 提示 */
  private async startExecutor(view: vscode.WebviewView): Promise<void> {
    if (!(await this.ensureExecutor(view))) return;
    this.pushExecutorState(view);
  }

  /** 一次性任务入队：由常驻执行器执行一次后自动出队 */
  private async enqueueOnetime(view: vscode.WebviewView, task: TaskInfo): Promise<void> {
    if (!(await this.ensureExecutor(view))) return;
    this.writeCommand(`onetime_enqueue ${this.taskKey(task)}`);
  }

  /** 确保执行器已启动；返回 false 表示环境不满足（已在 UI 提示） */
  private async ensureExecutor(view: vscode.WebviewView): Promise<boolean> {
    if (this.executor) return true;
    const { projectDir, pythonPath } = this.getConfig();
    if (!projectDir) {
      void vscode.window.showErrorMessage(tr('The ok-script project path is not configured.'));
      return false;
    }
    if (!fs.existsSync(projectDir)) {
      void vscode.window.showErrorMessage(tr('Project directory does not exist: {path}', { path: projectDir }));
      return false;
    }
    if (!fs.existsSync(pythonPath) && pythonPath !== 'python') {
      void vscode.window.showErrorMessage(tr('Python interpreter does not exist: {path}', { path: pythonPath }));
      return false;
    }

    this.currentProjectDir = projectDir;
    this.output.clear();
    this.output.appendLine(tr('▶ Starting executor · project: {path}', { path: projectDir }));
    this.output.appendLine(tr('Python: {path}', { path: pythonPath }));
    const overrides = this.collectOverrides();
    const overrideCount = Object.keys(overrides).length;
    if (overrideCount) this.output.appendLine(tr('Parameter overrides: {count}', { count: overrideCount }));
    this.warnLegacyPerTaskSettings();
    this.output.show(true);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      // 触发任务启用集合：执行器以它为准，项目 configs 里残留的 _enabled 会被覆盖
      OK_TOOLKIT_TRIGGERS: JSON.stringify([...this.enabledTriggers]),
      // 配置沙箱：执行器把 ok 框架的配置/截图读写全部改道到这里，绝不碰项目 configs/。
      // 放在 .vscode 下是因为它已被项目 .gitignore 忽略，且插件自身数据也在此处。
      OK_TOOLKIT_RUN_DIR: path.join(projectDir, '.vscode', 'ok-script-toolkit'),
    };
    // 参数注入通过环境变量传递（避免命令行长度/转义问题）；key 是 module::Class，
    // 执行器按任务各自取自己的覆盖，因此可以整体合并后一次性传入。
    if (overrideCount) childEnv.OK_LANG_HINTS_INJECT = JSON.stringify(overrides);
    // 工具箱共享配置：执行器启动无感沿用调试浮层开关与游戏连接
    const toolbox = loadToolboxState(projectDir);
    this.overlayActive = toolbox.overlay === true;
    if (this.overlayActive) {
      childEnv.OK_TOOLKIT_USE_OVERLAY = '1';
      this.output.appendLine(tr('▶ Debug overlay: enabled'));
    }
    if (toolbox.game) {
      // 实际复用由 connect_game.py 写入的 configs/devices.json selected_hwnd 驱动，
      // 这里仅记录连接来源，便于确认执行器与工具箱操作的是同一个窗口。
      this.output.appendLine(tr('Reusing game connection from toolbox: {title} (PID {pid})', {
        title: toolbox.game.title || String(toolbox.game.hwnd),
        pid: toolbox.game.pid,
      }));
    }

    this.connecting = true;
    this.stdoutRemainder = '';
    this.snapshot = {};
    const child = cp.spawn(pythonPath, buildExecutorCommand(this.extensionUri, this.configModule), {
      cwd: projectDir,
      windowsHide: true,
      // 强制子进程以 UTF-8 编码输出，与 Python 端 reconfigure 配合彻底解决乱码
      env: childEnv,
    });
    this.executor = child;
    // 浮层互斥：执行器进程自己持有 Win32GdiOverlay，通知工具箱停掉独立浮层宿主
    notifyExecutorRunning(true, projectDir);
    // 子进程退出瞬间向 stdin 写入会以 error 事件异步报错（EPIPE），
    // 不挂监听会变成扩展宿主未捕获异常
    child.stdin?.on('error', () => { /* 忽略 EPIPE */ });
    child.stdout?.on('data', (d) => {
      const text = d.toString('utf8');
      this.scanControlMarkers(text);
      this.output.append(text);
    });
    child.stderr?.on('data', (d) => this.output.append(d.toString('utf8')));
    child.on('error', (err) => {
      this.output.appendLine('');
      this.output.appendLine(tr('❌ Failed to start Python process: {error}', { error: err.message }));
      void vscode.window.showErrorMessage(tr('Failed to launch task: {error}', { error: err.message }));
      this.resetExecutorState();
      this.setStatus('error', tr('Failed to launch task: {error}', { error: err.message }));
    });
    child.on('close', (code) => {
      const wasStopping = this.forceKillTimer !== undefined;
      this.resetExecutorState();
      this.output.appendLine('');
      this.output.appendLine(code === 0
        ? tr('✅ Executor closed')
        : tr('❌ Executor exit code: {code}', { code: code ?? 'null' }));
      this.setStatus(code === 0 ? 'ok' : 'error', code === 0
        ? tr('✅ Executor closed')
        : tr('❌ Executor exit code: {code}', { code: code ?? 'null' }));
      if (!wasStopping && code !== 0) {
        void vscode.window.showErrorMessage(tr('❌ Executor exit code: {code}', { code: code ?? 'null' }));
      }
    });
    this.pushExecutorState(view);
    return true;
  }

  /** 收集全部任务的参数覆盖：{module::Class: {key: value}} */
  private collectOverrides(): Record<string, Record<string, unknown>> {
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const [key, config] of Object.entries(this.taskConfigs)) {
      if (config?.params && Object.keys(config.params).length) overrides[key] = config.params;
    }
    return overrides;
  }

  /** 参数覆盖防抖推送：常驻执行器里改参数要即时生效 */
  private scheduleParamsPush(): void {
    if (!this.executor) return;
    if (this.paramsTimer) clearTimeout(this.paramsTimer);
    this.paramsTimer = setTimeout(() => {
      this.paramsTimer = undefined;
      if (!this.executor) return;
      this.writeCommand(`params ${JSON.stringify(this.collectOverrides())}`);
    }, PARAMS_PUSH_DEBOUNCE_MS);
  }

  /** 历史配置里的 extraArgs / env 在单进程模型下无法按任务生效，启动时提示一次 */
  private warnLegacyPerTaskSettings(): void {
    const affected = Object.values(this.taskConfigs)
      .filter((config) => config?.extraArgs || (config?.env && Object.keys(config.env).length))
      .length;
    if (!affected) return;
    this.output.appendLine(tr(
      'Extra arguments or environment variables are configured for {count} task(s); the executor runs every task in one process, so they no longer apply.',
      { count: affected },
    ));
  }

  /** 关闭执行器：先请它自己退出，超时再强杀进程树 */
  private stopExecutor(): void {
    if (!this.executor) {
      void vscode.window.showWarningMessage(tr('The executor is not running.'));
      return;
    }
    this.output.appendLine('');
    this.output.appendLine(tr('⏹ Stopping executor...'));
    if (!this.writeCommand('stop')) {
      void this.forceKillExecutor();
      return;
    }
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = undefined;
      if (this.executor) void this.forceKillExecutor();
    }, FORCE_KILL_DELAY_MS);
  }

  /** 强制结束执行器进程树（Windows 用 taskkill /T） */
  private async forceKillExecutor(): Promise<void> {
    const child = this.executor;
    if (!child) return;
    try {
      if (process.platform === 'win32') {
        const pid = child.pid;
        if (!pid) throw new Error(tr('Unable to get the process PID'));
        await new Promise<void>((resolve, reject) => {
          const taskkill = cp.spawn('taskkill', ['/F', '/T', '/PID', pid.toString()], {
            windowsHide: true,
            env: process.env,
          });
          let stderr = '';
          taskkill.stderr?.on('data', (d) => { stderr += d.toString(); });
          taskkill.on('error', reject);
          taskkill.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || tr('taskkill exit code {code}', { code: code ?? 'null' })));
          });
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.output.appendLine(tr('❌ Failed to stop executor: {error}', { error }));
      void vscode.window.showErrorMessage(tr('❌ Failed to stop executor: {error}', { error }));
    }
  }

  /** 清空执行器会话状态（进程已结束或启动失败） */
  private resetExecutorState(): void {
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = undefined;
    }
    if (this.paramsTimer) {
      clearTimeout(this.paramsTimer);
      this.paramsTimer = undefined;
    }
    this.executor = null;
    this.connecting = false;
    this.snapshot = {};
    this.stdoutRemainder = '';
    this.overlayActive = false;
    // 浮层互斥：执行器退出后把独立浮层宿主交还给工具箱（error / close 都会走到这里，
    // notifyExecutorRunning 内部会去重）
    notifyExecutorRunning(false, this.currentProjectDir);
    this.pushExecutorState();
  }

  /** 向执行器 stdin 写入命令（run_executor.py 按行读取） */
  private writeCommand(command: string): boolean {
    const stdin = this.executor?.stdin;
    if (!stdin || !stdin.writable) {
      void vscode.window.showWarningMessage(tr('The executor is not running.'));
      return false;
    }
    try {
      stdin.write(`${command}\n`);
      return true;
    } catch (err) {
      const message = tr('Failed to send command to the task process: {error}', {
        error: err instanceof Error ? err.message : String(err),
      });
      void vscode.window.showErrorMessage(message);
      this.output.appendLine(message);
      return false;
    }
  }

  /** 把执行器状态推给 webview */
  private pushExecutorState(view?: vscode.WebviewView): void {
    const target = view ?? this.view;
    if (!target) return;
    void target.webview.postMessage({
      type: 'executor',
      status: this.executor ? (this.connecting ? 'connecting' : 'running') : 'idle',
      paused: this.snapshot.paused === true,
      current: this.snapshot.current || '',
      currentIsTrigger: this.snapshot.currentIsTrigger === true,
      onetimeQueue: this.snapshot.onetimeQueue || [],
      enabledTriggers: [...this.enabledTriggers],
    });
  }

  private setStatus(level: 'ok' | 'warn' | 'error', text: string): void {
    void this.view?.webview.postMessage({ type: 'status', level, text });
  }

  /**
   * 工具箱浮层开关 → 运行中执行器即时生效（stdin overlay_on/off 命令）。
   * 无运行执行器时返回 false，开关状态由工具箱直接持久化、下次启动沿用。
   */
  setOverlayEnabled(enabled: boolean): boolean {
    if (!this.executor) return false;
    this.output.appendLine(enabled ? tr('▶ Enabling debug overlay…') : tr('⏹ Disabling debug overlay…'));
    return this.writeCommand(enabled ? 'overlay_on' : 'overlay_off');
  }

  /** 按行扫描 stdout，识别 run_executor.py 输出的控制标记（标记行可能跨 chunk 到达） */
  private scanControlMarkers(text: string): void {
    const combined = this.stdoutRemainder + text;
    const lines = combined.split(/\r?\n/);
    this.stdoutRemainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.includes('OK_TOOLKIT_STATE:')) {
        this.applySnapshot(line.slice(line.indexOf('OK_TOOLKIT_STATE:') + 'OK_TOOLKIT_STATE:'.length).trim());
      } else if (line.includes('OK_TOOLKIT_EXECUTOR_READY')) {
        this.connecting = false;
        this.output.appendLine(tr('Executor ready · {count} trigger task(s) enabled', {
          count: this.enabledTriggers.size,
        }));
        this.pushExecutorState();
      } else if (line.includes('OK_TOOLKIT_PAUSED')) {
        this.setPaused(true);
      } else if (line.includes('OK_TOOLKIT_RESUMED')) {
        this.setPaused(false);
      } else if (line.includes('OK_TOOLKIT_OVERLAY_ON')) {
        this.setOverlayActive(true);
      } else if (line.includes('OK_TOOLKIT_OVERLAY_OFF')) {
        this.setOverlayActive(false);
      } else if (line.includes('OK_TOOLKIT_ERROR:')) {
        const error = line.slice(line.indexOf('OK_TOOLKIT_ERROR:') + 'OK_TOOLKIT_ERROR:'.length).trim();
        if (error) this.setStatus('error', tr('Task control command failed: {error}', { error }));
      }
    }
  }

  /**
   * 应用执行器状态快照。
   * 执行器侧的触发任务启用状态是权威值（用户在执行器里停掉某任务也会反映到这里），
   * 因此把勾选集合与它对齐后再推给 UI。
   */
  private applySnapshot(payload: string): void {
    if (!payload) return;
    let parsed: ExecutorSnapshot;
    try {
      parsed = JSON.parse(payload) as ExecutorSnapshot;
    } catch {
      return;
    }
    this.snapshot = parsed;
    let changed = false;
    for (const item of parsed.triggers || []) {
      const key = item?.key;
      if (typeof key !== 'string' || !key) continue;
      const enabled = item.enabled === true;
      if (enabled === this.enabledTriggers.has(key)) continue;
      if (enabled) this.enabledTriggers.add(key);
      else this.enabledTriggers.delete(key);
      changed = true;
    }
    if (changed) this.saveStore();
    this.pushExecutorState();
  }

  /** 暂停状态以执行器确认标记为准；翻转时同步日志与 webview */
  private setPaused(paused: boolean): void {
    if (this.snapshot.paused === paused) return;
    this.snapshot = { ...this.snapshot, paused };
    this.output.appendLine(paused ? tr('⏸ Task paused') : tr('▶ Task resumed'));
    this.pushExecutorState();
  }

  /** 调试浮层以执行器确认标记为准；翻转时同步日志并回写工具箱共享状态 */
  private setOverlayActive(active: boolean): void {
    if (this.overlayActive === active) return;
    this.overlayActive = active;
    this.output.appendLine(active ? tr('▶ Debug overlay: enabled') : tr('⏹ Debug overlay: disabled'));
    if (this.currentProjectDir) {
      saveToolboxState(this.currentProjectDir, { overlay: active });
    }
  }

  private taskKey(task: TaskInfo): string {
    return `${task.module}::${task.className}`;
  }

  /** 释放资源（output channel 由扩展生命周期统一关闭） */
  dispose(): void {
    if (TaskLauncherViewProvider.current === this) TaskLauncherViewProvider.current = undefined;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    if (this.paramsTimer) clearTimeout(this.paramsTimer);
    if (this.executor) {
      this.executor.kill();
      this.executor = null;
    }
    this.output.dispose();
  }

  /** 读取任务启动器 Webview 外壳并注入 CSP 与本地资源 URI。 */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'taskLauncher', 'index.html');
    let html = '';
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch (e) {
      // 错误消息里会带文件路径，路径可合法包含 < > & " —— 必须转义后再拼进 HTML
      return errorPage(
        tr('Error'),
        tr('Unable to read view file: {error}', { error: e instanceof Error ? e.message : String(e) }),
      );
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
