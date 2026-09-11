import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { TempScreenshotStore, MAX_TEMP_SCREENSHOTS } from './tempScreenshotStore';
import { TemplateAssetData } from './templateAssetData';
import { repaintAllAssetGalleries } from './templateAssetPanel';
import { captureGameWindow } from './screenshotCapture';
import { clearPendingDrag, setPendingDrag } from './tempDrag';
import { cropTemplateThumbFileAsync, readImageSize, removeTemplateThumbFile, THUMB_HEIGHT } from './pngCrop';
import { injectWebviewLocalization, tr } from './localization';

/* ---------------- 剪贴板读图（Windows 回退路径） ---------------- */

/**
 * 通过 PowerShell 读取系统剪贴板中的图片并转为 PNG base64。
 * 仅作为「粘贴」按钮的回退手段——webview 内的 paste 事件是首选通道。
 */
function readClipboardImageBase64(): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { exit 2 }',
    '$ms = New-Object System.IO.MemoryStream',
    '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise<string | undefined>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { timeout: 15000, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) { resolve(undefined); return; }
        const text = (stdout || '').trim();
        resolve(text.length > 0 ? text : undefined);
      },
    );
  });
}

/* ---------------- 控制器 ---------------- */

/**
 * 舞台/轮播预览图的目标高度。
 * 侧边栏不可能显示原图分辨率，用降采样预览可以显著降低轮播时 webview 的
 * 解码内存（原图可能 4K），而归一化坐标与缩放比例无关，精度不受影响。
 */
const STAGE_PREVIEW_HEIGHT = 720;

interface TempMeta {
  id: string;
  name: string;
  /** 舞台 / 轮播用的降采样预览图 */
  url: string;
  /** 网格缩略图 */
  thumbUrl: string;
  width: number;
  height: number;
}

