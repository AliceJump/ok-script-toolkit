import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { annotationHtml } from './annotationPanel';
import {
  boxesForImage,
  readAuthoringFile,
  readRuntimeFile,
  replaceImageBoxes,
  EditedBox,
} from './boxResourceStore';
import { BOX_PATH_SEGMENT_SOURCE, PixelBox, RESERVED_BOX_ROOTS, rectToPixel } from './boxResourcePure';
import { probedBoxesJson } from './cocoFeaturePath';
import { injectWebviewLocalization, tr } from './localization';
import { boxesRuntimeSetting, templatesDirectory } from './projectConfig';
import { cropTemplateThumbFileAsync, readImageSize, THUMB_HEIGHT } from './pngCrop';
import { getProjectConfig } from './screenshotCapture';
import { TemplateAssetData } from './templateAssetData';
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
  }

  private async onMessage(msg: { type?: string; id?: string; clicks?: number }): Promise<void> {
    const root = getProjectConfig().projectDir;
    if (!root || !this.view) return;
    if (msg.type === 'ready' || msg.type === 'refresh') {
      await this.refresh(root);
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
   * 框管理对标模板管理：每个 box path 一张**bbox 裁剪后的资源缩略图**。
   * 来源优先 authoring（Pixel bbox + 原图），运行时独有的 path 退回
   * normalized → Pixel（Runtime Preview 转换层）。裁剪、内容 hash 缓存、
   * 失败处理全部复用 `cropTemplateThumbFileAsync`，不另造预览系统。
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
      let bbox: [number, number, number, number] | undefined;
      if (source && fs.existsSync(imagePath)) {
        bbox = source.bbox;
      } else if (imagePath && fs.existsSync(imagePath)) {
        // 运行时独有的 path：Runtime Preview 允许 normalized → Pixel
        const size = readImageSize(fs.readFileSync(imagePath));
        const pixel = size ? rectToPixel(box.rect, size.width, size.height) : undefined;
        bbox = pixel ? [pixel.x, pixel.y, pixel.w, pixel.h] : undefined;
      }
      return { id: box.path, label, imagePath: bbox ? imagePath : '', bbox };
    });
    void view.webview.postMessage({ type: 'rows', rows });
    // 分批补推缩略图（与素材面板同一条管线）
    for (let i = 0; i < rows.length; i += 8) {
      if (gen !== this.generation || !view) return;
      const batch = rows.slice(i, i + 8).filter((row) => row.imagePath && row.bbox);
      const thumbs: Array<{ id: string; url: string }> = [];
      for (const row of batch) {
        const file = await cropTemplateThumbFileAsync(row.imagePath, row.bbox!, this.thumbDir, THUMB_HEIGHT);
        if (gen !== this.generation || !view) return;
        if (!file) continue;
        thumbs.push({ id: row.id, url: view.webview.asWebviewUri(vscode.Uri.file(file)).toString(true) });
      }
      if (thumbs.length) void view.webview.postMessage({ type: 'thumbs', items: thumbs });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

class BoxEditor {
  private image = '';
  private images: string[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly rootDir: string,
    private readonly templatesDir: string,
  ) {
    panel.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
  }

  open(imagePath: string, imageList: string[]): void {
    this.image = imagePath;
    this.images = imageList;
    void this.load();
  }

  private async load(): Promise<void> {
    const root = this.rootDir;
    let size: { width: number; height: number } | undefined;
    let imageBase64 = '';
    try {
      const buf = fs.readFileSync(this.image);
      size = readImageSize(buf);
      const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png';
      imageBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      // 图片读不出来：发空图，让画布显示加载失败而不是宿主崩掉
    }
    const authoring = readAuthoringFile(root, this.templatesDir);
    const annotations = boxesForImage(authoring, path.basename(this.image)).map((box, index) => ({
      id: index + 1,
      category: box.path,
      x: box.bbox[0],
      y: box.bbox[1],
      w: box.bbox[2],
      h: box.bbox[3],
    }));
    void this.panel.webview.postMessage({
      type: 'config',
      boxMode: true,
      keybindings: vscode.workspace.getConfiguration('okScriptToolkit').get('annotationKeybindings'),
      copyCoordsSpace: vscode.workspace.getConfiguration('okScriptToolkit').get('copyCoordsSpace', true),
      // 与标注编辑器同一份规则（「生成框」输入框的即时校验要用）。
      boxPathRule: {
        segment: BOX_PATH_SEGMENT_SOURCE,
        reservedRoots: [...RESERVED_BOX_ROOTS],
      },
    });
    void this.panel.webview.postMessage({
      type: 'load',
      imagePath: this.image,
      imageBase64,
      annotations,
      // 跨图片 path 占用：path → 所属图片。bbox 对话框的查重吃这张表，
      // 不再传空的 allCategories: {}。
      allCategories: boxPathOccupancy(authoring),
      currentIndex: Math.max(0, this.images.indexOf(this.image)),
      totalImages: this.images.length,
      filename: path.basename(this.image),
    });
  }

  private async onMessage(msg: {
    type?: string;
    annotations?: Array<{ id: number; category: string; x: number; y: number; w: number; h: number }>;
    index?: number;
  }): Promise<void> {
    if (msg.type === 'ready') {
      await this.load();
      return;
    }
    if (msg.type === 'navigate' && msg.index !== undefined) {
      const next = this.images[msg.index];
      if (next) {
        this.image = next;
        await this.load();
      }
      return;
    }
    if (msg.type !== 'save' || !msg.annotations) return;
    let size: { width: number; height: number } | undefined;
    try {
      size = readImageSize(fs.readFileSync(this.image));
    } catch {
      void vscode.window.showErrorMessage(tr('Could not save the box resource.'));
      return;
    }
    if (!size) return;
    const edited: EditedBox[] = msg.annotations.map((ann) => ({
      path: ann.category,
      x: ann.x,
      y: ann.y,
      w: ann.w,
      h: ann.h,
    }));
    const error = replaceImageBoxes(this.rootDir, this.templatesDir, path.basename(this.image), size.width, size.height, edited);
    if (error) void vscode.window.showErrorMessage(tr('Could not save the box resource.'));
  }
}

let boxEditorPanel: vscode.WebviewPanel | undefined;
let boxEditor: BoxEditor | undefined;

export function openBoxEditor(extensionUri: vscode.Uri, data: TemplateAssetData, imagePath: string): void {
  const images = data.listImages();
  // 根与模板目录都取自 data 自己的归属，不从全局配置重新推导 ——
  // 模板数据可能来自另一个仓库，用错根会读到别人的约定文件。
  const root = data.root;
  const templatesDir = data.templatesDir;
  if (boxEditorPanel && boxEditor) {
    boxEditorPanel.reveal();
    boxEditor.open(imagePath, images);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'okScriptToolkitBoxAnnotation',
    path.basename(imagePath),
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri, vscode.Uri.file(data.templatesDir)] },
  );
  panel.webview.html = annotationHtml(panel.webview.cspSource, extensionUri, panel.webview);
  boxEditor = new BoxEditor(panel, root, templatesDir);
  boxEditor.open(imagePath, images);
  panel.onDidDispose(() => {
    boxEditorPanel = undefined;
    boxEditor = undefined;
  });
}

