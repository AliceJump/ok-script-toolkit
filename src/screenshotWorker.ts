import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';

interface CaptureReply {
  capture_response: number;
  ok: boolean;
  error?: string;
  restart?: boolean;
  config?: unknown;
  frame_ready?: boolean;
}

/** 截图专用解释器：串行请求、有限等待、闲置退出；项目源码变更时自动重启。 */
export class ScreenshotWorker {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending?: { id: number; resolve: (reply: CaptureReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private idleTimer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private warming?: { method: string; job: Promise<boolean> };

  constructor(
    private readonly pythonPath: string,
    private readonly scriptPath: string,
    private readonly projectDir: string,
    private readonly log: (line: string) => void,
    private readonly timeoutMs = 30000,
    private readonly idleMs = 60000,
  ) {}

  capture(outputPath: string, windowConfig: unknown, method: string): Promise<void> {
    return this.submit({ output_path: outputPath, window_config: windowConfig, method }).then(() => {});
  }

  probe(): Promise<unknown> {
    return this.submit({ op: 'probe' }).then(reply => reply.config);
  }

  prewarm(method: string): Promise<boolean> {
    if (this.warming?.method === method) return this.warming.job;
    const job = this.submit({ op: 'warmup', method }).then(reply => reply.frame_ready === true);
    this.warming = { method, job };
    const clear = () => { if (this.warming?.job === job) this.warming = undefined; };
    void job.then(clear, clear);
    return job;
  }

  private submit(payload: Record<string, unknown>): Promise<CaptureReply> {
    const job = this.queue.then(async () => {
      if (this.disposed) throw new Error('Screenshot worker disposed');
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await this.request(payload);
        if (reply.restart) {
          this.stop();
          continue;
        }
        if (!reply.ok) throw new Error(reply.error || 'Screenshot worker failed');
        return reply;
      }
      throw new Error('Screenshot sources changed repeatedly');
    });
    this.queue = job.catch(() => {});
    return job;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.pythonPath, [this.scriptPath, '--serve'], {
      cwd: this.projectDir || undefined,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: 'pipe',
    });
    this.child = child;
    this.log(`[capture] worker_started python=${this.pythonPath} project=${this.projectDir}`);
    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    stdout.on('line', line => {
      if (this.child !== child) return;
      try {
        const reply = JSON.parse(line) as CaptureReply;
        if (!this.pending || reply.capture_response !== this.pending.id) return;
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
        this.idleTimer.unref();
        pending.resolve(reply);
      } catch { this.log(`[capture] ${line}`); }
    });
    stderr.on('line', line => this.log(`[capture] ${line}`));
    child.on('error', error => { if (this.child === child) this.stop(error); });
    child.stdin.on('error', error => { if (this.child === child) this.stop(error); });
    child.on('close', code => {
      stdout.close();
      stderr.close();
      if (this.child === child) this.stop(new Error(`Screenshot worker exited (${code})`));
    });
    return child;
  }

  private request(payload: Record<string, unknown>): Promise<CaptureReply> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.stop(new Error('Screenshot worker timed out')), this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      child.stdin.write(JSON.stringify({ ...payload, id, project_dir: this.projectDir }) + '\n');
    });
  }

  private stop(error = new Error('Screenshot worker stopped')): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = undefined;
    child?.kill();
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
