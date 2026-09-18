import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** 工具箱"连接游戏"建立的窗口连接（同时写入项目 configs/devices.json 供任务进程复用） */
export interface GameConnection {
  hwnd: number;
  pid: number;
  title: string;
  exe: string;
  connectedAt: number;
}

/** 工具箱共享状态：调试浮层开关 + 游戏连接。任务启动器无感复用。 */
export interface ToolboxState {
  overlay?: boolean;
  game?: GameConnection | null;
}

interface ToolboxStore {
  projects: Record<string, ToolboxState>;
}

const EMPTY_STATE: ToolboxState = {};

type Listener = (state: ToolboxState, projectDir: string) => void;
const listeners = new Set<Listener>();

/** 工作区 .vscode 下工具箱数据文件的绝对路径 */
function toolboxFile(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return path.join(root, '.vscode', 'ok-script-toolkit-toolbox.json');
}

function readStore(): ToolboxStore {
  try {
    const p = toolboxFile();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<ToolboxStore>;
      if (raw.projects && typeof raw.projects === 'object') return { projects: raw.projects };
    }
  } catch { /* 忽略损坏的状态文件 */ }
  return { projects: {} };
}

/** 读取某项目的工具箱状态（无记录返回空对象） */
export function loadToolboxState(projectDir: string): ToolboxState {
  if (!projectDir) return EMPTY_STATE;
  return readStore().projects[projectDir] || EMPTY_STATE;
}

/** 合并写入某项目的工具箱状态，并通知所有订阅者（webview 之间借此同步） */
export function saveToolboxState(projectDir: string, patch: Partial<ToolboxState>): ToolboxState {
  if (!projectDir) return EMPTY_STATE;
  const store = readStore();
  const next: ToolboxState = { ...store.projects[projectDir], ...patch };
  store.projects[projectDir] = next;
  try {
    const p = toolboxFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
  } catch { /* 写入失败不影响内存态 */ }
  for (const listener of listeners) {
    try { listener(next, projectDir); } catch { /* 订阅者异常互不影响 */ }
  }
  return next;
}

/** 订阅工具箱状态变化；返回取消订阅的可释放对象 */
export function onToolboxStateChange(listener: Listener): vscode.Disposable {
  listeners.add(listener);
  return new vscode.Disposable(() => listeners.delete(listener));
}

// ── 执行器运行状态（浮层互斥用）─────────────────────────────────────

type ExecutorRunningListener = (running: boolean, projectDir: string) => void;
const executorRunningListeners = new Set<ExecutorRunningListener>();

/**
 * 执行器是否在跑。放在这里而不是各面板里，是为了让工具箱面板能判断「该不该拉独立浮层宿主」
 * 而不用反向依赖任务启动器。
 */
let executorRunning = false;

export function isExecutorRunning(): boolean {
  return executorRunning;
}

/**
 * 任务启动器在执行器启停时调用（重复调用同一状态会被忽略 —— child 的 error/close
 * 会各触发一次）。
 *
 * 用途：**浮层互斥**。执行器进程自己持有 Win32GdiOverlay，独立浮层宿主
 * （overlay_host.py）必须让位，否则同一个游戏窗口上会有两个 overlay 重复绘制边框 /
 * 识别框，Alt+右键框选也会互相抢占。
 */
export function notifyExecutorRunning(running: boolean, projectDir: string): void {
  if (executorRunning === running) return;
  executorRunning = running;
  for (const listener of executorRunningListeners) {
    try { listener(running, projectDir); } catch { /* 订阅者异常互不影响 */ }
  }
}

/** 订阅执行器启停；返回取消订阅的可释放对象 */
export function onExecutorRunningChange(listener: ExecutorRunningListener): vscode.Disposable {
  executorRunningListeners.add(listener);
  return new vscode.Disposable(() => executorRunningListeners.delete(listener));
}
