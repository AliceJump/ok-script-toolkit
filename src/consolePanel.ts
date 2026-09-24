import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { injectWebviewLocalization, projectLocale, tr } from './localization';
import { i18nPoDirectorySetting, resolveProjectDir } from './projectConfig';
import { loadToolboxState, notifyExecutorRunning, onToolboxStateChange, saveToolboxState } from './toolboxState';
import { GameConnectService } from './toolboxConnect';
import { applySharedAssets, errorPage, getNonce } from './webviewHtml';

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
  /** 任务分组（BaseTask.group_name，源文案 key 走 tr）；空串 = standalone */
  groupName?: string;
  /** 组图标名（FluentIcon/Icon 的 enum name） */
  groupIcon?: string;
  /** 任务侧声明不进任务列表（框架原生不消费，ok-nte patch 语义） */
  showInTaskTab?: boolean;
  /** 项目声明的配置分组/子任务树：组名 -> 字段或子组 key。 */
  configGroups?: Record<string, string[]>;
  groupLabels?: Record<string, string>;
  /** register_config_groups 生成的分组下拉字段。 */
  groupSelector?: string;
  locale?: string;
}

/** 全局配置组（框架 GlobalConfig 可见组，probe 的 globalConfigGroups 段） */
interface GlobalConfigGroup {
  name: string;
  displayName?: string;
  description?: string;
  fields: TaskParamField[];
  /** 来源：framework = 框架 GlobalConfig；project_store = 项目自建 store（Phase 5） */
  source?: 'framework' | 'project_store';
}

/** 每个任务的独立配置（持久化到 .vscode/ok-script-toolkit-tasks.json）。
 *
 * params 在「配置接管」模式下是**全量快照**：schema 的每个键都有值（首建继承项目
 * configs 当前值，之后独立演化），执行器按它全量注入 —— UI 显示 = 实际执行。
 * extraArgs / env 是历史字段：常驻执行器把全部任务跑在同一个进程里，进程级参数
 * 无法再按任务区分，因此不再生效（仅保留数据，不做删除）。UI 早已移除这两项。
 */
interface TaskConfig {
  extraArgs?: string;
  env?: Record<string, string>;
  /** 任务参数快照：key=任务 default_config 的 key（含孤儿键），value=快照值 */
  params?: Record<string, unknown>;
}

/** 单个项目的持久化数据 */
interface ProjectStore {
  tasks: Record<string, TaskConfig>;
  /** 已勾选「启用」的触发任务 key（module::Class），重开面板 / IDE 自动入列 */
  enabledTriggers?: string[];
  /** 全局配置组快照：组名 -> {key: value}（配置接管模式的持久值） */
  globalConfigs?: Record<string, Record<string, unknown>>;
  /** 用户展开过的全局配置组（默认收起；重开面板按上次状态） */
  expandedGlobalGroups?: string[];
  /** webview UI 折叠状态（键 -> 值）：启动设置区、配置分组、卡片等，重开面板复用 */
  uiState?: Record<string, unknown>;
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
  /** 全局配置组（框架 GlobalConfig 可见组） */
  globalConfigGroups?: GlobalConfigGroup[];
  /** 项目自建全局配置 store 的组（约定接口：global_config_store.get_all_visible_configs） */
  projectGlobalGroups?: GlobalConfigGroup[];
  /** 多账户存储只读概要（configs/account_scoped_overrides.json） */
  multiAccount?: MultiAccountInfo;
}

/** 多账户存储只读概要（Phase 6 只读呈现，不做编辑器） */
interface MultiAccountInfo {
  available: boolean;
  storePath?: string;
  readable?: boolean;
  hasStoreModule?: boolean;
  accountCount?: number;
  overrideAccounts?: number;
  overriddenTasks?: string[];
  /** 可进多账户的任务：taskKey -> {storageName, keys}（键筛选数据源） */
  enabledTasks?: Record<string, { storageName: string; keys: string[] }>;
}

