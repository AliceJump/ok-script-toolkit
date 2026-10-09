import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

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

  constructor(
    private readonly extensionPath: string,
    private readonly resolvePythonPath: () => string,
    private readonly onTrigger: () => void,
    private readonly log: (message: string) => void = (message) => console.log(`[ok-script Toolkit] ${message}`),
  ) {
    this.start();
  }

  restart(): void {
    if (this.disposed) return;
    this.stop();
    this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private start(): void {
    if (process.platform !== 'win32') return;

    const scriptPath = path.join(this.extensionPath, 'python', 'global_hotkey.py');
    if (!fs.existsSync(scriptPath)) {
      this.log(`Global screenshot hotkey helper not found: ${scriptPath}`);
      return;
    }

    const pythonPath = this.resolvePythonPath();
    const generation = ++this.generation;
    let stdoutBuffer = '';

    try {
      const child = spawn(pythonPath, [scriptPath], {
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
        }
      });

      child.on('close', (code) => {
        if (generation !== this.generation) return;
        if (this.child === child) this.child = undefined;
        if (!this.disposed && code !== 0) {
          this.log(`Global screenshot hotkey helper exited with code ${code ?? 'unknown'}`);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to start global screenshot hotkey helper: ${message}`);
    }
  }

  private stop(): void {
    ++this.generation;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
  }

  private handleLine(line: string): void {
    if (!line) return;
    if (line === 'TRIGGER') {
      this.onTrigger();
      return;
    }
    if (line === 'READY') {
      this.log('Global screenshot hotkey registered: Ctrl+Alt+S');
      return;
    }
    if (line === 'UNSUPPORTED') return;
    if (line.startsWith('ERROR ')) {
      this.log(`Global screenshot hotkey unavailable: ${line.slice('ERROR '.length)}`);
    }
  }
}
