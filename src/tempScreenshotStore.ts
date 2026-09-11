import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** 临时截图侧边栏最多保留的图片数量，超出后淘汰最早的一张。 */
export const MAX_TEMP_SCREENSHOTS = 10;

export interface TempScreenshot {
  /** 文件名即唯一 id */
  id: string;
  filePath: string;
  name: string;
  mtime: number;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|bmp)$/i;

/** 生成单调递增的文件名（时间戳 + 自增序号，保证按名字排序即为时间顺序）。 */
let seq = 0;
function nextName(): string {
  seq = (seq + 1) % 1000;
  return `shot_${Date.now()}_${String(seq).padStart(3, '0')}.png`;
}

/**
 * 临时截图存储：把截图以 PNG 落盘到扩展 globalStorage 的工作区子目录，
 * 列表直接从磁盘派生（无需额外索引文件），最多保留 {@link MAX_TEMP_SCREENSHOTS} 张。
 *
 * 该存储被侧边栏视图与标注管理面板共享：侧边栏负责增删，标注管理面板负责
 * 把拖入的临时截图复制进 ok_templates。
 */
export class TempScreenshotStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly dir: string) { }

  get directory(): string { return this.dir; }

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 按时间升序列出全部临时截图（升序即轮播播放顺序）。 */
  list(): TempScreenshot[] {
    this.ensure();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((f) => IMAGE_EXT_RE.test(f));
    } catch {
      return [];
    }
    const items: TempScreenshot[] = names.map((name) => {
      const filePath = path.join(this.dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* 读取失败按 0 处理 */ }
      return { id: name, filePath, name, mtime };
    });
    items.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    return items;
  }

  get(id: string): TempScreenshot | undefined {
    return this.list().find((it) => it.id === id);
  }

  /** 为外部写入者（如截图脚本）预留一个落盘路径，随后调用 register() 生效。 */
  newFilePath(): string {
    this.ensure();
    return path.join(this.dir, nextName());
  }

  /** 写入 base64 PNG（可带 data URI 前缀）。 */
  addPng(base64: string): TempScreenshot | undefined {
    const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
    let buf: Buffer;
    try {
      buf = Buffer.from(clean, 'base64');
    } catch {
      return undefined;
    }
    if (!buf.length) return undefined;

    const filePath = this.newFilePath();
    try {
      fs.writeFileSync(filePath, buf);
    } catch {
      return undefined;
    }
    return this.register(filePath);
  }

  /** 把外部文件复制进临时目录。 */
  addFile(srcPath: string): TempScreenshot | undefined {
    const ext = path.extname(srcPath).toLowerCase();
    const filePath = path.join(this.dir, nextName().replace(/\.png$/, ext || '.png'));
    try {
      this.ensure();
      fs.copyFileSync(srcPath, filePath);
    } catch {
      return undefined;
    }
    return this.register(filePath);
  }

  /** 外部写入完成后登记：执行数量淘汰并广播变更。 */
  register(filePath: string): TempScreenshot | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    this.enforceLimit();
    this.notify();
    const id = path.basename(filePath);
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    return { id, filePath, name: id, mtime };
  }

  remove(id: string): boolean {
    const target = this.list().find((it) => it.id === id);
    if (!target) return false;
    try {
      fs.rmSync(target.filePath, { force: true });
    } catch {
      return false;
    }
    this.notify();
    return true;
  }

  clear(): void {
    for (const it of this.list()) {
      try { fs.rmSync(it.filePath, { force: true }); } catch { /* ignore */ }
    }
    this.notify();
  }

  /** 订阅变更（增/删/清空）。 */
  onChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  /** 超出上限时删除最早的若干张。 */
  private enforceLimit(): void {
    const items = this.list();
    const overflow = items.length - MAX_TEMP_SCREENSHOTS;
    for (let i = 0; i < overflow; i++) {
      try { fs.rmSync(items[i].filePath, { force: true }); } catch { /* ignore */ }
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* 订阅者异常互不影响 */ }
    }
  }
}