class TempScreenshotController {
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly store: TempScreenshotStore,
    private readonly assetData: TemplateAssetData,
    private readonly tempThumbDir: string,
    private readonly isVisible: () => boolean,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
      store.onChange(() => { void this.refresh(); }),
    );
  }

  attachHtml(): void {
    this.webview.html = tempScreenshotHtml(this.webview, this.extensionUri);
  }

  /* ---------- 推送列表 ---------- */

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (!this.isVisible()) return;
    const items = this.store.list();
    const metas: TempMeta[] = [];

    for (const item of items) {
      let width = 0;
      let height = 0;
      try {
        const buf = await fs.promises.readFile(item.filePath);
        const dims = readImageSize(buf);
        if (dims) { width = dims.width; height = dims.height; }
      } catch { /* 忽略单张读取失败 */ }

      const bbox: [number, number, number, number] = [0, 0, width || 100, height || 100];
      const thumbFile = await cropTemplateThumbFileAsync(item.filePath, bbox, this.tempThumbDir, THUMB_HEIGHT);
      const previewFile = await cropTemplateThumbFileAsync(item.filePath, bbox, this.tempThumbDir, STAGE_PREVIEW_HEIGHT);

      metas.push({
        id: item.id,
        name: item.name,
        url: previewFile
          ? this.webview.asWebviewUri(vscode.Uri.file(previewFile)).toString(true)
          : this.webview.asWebviewUri(vscode.Uri.file(item.filePath)).toString(true),
        thumbUrl: thumbFile
          ? this.webview.asWebviewUri(vscode.Uri.file(thumbFile)).toString(true)
          : '',
        width,
        height,
      });
    }

    if (this.disposed) return;
    await this.webview.postMessage({ type: 'temps', items: metas, max: MAX_TEMP_SCREENSHOTS });
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    void this.webview.postMessage({ type: 'notice', level, text });
  }

  /* ---------- 消息分发 ---------- */

  private async onMessage(msg: {
    type?: string;
    id?: string;
    data?: string;
    text?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refresh();
        break;

      case 'pastePng': {
        if (typeof msg.data !== 'string') break;
        const added = this.store.addPng(msg.data);
        if (!added) this.notice('error', tr('Failed to save screenshot.'));
        break;
      }

      case 'pasteClipboard': {
        await this.handleClipboardPaste();
        break;
      }

      case 'capture': {
        await this.handleCapture();
        break;
      }

      case 'deleteTemp': {
        if (!msg.id) break;
        const target = this.store.get(msg.id);
        if (target) this.removeThumb(target.filePath);
        this.store.remove(msg.id);
        break;
      }

      case 'clearAll': {
        for (const item of this.store.list()) this.removeThumb(item.filePath);
        this.store.clear();
        break;
      }

      case 'copyText': {
        if (typeof msg.text === 'string') {
          await vscode.env.clipboard.writeText(msg.text);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.text }));
        }
        break;
      }

      case 'sendToAssets': {
        if (msg.id) await this.sendToAssets(msg.id);
        break;
      }

      case 'dragStart': {
        if (msg.id) setPendingDrag(msg.id);
        break;
      }

      case 'dragEnd': {
        clearPendingDrag();
        break;
      }
    }
  }

  /* ---------- 各动作实现 ---------- */

  private async handleClipboardPaste(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const base64 = await readClipboardImageBase64();
      if (!base64) {
        this.notice('warn', tr('No image in clipboard. Press Ctrl+V inside this view to paste.'));
        return;
      }
      if (!this.store.addPng(base64)) {
        this.notice('error', tr('Failed to save screenshot.'));
      }
    } finally {
      this.busy = false;
    }
  }

  private async handleCapture(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const outputPath = this.store.newFilePath();
      const outcome = await captureGameWindow(outputPath);
      if (outcome.ok) {
        this.store.register(outputPath);
        void vscode.window.showInformationMessage(tr('Screenshot saved: {name}', { name: path.basename(outputPath) }));
        return;
      }
      switch (outcome.reason) {
        case 'noScript':
          this.notice('error', tr('Screenshot script not found. capture_game_window.py is missing from the extension.'));
          break;
        case 'cancelled':
          break;
        default:
          this.notice('error', tr('Screenshot failed: {error}', { error: outcome.error || '' }));
      }
    } finally {
      this.busy = false;
    }
  }

  /** 把临时截图复制进 ok_templates 并刷新标注管理面板。 */
  async sendToAssets(id: string): Promise<boolean> {
    const target = this.store.get(id);
    if (!target) return false;
    const dst = this.assetData.importImageFile(target.filePath);
    if (!dst) {
      this.notice('error', tr('Failed to add to template assets: {error}', { error: target.name }));
      return false;
    }
    repaintAllAssetGalleries();
    this.notice('info', tr('Added to template assets: {name}', { name: path.basename(dst) }));
    return true;
  }

  private removeThumb(filePath: string): void {
    try {
      const buf = fs.readFileSync(filePath);
      const dims = readImageSize(buf);
      if (!dims) return;
      const bbox: [number, number, number, number] = [0, 0, dims.width, dims.height];
      removeTemplateThumbFile(filePath, bbox, this.tempThumbDir, THUMB_HEIGHT);
      removeTemplateThumbFile(filePath, bbox, this.tempThumbDir, STAGE_PREVIEW_HEIGHT);
    } catch { /* 忽略 */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ---------------- 侧边栏视图 ---------------- */

export class TempScreenshotViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.tempScreenshots';

  constructor(
    private readonly store: TempScreenshotStore,
    private readonly assetData: TemplateAssetData,
    private readonly tempThumbDir: string,
    private readonly extensionUri: vscode.Uri,
  ) { }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.file(this.store.directory),
        vscode.Uri.file(this.tempThumbDir),
      ],
    };
    const controller = new TempScreenshotController(
      view.webview,
      this.extensionUri,
      this.store,
      this.assetData,
      this.tempThumbDir,
      () => view.visible,
    );
    controller.attachHtml();
    view.onDidChangeVisibility(() => { if (view.visible) void controller.refresh(); });
    view.onDidDispose(() => controller.dispose());
  }
}

/* ---------------- HTML ---------------- */

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 24; i++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

function tempScreenshotHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const file = path.join(extensionUri.fsPath, 'media', 'tempScreenshots', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'tempScreenshots', name),
  ).toString(true);
  return injectWebviewLocalization(
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  );
}
