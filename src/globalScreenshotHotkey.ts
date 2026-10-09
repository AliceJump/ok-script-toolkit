import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Windows 系统级 Ctrl+Alt+S 监听器。
 *
 * VS Code 的 contributes.keybindings 只能在 VS Code 获得焦点时触发；这里启动一个
 * 仅依赖 Python 标准库的轻量辅助进程，通过 RegisterHotKey 收到系统级快捷键后把
 * TRIGGER 事件转回扩展宿主。截图本身仍由现有 command/面板链路完成。
 */
export class GlobalScreenshotHotkey {
  private child: ChildProcess | undefined;
  private generation = 0;
  private disposed = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = INITIAL_RETRY_DELAY_MS;

  constructor(
    private readonly extensionPath: string,
    private readonly resolvePythonPath: () => string,
    private readonly onTrigger: () => void,
    private readonly log: (message: string) => void = (message) => console.log(`[ok-script Toolkit] ${message}`),
  ) {
    this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRetry();
    this.stop();
  }

  private start(): void {
    if (this.disposed || process.platform !== 'win32') return;

    this.clearRetry();
    const scriptPath = path.join(this.extensionPath, 'python', 'global_hotkey.py');
    if (!fs.existsSync(scriptPath)) {
      this.log(`Global screenshot hotkey helper not found: ${scriptPath}`);
      return;
    }

    const generation = ++this.generation;
    let stdoutBuffer = '';

    try {
      const pythonPath = this.resolvePythonPath();
      const child = spawn(pythonPath, [scriptPath, '--parent-pid', String(process.pid)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (generation !== this.generation || this.disposed) return;
        stdoutBuffer += chunk;
        while (true) {
          const newline = stdoutBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          this.handleLine(line);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (generation === this.generation && !this.disposed) {
          const text = chunk.trim();
          if (text) this.log(`Global screenshot hotkey helper stderr: ${text}`);
        }
      });

      child.on('error', (error) => {
        if (generation === this.generation && !this.disposed) {
          this.log(`Failed to start global screenshot hotkey helper: ${error.message}`);
          this.scheduleRetry();
        }
      });

      child.on('close', (code) => {
        if (generation !== this.generation) return;
        if (this.child === child) this.child = undefined;
        if (!this.disposed && code !== 0) {
          this.log(`Global screenshot hotkey helper exited with code ${code ?? 'unknown'}`);
          this.scheduleRetry();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to start global screenshot hotkey helper: ${message}`);
      this.scheduleRetry();
    }
  }

  private stop(): void {
    ++this.generation;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(): void {
    if (this.disposed || process.platform !== 'win32' || this.retryTimer) return;

    const delayMs = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, delayMs);
    this.retryTimer.unref?.();
    this.log(`Retrying global screenshot hotkey registration after ${delayMs}ms`);
  }

  private handleLine(line: string): void {
    if (!line) return;
    if (line === 'TRIGGER') {
      this.onTrigger();
      return;
    }
    if (line === 'READY') {
      this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
      this.log('Global screenshot hotkey registered: Ctrl+Alt+S');
      return;
    }
    if (line === 'UNSUPPORTED') return;
    if (line.startsWith('ERROR ')) {
      this.log(`Global screenshot hotkey unavailable: ${line.slice('ERROR '.length)}`);
    }
  }
}