/** 多账户存储数据（python/account_store.py get 的结果，编辑器数据源） */
interface AccountStoreData {
  /** 账号列表原文（每行一个账号名） */
  accountListText?: string;
  /** 注册表：acc_id -> {username, aliases} */
  registry?: Record<string, { username?: string; aliases?: string[] }>;
  /** 覆盖表：acc_id -> {任务类名(或全局组名): {键: 值}} */
  accounts?: Record<string, Record<string, Record<string, unknown>>>;
  /** 每账号的地图 content（acc_id -> 文本） */
  mapContents?: Record<string, string>;
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

/** JSON-compatible config values use deep value equality; primitives retain strict comparison. */
export function configValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!configValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && configValuesEqual(leftRecord[key], rightRecord[key]));
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
    return {
      ok: true,
      schemas: parsed.schemas,
      total: parsed.total,
      globalConfigGroups: parsed.globalConfigGroups || [],
      projectGlobalGroups: parsed.projectGlobalGroups || [],
      multiAccount: parsed.multiAccount || { available: false },
    };
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
 * 侧边栏「ok-script 控制台」视图 —— 任务启动器 + 游戏工具箱的统一宿主。
 *
 * 布局（media/console/）：顶部全局状态条（游戏连接 + 执行器），下方「任务 / 游戏」
 * 两个分段。原侧边栏工具箱视图（okScriptToolkit.toolbox）已并入这里。
 *
 * 进程模型：整个项目只维持 **一个常驻执行器进程**（python/run_executor.py）——
 * 它连接一次游戏，然后按 ok-script 框架原生的 TaskExecutor 循环轮询所有已启用的
 * 触发任务；一次性任务以入队方式交给同一个执行器跑一次。
 * 因此本类不再有「当前任务 / 单进程」语义，改为维护执行器会话与启用集合。
 */
