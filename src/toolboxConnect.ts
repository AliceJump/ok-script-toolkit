import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { tr } from './localization';
import { parseJsonFromStdout, pythonScript, resolveProjectContext, runPython } from './consolePanel';
import {
  GameConnection,
  isExecutorRunning,
  loadToolboxState,
  onExecutorRunningChange,
  onToolboxStateChange,
  saveToolboxState,
  saveToolboxStateChecked,
  ToolboxState,
} from './toolboxState';

/** 控制台状态行 / 游戏分段展示的文本回调（宿主注入，落到 webview 的 status 区） */
export type ToolboxStatusReporter = (text: string) => void;

/**
 * 游戏连接 + 调试浮层的共享宿主逻辑（从原侧边栏工具箱提取，供「ok-script 控制台」复用）。
 *
 * 职责：
 * 1. 连接 / 断开游戏窗口（python/connect_game.py，写入项目 configs/devices.json 供任务进程复用）；
 * 2. 调试浮层开关（持久化到工具箱状态；任务运行中经 overlayForwarder 即时下发执行器）；
 * 3. 常驻浮层宿主进程（overlay_host.py）的生命周期与**浮层互斥**。
 *
 * 浮层互斥说明：执行器进程自己持有 Win32GdiOverlay，它运行时独立宿主必须让位，
 * 否则同一个游戏窗口上会有两个 overlay 重复绘制边框/识别框，Alt+右键框选也会互相抢占。
 * 互斥订阅放在构造函数里（而不是视图 resolve 时）——执行器先于控制台视图启动时也要生效。
 */
export class GameConnectService implements vscode.Disposable {
  /** 浮层开关 → 运行中执行器的转发（控制台宿主注入；无运行执行器时返回 false） */
  overlayForwarder: ((enabled: boolean) => boolean) | null = null;

  private disposed = false;
  /** 常驻浮层宿主进程（连接游戏后拉起，断开/关浮层/执行器启动时停止） */
  private overlayHost?: childProcess.ChildProcess;
  private overlayHostProjectDir = '';
  private overlayHostChannel?: vscode.OutputChannel;
  private statusReporter: ToolboxStatusReporter | null = null;
  private stateListener: (() => void) | null = null;
  private busSubscription?: vscode.Disposable;
  private executorSubscription?: vscode.Disposable;
  /** connect_game.py 会写同一份 devices.json；串行执行才能保证最后一次操作生效。 */
  private connectionTail: Promise<void> = Promise.resolve();
  /** 两个 Connect 入口同时点击时共用一次连接；Disconnect 会结束这次合并窗口。 */
  private pendingConnect?: { projectDir: string; promise: Promise<void> };

  constructor(private readonly extensionUri: vscode.Uri) {
    // 订阅必须在构造期完成：浮层互斥不依赖任何视图是否打开过
    this.busSubscription = onToolboxStateChange(() => this.stateListener?.());
    this.executorSubscription = onExecutorRunningChange((running, projectDir) => {
      this.syncOverlayHostWithExecutor(running, projectDir);
    });
  }

  /** 注入 UI 回调（宿主在 resolveWebviewView 时调用；view 关闭时 detach） */
  attachUi(onStatus: ToolboxStatusReporter, onStateChange: () => void): void {
    this.statusReporter = onStatus;
    this.stateListener = onStateChange;
  }

  /** 解除 UI 回调（webview 被销毁后不再向它推送） */
  detachUi(): void {
    this.statusReporter = null;
    this.stateListener = null;
  }

  /** 当前项目目录；未配置项目时返回空串 */
  private currentProjectDir(): string {
    return resolveProjectContext().projectDir;
  }

  /** 当前工具箱状态（游戏连接 + 浮层开关），供宿主推送给 webview */
  currentState(): ToolboxState {
    return loadToolboxState(this.currentProjectDir());
  }

  private reportStatus(text: string): void {
    this.statusReporter?.(text);
  }

  private queueConnection(work: () => Promise<void>): Promise<void> {
    const operation = this.connectionTail.then(work);
    // 单次操作的错误交给调用方；队列本身始终可继续处理后续 Disconnect。
    this.connectionTail = operation.catch(() => undefined);
    return operation;
  }

