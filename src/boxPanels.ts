import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationPanel } from './annotationPanel';
import {
  boxesForImage,
  readAuthoringFile,
  readRuntimeFile,
} from './boxResourceStore';
import { AUTHORING_FILE_NAME, PixelBox } from './boxResourcePure';
import { probedBoxesJson } from './cocoFeaturePath';
import { injectWebviewLocalization, tr } from './localization';
import { boxesRuntimeSetting, templatesDirectory } from './projectConfig';
import { annotatedImageFile, readImageSize } from './pngCrop';
import { getProjectConfig } from './screenshotCapture';
import { TemplateAssetData } from './templateAssetData';
import { onAnnotationDataChanged } from './cocoAnnotationData';
import { applySharedAssets, getNonce } from './webviewHtml';

function runtimeArgs(root: string): { declared?: string; fromConfig?: string } {
  return { declared: boxesRuntimeSetting(root), fromConfig: probedBoxesJson(root) };
}

function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: string): string {
  const file = path.join(extensionUri.fsPath, 'media', 'boxPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'boxPanel', name),
  ).toString(true);
  return injectWebviewLocalization(applySharedAssets(webview, extensionUri,
    fs.readFileSync(file, 'utf8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js'))
      .split('__MODE__').join(mode),
  ));
}

/**
 * 跨图片的 path 占用表：`path → 所属图片文件名`。
 * BoxEditor 把它当作 `allCategories` 下发（bbox 对话框的查重直接吃这张表），
 * 标注编辑器则随 `boxPaths` 下发给「生成框」对话框 —— 不再传空的 `allCategories: {}`。
 */
export function boxPathOccupancy(authoring: ReturnType<typeof readAuthoringFile>): Record<string, string> {
  const occupied: Record<string, string> = {};
  for (const box of authoring.boxes) occupied[box.path] = box.image;
  return occupied;
}

export class BoxGalleryViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'okScriptToolkit.boxGallery';
  private view: vscode.WebviewView | undefined;
  private generation = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly thumbDir: string,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // 缩略图落在 globalStorage 的 thumbDir，必须放行才能 asWebviewUri
      localResourceRoots: [this.extensionUri, vscode.Uri.file(this.thumbDir)],
    };
    webviewView.webview.html = panelHtml(webviewView.webview, this.extensionUri, 'gallery');
    webviewView.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
    const subscription = onAnnotationDataChanged(() => {
      const root = getProjectConfig().projectDir;
      if (root) void this.refresh(root);
    });
    webviewView.onDidDispose(() => { subscription.dispose(); this.view = undefined; this.generation++; });
  }

  private async onMessage(msg: { type?: string; id?: string; clicks?: number }): Promise<void> {
    const root = getProjectConfig().projectDir;
    if (!root || !this.view) return;
    if (msg.type === 'ready' || msg.type === 'refresh') {
      await this.refresh(root);
      return;
    }
    if (msg.type === 'open' && msg.id) {
      const source = previewRectForPath(root, msg.id);
      const file = source && annotatedImageFile(source.imagePath, source.bbox, this.thumbDir);
      if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      else void vscode.window.showWarningMessage(tr('Failed to generate annotated image: source image could not be decoded or was missing'));
      return;
    }
    if (msg.type !== 'activate' || !msg.id) return;
    const text = msg.clicks === 2 ? `self.pos.${msg.id}` : `self.pos.${msg.id}.to_box()`;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      await vscode.env.clipboard.writeText(text);
      return;
    }
    await editor.edit((builder) => {
      editor.selections.forEach((selection) => builder.insert(selection.active, text));
    });
  }

  /**
   * 每个 box path 展示原图中 bbox 外扩后的区域，并画红框标明位置。
   * 来源是 authoring 的 Pixel bbox + 原图；运行时独有的 path 拿不到来源图，
   * 保持无图占位（不做 normalized → Pixel 的死转换）。裁剪、内容 hash 缓存、
   * 缓存、裁剪和标记与查看原图 / Hover 共用。
   */
  private async refresh(root: string): Promise<void> {
    const view = this.view;
    if (!view) return;
    const gen = ++this.generation;
    const templates = templatesDirectory(root);
    const args = runtimeArgs(root);
    const runtime = readRuntimeFile(root, args.declared, args.fromConfig);
    const authoring = readAuthoringFile(root, templates);
    const sourceByPath = new Map(authoring.boxes.map((box) => [box.path, box]));
    const rows = runtime.boxes.map((box) => {
      const label = `self.pos.${box.path}.to_box()`;
      const source = sourceByPath.get(box.path);
      const fileName = source?.image;
      const imagePath = fileName ? path.join(root, templates, fileName) : '';
      const bbox = source && imagePath && fs.existsSync(imagePath) ? source.bbox : undefined;
      return { id: box.path, label, imagePath: bbox ? imagePath : '', bbox };
    });
    void view.webview.postMessage({ type: 'rows', rows });
    // 分批补推缩略图（与素材面板同一条管线）
    for (let i = 0; i < rows.length; i += 8) {
      if (gen !== this.generation || !view) return;
      const batch = rows.slice(i, i + 8).filter((row) => row.imagePath && row.bbox);
      const thumbs: Array<{ id: string; url: string }> = [];
      for (const row of batch) {
        const file = annotatedImageFile(row.imagePath, row.bbox!, this.thumbDir);
        if (gen !== this.generation || !view) return;
        if (!file) continue;
        thumbs.push({ id: row.id, url: view.webview.asWebviewUri(vscode.Uri.file(file)).toString(true) });
      }
      if (thumbs.length) void view.webview.postMessage({ type: 'thumbs', items: thumbs });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/** Same editor/controller as template annotations; only the source file and name rule differ. */
export function openBoxEditor(extensionUri: vscode.Uri, data: TemplateAssetData, imagePath: string, thumbDir = ''): void {
  const boxes = data.fileName === AUTHORING_FILE_NAME ? data : new TemplateAssetData(data.root, AUTHORING_FILE_NAME);
  AnnotationPanel.show(extensionUri, boxes, thumbDir || boxes.templatesDir, imagePath, boxes.listImages(), () => {}, true);
}

/**
 * 框路径的预览来源：authoring 的原图与 Pixel bbox。
 * 运行时独有的 path 没有来源图，不做 normalized → Pixel 的死转换。
 */
export function previewRectForPath(root: string, boxPath: string): { imagePath: string; bbox: [number, number, number, number] } | undefined {
  const templates = templatesDirectory(root);
  const authoring = readAuthoringFile(root, templates);
  const source = authoring.boxes.find((box) => box.path === boxPath);
  const fileName = source?.image;
  if (!fileName) return undefined;
  const imagePath = path.join(root, templates, fileName);
  if (!fs.existsSync(imagePath)) return undefined;
  const size = readImageSize(fs.readFileSync(imagePath));
  if (!size) return undefined;
  const pixel: PixelBox = { x: source.bbox[0], y: source.bbox[1], w: source.bbox[2], h: source.bbox[3] };
  if (pixel.w <= 0 || pixel.h <= 0) return undefined;
  return { imagePath, bbox: [pixel.x, pixel.y, pixel.w, pixel.h] };
}

export function posPaths(root: string): string[] {
  const args = runtimeArgs(root);
  return readRuntimeFile(root, args.declared, args.fromConfig).boxes.map((box) => box.path);
}