export class ConsoleViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.console';

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
  /** 全局配置组（probe 的 globalConfigGroups 段，缓存随 schema 落盘） */
  private globalGroups: GlobalConfigGroup[] = [];
  /** 全局配置组快照（持久化到 tasks.json 的 globalConfigs 段；执行器按它注入） */
  private globalSnapshots: Record<string, Record<string, unknown>> = {};
  /** 多账户存储只读概要（probe 探测 configs/account_scoped_overrides.json） */
  private multiAccount: MultiAccountInfo = { available: false };
  /** 多账户存储数据（经 python/account_store.py 读写，含账号列表文本与覆盖表） */
  private accountStoreData: AccountStoreData | null = null;
  /** 用户展开过的全局配置组（持久化；不在集合内 = 收起） */
  private expandedGlobalGroups = new Set<string>();
  /** webview UI 折叠状态（键 -> 值），落盘项目存储供重开面板复用 */
  private uiState: Record<string, unknown> = {};
  /** 全局配置组推送防抖定时器 */
  private gparamsTimer: NodeJS.Timeout | undefined;

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
  /** 工具箱状态变化订阅（webview 打开期间把游戏/浮层状态镜像给 UI） */
  private toolboxSubscription?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gameConnect: GameConnectService,
    /** 「打开角色技能管理面板」按钮的回调（extension 注入，避免反向依赖 characterPanel） */
    private readonly openCharacterManager?: () => void,
  ) {
    this.output = vscode.window.createOutputChannel(tr('ok-script Console'));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media', 'console'),
        vscode.Uri.joinPath(this.extensionUri, 'media', 'shared'),
      ],
    };
    view.webview.html = this.buildHtml(view.webview);

    // 游戏连接/浮层状态变化 → 镜像给 webview；宿主状态行文本 → 走统一 status 通道
    this.gameConnect.attachUi(
      (text) => this.setStatus(text ? 'info' : 'ok', text),
      () => this.pushGameState(),
    );
    this.toolboxSubscription?.dispose();
    this.toolboxSubscription = onToolboxStateChange(() => this.pushGameState());
    view.onDidDispose(() => {
      this.gameConnect.detachUi();
      this.toolboxSubscription?.dispose();
      this.toolboxSubscription = undefined;
      if (this.view === view) this.view = null;
    });

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.refreshTasks(view);
          // webview 重建后同步执行器状态，避免切换侧边栏再回来时状态丢失
          this.pushExecutorState(view);
          this.pushGameState();
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
          // 全局配置编辑器：伪 task module = __global__，className = 全局组名
          if (msg.task?.module === '__global__') {
            const group = String(msg.task.className || '');
            const rawParams = msg.config?.params;
            const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
              ? rawParams as Record<string, unknown>
              : {};
            for (const [key, value] of Object.entries(params)) this.setGlobalValue(group, key, value);
            break;
          }
          // 账号覆盖编辑器：伪 task module = __account__::<账号名>，className = 任务类名
          if (typeof msg.task?.module === 'string' && msg.task.module.startsWith('__account__::')) {
            const account = msg.task.module.slice('__account__::'.length);
            const cfgObj = (msg.config && typeof msg.config === 'object')
              ? msg.config as { params?: Record<string, unknown> }
              : undefined;
            this.saveAccountOverride(account, String(msg.task.className || ''), cfgObj?.params || {});
            break;
          }
          if (this.isKnownTask(msg.task)) this.saveTaskConfig(msg.task, this.sanitizeTaskConfig(msg.task, msg.config));
          break;
        case 'saveAccountList':
          if (typeof msg.text === 'string') this.runAccountStore(['set_list', '--text', JSON.stringify(msg.text)]);
          break;
        case 'clearAccountOverride':
          if (msg.account && msg.taskName) {
            this.runAccountStore(['clear_override', '--account', String(msg.account), '--task', String(msg.taskName)]);
          }
          break;
        case 'saveAccountMap':
          // 每账号的地图 content（滑索/地图数据），经项目 store 的原子写落盘
          if (msg.account && typeof msg.content === 'string') {
            this.runAccountStore(['set_map', '--account', String(msg.account), '--content', JSON.stringify(msg.content)]);
          }
          break;
        case 'loadConfigs':
          this.loadTaskConfigs();
          break;
        // ── 配置接管（快照同步/恢复 + 全局组编辑）──
        case 'setGlobalValue':
          this.setGlobalValue(String(msg.group || ''), String(msg.key || ''), msg.value);
          break;
        case 'toggleGlobalGroup':
          this.setGlobalGroupExpanded(String(msg.name || ''), msg.expanded === true);
          break;
        case 'saveUiState':
          // webview 折叠状态（启动设置区/配置分组/卡片）落盘，重开面板复用
          if (typeof msg.key === 'string' && msg.key && msg.key.length <= 200) {
            this.uiState = { ...this.uiState, [msg.key]: msg.value };
            this.saveStore();
          }
          break;
        case 'syncDefault':
          {
            const added = this.syncDefaultToSnapshot(String(msg.target || ''), String(msg.name || ''));
            void view.webview.postMessage({
              type: 'status',
              level: 'ok',
              text: added > 0
                ? tr('Synced default_config: {count} key(s) added', { count: added })
                : tr('Snapshot already covers every default_config key'),
            });
          }
          break;
        case 'resetDefault':
          {
            const reset = this.resetSnapshotToDefault(String(msg.target || ''), String(msg.name || ''));
            void view.webview.postMessage({
              type: 'status',
              level: 'ok',
              text: reset > 0
                ? tr('Restored factory defaults: {count} key(s)', { count: reset })
                : tr('Snapshot already matches factory defaults'),
            });
          }
          break;
        // ── 游戏分段（原侧边栏工具箱）──
        case 'connectGame':
          await this.gameConnect.connect();
          // 无论成败都通知前端解锁连接按钮（成功时按钮随状态隐藏，失败时保持可重试）
          void view.webview.postMessage({ type: 'connectDone' });
          break;
        case 'disconnectGame':
          await this.gameConnect.disconnect();
          break;
        case 'setOverlay':
          this.gameConnect.setOverlay(msg.enabled === true);
          break;
        case 'openCharacterManager':
          this.openCharacterManager?.();
          break;
        case 'openPath':
          // 多账户存储等数据文件的「打开位置」：交给操作系统文件管理器定位
          if (typeof msg.path === 'string' && msg.path) {
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
          }
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
        // 配置接管：schema 未列出的键是孤儿键（default 已删），从既有快照原样保留——
        // 决议 1「永不删键」：键回归时设置自动复活
        for (const [key, item] of Object.entries(existing.params || {})) {
          if (!allowed.has(key) && !(key in params)) params[key] = item;
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
        this.globalSnapshots = entry?.globalConfigs || {};
        const expanded = entry?.expandedGlobalGroups || [];
        this.expandedGlobalGroups = new Set(expanded.filter((key) => typeof key === 'string'));
        this.uiState = entry?.uiState && typeof entry.uiState === 'object' ? { ...entry.uiState } : {};
      } else {
        this.taskConfigs = {};
        this.enabledTriggers = new Set();
        this.globalSnapshots = {};
        this.expandedGlobalGroups = new Set();
        this.uiState = {};
      }
    } catch (e) {
      this.taskConfigs = {};
      this.enabledTriggers = new Set();
      this.globalSnapshots = {};
      this.expandedGlobalGroups = new Set();
      this.uiState = {};
      void vscode.window.showWarningMessage(tr('Failed to read task configuration: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    if (this.view) {
      void this.view.webview.postMessage({ type: 'taskConfigs', configs: this.taskConfigs, uiState: this.uiState });
    }
  }

  /** 保存单个任务的配置（内存更新 + 落盘 + 推送参数覆盖给运行中的执行器） */
  private saveTaskConfig(task: TaskInfo, config: TaskConfig): void {
    this.taskConfigs = { ...this.taskConfigs, [this.taskKey(task)]: config };
    if (!this.saveStore()) return;
    // 执行器是常驻进程，参数覆盖必须即时推送才能生效（否则要重启执行器）
    this.scheduleParamsPush();
  }

  // ── 配置接管：快照物化 / 同步 / 恢复默认 ─────────────────────────────
  /**
   * 物化单个任务的快照：params 缺失的 schema 键补齐。
   * - 首建（params 为空）：全键取 schema.value —— 一次性继承项目 configs 当前值（方案 b）
   * - 已有快照：仅补 default_config 新增的键，取 field.default（决议 1：同步以出厂值进入）
   * - params 里 schema 没有的键（孤儿键）原样保留，永不删除
   * 返回补齐的键数。
   */
  private materializeTaskSnapshot(taskKey: string, schema: TaskSchema): number {
    if (schema.broken) return 0;
    const existing = { ...(this.taskConfigs[taskKey]?.params || {}) };
    const isFirst = Object.keys(existing).length === 0;
    let added = 0;
    for (const f of schema.fields) {
      if (f.key in existing) continue;
      existing[f.key] = isFirst
        ? f.value
        : (f.default !== undefined ? f.default : f.value);
      added += 1;
    }
    if (added > 0) {
      this.taskConfigs = {
        ...this.taskConfigs,
        [taskKey]: { ...this.taskConfigs[taskKey], params: existing },
      };
    }
    return added;
  }

  /** 物化全局配置组快照（语义与任务一致：首建继承当前值，新键取 default） */
  private materializeGlobalSnapshot(group: GlobalConfigGroup): number {
    const existing = { ...(this.globalSnapshots[group.name] || {}) };
    const isFirst = Object.keys(existing).length === 0;
    let added = 0;
    for (const f of group.fields) {
      if (f.key in existing) continue;
      existing[f.key] = isFirst
        ? f.value
        : (f.default !== undefined ? f.default : f.value);
      added += 1;
    }
    if (added > 0) {
      this.globalSnapshots = { ...this.globalSnapshots, [group.name]: existing };
    }
    return added;
  }

  /** 物化全部快照（probe 成功 / schema 缓存加载后调用）并落盘，返回新增键总数 */
  private materializeAllSnapshots(): number {
    let added = 0;
    for (const [key, schema] of Object.entries(this.schemas)) {
      added += this.materializeTaskSnapshot(key, schema);
    }
    for (const group of this.globalGroups) {
      added += this.materializeGlobalSnapshot(group);
    }
    if (added > 0) {
      this.saveStore();
      // 物化改变了 params/全局组，让前端表单与注入数据保持最新
      this.view?.webview.postMessage({ type: 'taskConfigs', configs: this.taskConfigs, uiState: this.uiState });
      this.pushGlobalGroups();
    }
    return added;
  }

  /** 把全局配置组与其快照推给前端（配置分段渲染数据源） */
  private pushGlobalGroups(): void {
    this.view?.webview.postMessage({
      type: 'globalGroups',
      groups: this.globalGroups,
      snapshots: this.globalSnapshots,
      expanded: [...this.expandedGlobalGroups],
    });
  }

  /** 展开/收起全局配置组（持久化，重开面板按上次状态） */
  private setGlobalGroupExpanded(name: string, expanded: boolean): void {
    if (!name) return;
    if (expanded) this.expandedGlobalGroups.add(name);
    else this.expandedGlobalGroups.delete(name);
    this.saveStore();
    this.pushGlobalGroups();
  }

  /** 全局组单键写入（配置分段表单「修改即保存」）+ 运行中 gparams 推送 */
  private setGlobalValue(group: string, key: string, value: unknown): void {
    const groupSchema = this.globalGroups.find((item) => item.name === group);
    if (!groupSchema || !groupSchema.fields.some((field) => field.key === key)) return;
    const snap = { ...(this.globalSnapshots[group] || {}), [key]: value };
    this.globalSnapshots = { ...this.globalSnapshots, [group]: snap };
    if (!this.saveStore()) return;
    this.scheduleGParamsPush();
  }

  /** 全局组快照推送防抖（与任务 params 同节奏） */
  private scheduleGParamsPush(): void {
    if (!this.executor) return;
    if (this.gparamsTimer) clearTimeout(this.gparamsTimer);
    this.gparamsTimer = setTimeout(() => {
      this.gparamsTimer = undefined;
      if (!this.executor) return;
      if (!Object.keys(this.globalSnapshots).length) return;
      this.writeCommand(`gparams ${JSON.stringify(this.globalSnapshots)}`);
    }, PARAMS_PUSH_DEBOUNCE_MS);
  }

  // ── 多账户配置编辑（写操作全部经 python/account_store.py 转调项目 store）──

  /**
   * spawn account_store.py：get 读存储并回推前端；写命令成功后自动重读刷新。
   * 用项目 Python 运行（store 依赖 ok 包），写路径复用项目自己的锁/原子写/注册表同步。
   */
  private runAccountStore(command: string[]): void {
    const { projectDir, pythonPath } = this.getConfig();
    if (!projectDir) return;
    // 存储位置与执行器一致：--run-dir 让 account_store.py 把 configs 改道沙箱
    const runDir = path.join(projectDir, '.vscode', 'ok-script-toolkit');
    const child = cp.spawn(
      pythonPath,
      [pythonScript(this.extensionUri, 'account_store.py'), projectDir, ...command, '--run-dir', runDir],
      { cwd: projectDir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
    );
    let stdout = '';
    let launchFailed = false;
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.once('error', (error) => {
      launchFailed = true;
      const message = error.message || String(error);
      this.output.appendLine(`[toolkit] account_store ${command[0]} 启动失败：${message}`);
      this.view?.webview.postMessage({
        type: 'accountStore',
        data: null,
        error: message,
      });
    });
    child.on('close', () => {
      if (launchFailed) return;
      const parsed = parseJsonFromStdout(stdout);
      if (!parsed?.ok) {
        const error = parsed?.error || `exit code ${child.exitCode}`;
        // 错误详情进输出频道（toast 会消失，频道可回看）
        this.output.appendLine(`[toolkit] account_store ${command[0]} 失败：${error}`);
        this.view?.webview.postMessage({
          type: 'accountStore',
          data: null,
          error,
        });
        return;
      }
      if (command[0] === 'get') {
        this.accountStoreData = {
          accountListText: parsed.account_list_text || '',
          registry: parsed.registry || {},
          accounts: parsed.accounts || {},
          mapContents: parsed.map_contents || {},
        };
        this.view?.webview.postMessage({ type: 'accountStore', data: this.accountStoreData });
      } else {
        // 写入成功后重读一次，前端数据保持权威
        this.runAccountStore(['get']);
      }
    });
  }

  /** 保存账号覆盖：account 传账号名（store 自动解析/创建 acc_id），taskName 用任务类名 */
  private saveAccountOverride(account: string, taskClassName: string, params: Record<string, unknown>): void {
    if (!account || !taskClassName) return;
    this.runAccountStore([
      'set_override', '--account', account, '--task', taskClassName,
      '--values', JSON.stringify(params ?? {}),
    ]);
  }

  /**
   * 同步 default_config（决议 1：并集扩张）——补缺键（取出厂值），已有键值不动，孤儿键保留。
   * target='task' 时 name 为任务 key；target='global' 时 name 为组名。返回新增键数。
   */
  private syncDefaultToSnapshot(target: string, name: string): number {
    const fields = target === 'task'
      ? this.schemas[name]?.fields
      : this.globalGroups.find((g) => g.name === name)?.fields;
    if (!fields?.length) return 0;
    const existing = target === 'task'
      ? { ...(this.taskConfigs[name]?.params || {}) }
      : { ...(this.globalSnapshots[name] || {}) };
    let added = 0;
    for (const f of fields) {
      if (f.key in existing) continue;
      existing[f.key] = f.default !== undefined ? f.default : f.value;
      added += 1;
    }
    if (!added) return 0;
    if (target === 'task') {
      this.taskConfigs = { ...this.taskConfigs, [name]: { ...this.taskConfigs[name], params: existing } };
    } else {
      this.globalSnapshots = { ...this.globalSnapshots, [name]: existing };
    }
    this.saveStore();
    this.scheduleParamsPush();
    this.scheduleGParamsPush();
    this.view?.webview.postMessage({
      type: 'snapshotUpdated', target, name,
      params: target === 'task' ? existing : undefined,
      values: target === 'global' ? existing : undefined,
    });
    return added;
  }

  /**
   * 恢复默认（决议 2：出厂值）——快照里 default 仍存在的键重置为出厂值；孤儿键保留。
   * 返回重置键数。
   */
  private resetSnapshotToDefault(target: string, name: string): number {
    const fields = target === 'task'
      ? this.schemas[name]?.fields
      : this.globalGroups.find((g) => g.name === name)?.fields;
    if (!fields?.length) return 0;
    const existing = target === 'task'
      ? { ...(this.taskConfigs[name]?.params || {}) }
      : { ...(this.globalSnapshots[name] || {}) };
    let reset = 0;
    for (const f of fields) {
      if (f.default === undefined || configValuesEqual(existing[f.key], f.default)) continue;
      existing[f.key] = f.default;
      reset += 1;
    }
    if (!reset) return 0;
    if (target === 'task') {
      this.taskConfigs = { ...this.taskConfigs, [name]: { ...this.taskConfigs[name], params: existing } };
    } else {
      this.globalSnapshots = { ...this.globalSnapshots, [name]: existing };
    }
    this.saveStore();
    this.scheduleParamsPush();
    this.scheduleGParamsPush();
    this.view?.webview.postMessage({
      type: 'snapshotUpdated', target, name,
      params: target === 'task' ? existing : undefined,
      values: target === 'global' ? existing : undefined,
    });
    return reset;
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
        globalConfigs: this.globalSnapshots,
        expandedGlobalGroups: [...this.expandedGlobalGroups],
        uiState: this.uiState,
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
  private loadSchemaCache(projectDir: string, locale: string): {
    schemas: Record<string, TaskSchema>;
    globalGroups: GlobalConfigGroup[];
    multiAccount: MultiAccountInfo;
  } {
    const empty = {
      schemas: {} as Record<string, TaskSchema>,
      globalGroups: [] as GlobalConfigGroup[],
      multiAccount: { available: false } as MultiAccountInfo,
    };
    try {
      const p = this.dataFile('ok-script-toolkit-schema.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SchemaProbeResult & { projectDir?: string; locale?: string };
        const cachedLocale = raw.locale || Object.values(raw.schemas || {})[0]?.locale;
        if (raw.projectDir !== projectDir || cachedLocale !== locale) return empty;
        // 缓存版本化：旧格式缓存没有 enabledTasks（账号编辑器键集）——作废重探，
        // 否则账号编辑器永远拿不到任务/键筛选数据
        const cachedMulti = raw.multiAccount;
        if (cachedMulti && cachedMulti.available === true && cachedMulti.enabledTasks === undefined) return empty;
        return {
          schemas: raw.schemas || {},
          globalGroups: raw.globalConfigGroups || [],
          multiAccount: cachedMulti || empty.multiAccount,
        };
      }
    } catch { /* 忽略损坏的缓存 */ }
    return empty;
  }

  /** 写入 schema 缓存 */
  private saveSchemaCache(
    projectDir: string,
    locale: string,
    schemas: Record<string, TaskSchema>,
    globalGroups: GlobalConfigGroup[],
    multiAccount: MultiAccountInfo,
  ): void {
    try {
      const p = this.dataFile('ok-script-toolkit-schema.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        JSON.stringify({ ok: true, projectDir, locale, schemas, globalConfigGroups: globalGroups, multiAccount }, null, 2),
        'utf-8',
      );
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
    const cached = this.loadSchemaCache(projectDir, locale);
    this.schemas = cached.schemas;
    this.globalGroups = cached.globalGroups;
    this.multiAccount = cached.multiAccount;
    this.loadTaskConfigs(projectDir);
    // 缓存 schema 也要物化快照：保证启动执行器时注入的是全量接管值
    this.materializeAllSnapshots();
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
    await view.webview.postMessage({
      type: 'tasks',
      tasks,
      schemas: this.schemas,
      globalGroups: this.globalGroups,
      globalSnapshots: this.globalSnapshots,
      multiAccount: this.multiAccount,
    });
    this.pushGlobalGroups();
    this.pushExecutorState(view);
    this.pushGameState();
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
    // 取值链：IDE 设置 `poDirectory` → 项目约定 `i18n.poDirectory` → `i18n`
    const poDirectory = i18nPoDirectorySetting();
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
    this.globalGroups = [
      ...(probe.globalConfigGroups || []),
      ...(probe.projectGlobalGroups || []),
    ];
    this.multiAccount = probe.multiAccount || { available: false };
    if (this.multiAccount.hasStoreModule === true) this.runAccountStore(['get']);
    this.saveSchemaCache(projectDir, locale, probe.schemas, this.globalGroups, this.multiAccount);
    const brokenCount = Object.values(probe.schemas).filter((s) => s.broken).length;
    // 配置接管：物化快照（首建继承项目值 / 新键补出厂值 / 孤儿键保留），落盘并回推
    const materialized = this.materializeAllSnapshots();
    // 只回推 schema 更新，让 UI 把已展开的任务卡片渲染出参数表单
    void view.webview.postMessage({
      type: 'schemas',
      schemas: this.schemas,
      globalGroups: this.globalGroups,
      globalSnapshots: this.globalSnapshots,
      multiAccount: this.multiAccount,
    });
    this.pushGlobalGroups();
    if (materialized > 0) {
      void view.webview.postMessage({
        type: 'status',
        level: 'ok',
        text: tr('Configuration takeover: {count} snapshot key(s) materialized', { count: materialized }),
      });
    }
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
   * 不等于「现在开始跑」。想真正启动请点状态条的启动按钮（`startExecutor`）。
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

  /** 显式启动执行器（状态条按钮）：环境不满足时会在 UI 提示 */
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
    // 全局配置组快照：执行器启动时 merge 进沙箱 configs/<组名>.json（run_executor 侧处理）
    if (Object.keys(this.globalSnapshots).length) {
      childEnv.OK_TOOLKIT_GCONFIG = JSON.stringify(this.globalSnapshots);
    }
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
    // 浮层互斥：执行器进程自己持有 Win32GdiOverlay，通知浮层宿主停掉独立进程
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
    // 浮层互斥：执行器退出后把独立浮层宿主交还（error / close 都会走到这里，
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

  /** 把游戏连接 / 浮层状态推给 webview（状态条第一行 + 游戏分段） */
  private pushGameState(): void {
    const view = this.view;
    if (!view) return;
    const state = loadToolboxState(this.currentProjectDir);
    void view.webview.postMessage({
      type: 'game',
      game: state.game || null,
      overlay: state.overlay === true,
    });
  }

  private setStatus(level: 'ok' | 'warn' | 'error' | 'info', text: string): void {
    void this.view?.webview.postMessage({ type: 'status', level, text });
  }

  /**
   * 浮层开关 → 运行中执行器即时生效（stdin overlay_on/off 命令）。
   * 由 GameConnectService.overlayForwarder 调用；无运行执行器时返回 false，
   * 开关状态由服务直接持久化、下次启动沿用。
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
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    if (this.paramsTimer) clearTimeout(this.paramsTimer);
    if (this.executor) {
      this.executor.kill();
      this.executor = null;
    }
    this.toolboxSubscription?.dispose();
    this.toolboxSubscription = undefined;
    this.gameConnect.detachUi();
    this.output.dispose();
  }

  /** 读取控制台 Webview 外壳并注入 CSP 与本地资源 URI。 */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'console', 'index.html');
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
      vscode.Uri.joinPath(this.extensionUri, 'media', 'console', name),
    ).toString(true);
    return injectWebviewLocalization(applySharedAssets(webview, this.extensionUri, html
        .split('__CSP_NONCE__').join(nonce)
        .split('__CSP_SOURCE__').join(webview.cspSource)
        .split('__STYLE_URI__').join(resource('console.css'))
        .split('__CORE_SCRIPT_URI__').join(resource('core.js'))
        .split('__FIELDS_SCRIPT_URI__').join(resource('fields.js'))
        .split('__CONFIG_PANEL_SCRIPT_URI__').join(resource('configPanel.js'))
        .split('__TASK_CARD_SCRIPT_URI__').join(resource('taskCard.js'))
        .split('__CONSOLE_SCRIPT_URI__').join(resource('console.js'))
        .split('__APP_SCRIPT_URI__').join(resource('app.js')),
    ));
  }
}