/**
 * Runtime Preview：运行时 normalized rect 按原图尺寸转回 Pixel 裁剪预览。
 * authoring 里已有 Pixel bbox，优先直取 —— 这是转换层的合法用途。
 */
export function previewRectForPath(root: string, boxPath: string): { imagePath: string; bbox: [number, number, number, number] } | undefined {
  const templates = templatesDirectory(root);
  const authoring = readAuthoringFile(root, templates);
  const runtime = readRuntimeFile(root, runtimeArgs(root).declared, runtimeArgs(root).fromConfig).boxes.find((box) => box.path === boxPath);
  const source = authoring.boxes.find((box) => box.path === boxPath);
  const fileName = source?.image;
  if (!fileName) return undefined;
  const imagePath = path.join(root, templates, fileName);
  if (!fs.existsSync(imagePath)) return undefined;
  const size = readImageSize(fs.readFileSync(imagePath));
  if (!size) return undefined;
  const pixel: PixelBox | undefined = source
    ? { x: source.bbox[0], y: source.bbox[1], w: source.bbox[2], h: source.bbox[3] }
    : runtime
      ? rectToPixel(runtime.rect, size.width, size.height)
      : undefined;
  if (!pixel || pixel.w <= 0 || pixel.h <= 0) return undefined;
  return { imagePath, bbox: [pixel.x, pixel.y, pixel.w, pixel.h] };
}

export function posPaths(root: string): string[] {
  const args = runtimeArgs(root);
  return readRuntimeFile(root, args.declared, args.fromConfig).boxes.map((box) => box.path);
}