  /** 连接游戏窗口：搜索并写入 devices.json，任务进程启动时原生优先该窗口 */
  async connect(): Promise<void> {
    const { projectDir, pythonPath } = resolveProjectContext();
    if (!projectDir) {
      this.reportStatus(tr('No ok-script project was found. Configure okScriptToolkit.okScriptProjectPath or open a folder containing src/config.py.'));
      return;
    }
    if (this.pendingConnect?.projectDir === projectDir) {
      return this.pendingConnect.promise;
    }
    const operation = this.queueConnection(async () => {
      if (this.disposed) return;
      this.reportStatus(tr('Connecting to game window…'));
      try {
        const result = await runPython(
          pythonPath,
          [pythonScript(this.extensionUri, 'connect_game.py'), projectDir],
          projectDir,
          // 游戏未运行时会自动启动并等待窗口（脚本侧最长 150s），超时要留足余量
          200000,
        );
        const parsed = parseJsonFromStdout(result.stdout || '');
        if (!parsed || !parsed.ok) {
          throw new Error(parsed?.error || tr('Unknown error'));
        }
        const game: GameConnection = {
          hwnd: Number(parsed.hwnd) || 0,
          pid: Number(parsed.pid) || 0,
          title: String(parsed.title || ''),
          exe: String(parsed.exe || ''),
          connectedAt: Date.now(),
        };
        saveToolboxStateChecked(projectDir, { game });
        this.reportStatus('');
        // 调试浮层开启时拉起常驻宿主：无需启动任务即可 Alt+右键框选取坐标
        if (loadToolboxState(projectDir).overlay) {
          this.startOverlayHost(projectDir);
        }
      } catch (e) {
        this.reportStatus(tr('Failed to connect game window: {error}', {
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    });
    this.pendingConnect = { projectDir, promise: operation };
    void operation.then(() => {
      if (this.pendingConnect?.promise === operation) this.pendingConnect = undefined;
    }, () => {
      if (this.pendingConnect?.promise === operation) this.pendingConnect = undefined;
    });
    return operation;
  }

  /** 断开连接：清除 devices.json 里的窗口选中，任务进程恢复自动探测 */
  async disconnect(): Promise<void> {
    const { projectDir, pythonPath } = resolveProjectContext();
    if (!projectDir) return;
    // 即使后续又点 Connect，也要把新请求排在这次 Disconnect 之后。
    this.pendingConnect = undefined;
    return this.queueConnection(async () => {
      if (this.disposed) return;
      try {
        const result = await runPython(
          pythonPath,
          [pythonScript(this.extensionUri, 'connect_game.py'), projectDir, '--disconnect'],
          projectDir,
          30000,
        );
        const parsed = parseJsonFromStdout(result.stdout);
        if (!parsed?.ok || parsed.disconnected !== true) {
          throw new Error(parsed?.error || tr('Unknown error'));
        }
        if (this.overlayHostProjectDir === projectDir) this.stopOverlayHost();
        saveToolboxStateChecked(projectDir, { game: null });
        this.reportStatus('');
      } catch (e) {
        this.reportStatus(tr('Failed to disconnect game window: {error}', {
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    });
  }

  /**
   * 浮层互斥的另一半：执行器启停时让独立宿主让位 / 归位。
   *
   * 执行器一起来就停掉宿主（它自带 overlay）；执行器退出后，若浮层开关仍开着、
   * 且这边还连着游戏，就把宿主拉回来 —— 否则会出现「跑完一次任务，浮层就没了」。
   */
  private syncOverlayHostWithExecutor(running: boolean, projectDir: string): void {
    if (running) {
      this.stopOverlayHost();
      return;
    }
    const dir = projectDir || this.currentProjectDir();
    if (!dir) return;
    const state = loadToolboxState(dir);
    if (state.overlay && state.game) {
      this.startOverlayHost(dir);
    }
  }

  /**
   * 拉起常驻浮层宿主（同项目已运行则复用）。
   */
  private startOverlayHost(projectDir: string): void {
    if (!projectDir) return;
    if (isExecutorRunning()) return;
    // 扩展正在关闭时不要再去 spawn：可能是「执行器被杀 → notifyExecutorRunning(false) →
    // 这里被拉起来」，紧接着又被 dispose 停掉，白起一个 Python 进程还可能在输出频道留下错误噪声。
    if (this.disposed) return;
    if (this.overlayHost && this.overlayHostProjectDir === projectDir && !this.overlayHost.killed) return;
    this.stopOverlayHost();

    const { pythonPath } = resolveProjectContext();
    if (!pythonPath) return;
    if (!this.overlayHostChannel) {
      this.overlayHostChannel = vscode.window.createOutputChannel(tr('ok-script Overlay Host'));
    }
    const child = childProcess.spawn(
      pythonPath,
      [pythonScript(this.extensionUri, 'overlay_host.py'), projectDir],
      { cwd: projectDir, windowsHide: true },
    );
    this.overlayHostChannel.appendLine(`[spawn] ${pythonPath} overlay_host.py ${projectDir}`);
    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      this.overlayHostChannel?.append(text);
      if (text.includes('OK_TOOLKIT_OVERLAY_HOST_READY')) {
        this.reportStatus(tr('Overlay host ready: Alt+Right-click two corners in the game to copy box coordinates.'));
      }
    });
    child.stderr?.on('data', (d: Buffer) => this.overlayHostChannel?.append(d.toString('utf8')));
    child.on('error', (err) => {
      this.overlayHostChannel?.appendLine(`[error] ${err.message}`);
      if (this.overlayHost === child) this.overlayHost = undefined;
    });
    child.on('exit', () => {
      if (this.overlayHost === child) this.overlayHost = undefined;
    });
    this.overlayHost = child;
    this.overlayHostProjectDir = projectDir;
  }

  /** 停止常驻浮层宿主（若有） */
  private stopOverlayHost(): void {
    const child = this.overlayHost;
    if (!child) return;
    this.overlayHost = undefined;
    try {
      if (child.pid) {
        // Windows 上 TerminateProcess 直接结束宿主及其线程
        if (process.platform === 'win32') {
          childProcess.spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } else {
        child.kill();
      }
    } catch { /* 进程已退出 */ }
    if (this.overlayHostProjectDir) {
      this.reportStatus(tr('Overlay host stopped.'));
    }
    this.overlayHostProjectDir = '';
  }

  /** 调试浮层开关：持久化到工具箱状态；任务运行中即时下发，否则下次启动沿用 */
  setOverlay(enabled: boolean): void {
    const projectDir = this.currentProjectDir();
    if (!projectDir) return;
    saveToolboxState(projectDir, { overlay: enabled });
    this.overlayForwarder?.(enabled);
    // 常驻宿主跟随开关：开着且已连接游戏时保持，关闭即停
    if (enabled && loadToolboxState(projectDir).game) {
      this.startOverlayHost(projectDir);
    } else if (!enabled) {
      this.stopOverlayHost();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.busSubscription?.dispose();
    this.busSubscription = undefined;
    this.executorSubscription?.dispose();
    this.executorSubscription = undefined;
    this.stopOverlayHost();
    this.overlayHostChannel?.dispose();
    this.overlayHostChannel = undefined;
    this.statusReporter = null;
    this.stateListener = null;
  }
}
