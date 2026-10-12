/** Shared run-view / executor types (extracted from consolePanel for TreeView + params). */
/** 单个任务的元信息 */
export interface TaskInfo {
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
export interface TaskListResult {
  ok: boolean;
  error?: string;
  tasks?: TaskInfo[];
  /** config 模块路径：`src.config` 或 `config`（取决于 config.py 所在位置） */
  configModule?: string;
}

/** 每个任务可编辑的一项参数（对应项目任务 default_config 里的一个 key） */
export interface TaskParamField {
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
export interface TaskSchema {
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
  /** 项目游戏 UI 的可见性声明；工具箱保留任务以供开发调试。 */
  showInTaskTab?: boolean;
  /** 项目声明的配置分组/子任务树：组名 -> 字段或子组 key。 */
  configGroups?: Record<string, string[]>;
  groupLabels?: Record<string, string>;
  /** register_config_groups 生成的分组下拉字段。 */
  groupSelector?: string;
  locale?: string;
}

/** 全局配置组（框架 GlobalConfig 可见组，probe 的 globalConfigGroups 段） */
export interface GlobalConfigGroup {
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
export interface TaskConfig {
  extraArgs?: string;
  env?: Record<string, string>;
  /** 任务参数快照：key=任务 default_config 的 key（含孤儿键），value=快照值 */
  params?: Record<string, unknown>;
}

/** 单个项目的持久化数据 */
export interface ProjectStore {
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
export interface TaskConfigStore {
  projects: Record<string, ProjectStore>;
}

/** schema 采集结果（刷新时全量 import 项目任务后落盘缓存） */
export interface SchemaProbeResult {
  ok: boolean;
  error?: string;
  schemas?: Record<string, TaskSchema>;
  /** 参与采集的任务总数 */
  total?: number;
  /** 全局配置组（框架 GlobalConfig 可见组） */
  globalConfigGroups?: GlobalConfigGroup[];
  /** 多账户存储只读概要（configs/account_scoped_overrides.json） */
  multiAccount?: MultiAccountInfo;
}

/** 多账户存储只读概要（Phase 6 只读呈现，不做编辑器） */
export interface MultiAccountInfo {
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
export interface AccountStoreData {
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
export interface ExecutorSnapshot {
  paused?: boolean;
  /** 当前正在执行的任务 key（module::Class），空闲时为 null */
  current?: string | null;
  currentIsTrigger?: boolean;
  /** 执行器侧的触发任务启用状态（权威值，宿主据此回写勾选集合） */
  triggers?: { key?: string; enabled?: boolean }[];
  /** 一次性任务等待队列 */
  onetimeQueue?: string[];
}

