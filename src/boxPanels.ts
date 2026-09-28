import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { annotationHtml } from './annotationPanel';
import {
  boxesForImage,
  publishRuntime,
  readAuthoringFile,
  readRuntimeFile,
  replaceImageBoxes,
  runtimeOnlyPaths,
  EditedBox,
} from './boxResourceStore';
import { BoxRect, rectToPixel } from './boxResourcePure';
import { probedBoxesJson } from './cocoFeaturePath';
import { injectWebviewLocalization, tr } from './localization';
import { boxesRuntimeSetting, templatesDirectory } from './projectConfig';
import { readImageSize } from './pngCrop';
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

export class BoxAssetViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'okScriptToolkit.boxAssets';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly data: TemplateAssetData,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = panelHtml(webviewView.webview, this.extensionUri, 'assets');
    webviewView.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
  }

  private root(): string {
    return getProjectConfig().projectDir;
  }

  private async onMessage(msg: { type?: string; id?: string; clicks?: number }): Promise<void> {
    const root = this.root();
    if (!root || !this.view) return;
    if (msg.type === 'ready' || msg.type === 'refresh') {
      this.data.load();
      const authoring = readAuthoringFile(root, templatesDirectory(root));
      const rows = this.data.listImages().map((imagePath) => ({
        id: imagePath,
        label: `${path.basename(imagePath)} (${boxesForImage(authoring, path.basename(imagePath)).length})`,
      }));
      void this.view.webview.postMessage({ type: 'rows', rows });
      return;
    }
    if (msg.type === 'activate' && msg.clicks === 2 && msg.id) {
      openBoxEditor(this.extensionUri, this.data, msg.id);
      return;
    }
    if (msg.type === 'publish') {
      const templates = templatesDirectory(root);
      const args = runtimeArgs(root);
      const authoring = readAuthoringFile(root, templates);
      const runtime = readRuntimeFile(root, args.declared, args.fromConfig);
      const dropped = runtimeOnlyPaths(authoring, runtime);
      if (dropped.length) {
        const answer = await vscode.window.showWarningMessage(
          dropped.join('\n'),
          { modal: true },
          'Publish',
        );
        if (answer !== 'Publish') return;
      }
      publishRuntime(root, templates, args.declared, args.fromConfig);
      void this.onMessage({ type: 'refresh' });
    }
  }
}

export class BoxGalleryViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'okScriptToolkit.boxGallery';
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = panelHtml(webviewView.webview, this.extensionUri, 'gallery');
    webviewView.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
  }

  private async onMessage(msg: { type?: string; id?: string; clicks?: number }): Promise<void> {
    const root = getProjectConfig().projectDir;
    if (!root || !this.view) return;
    if (msg.type === 'ready' || msg.type === 'refresh') {
      const args = runtimeArgs(root);
      const rows = readRuntimeFile(root, args.declared, args.fromConfig).boxes.map((box) => ({
        id: box.path,
        label: `self.pos.${box.path}.to_box()`,
      }));
      void this.view.webview.postMessage({ type: 'rows', rows });
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
}

class BoxEditor {
  private image = '';
  private images: string[] = [];
  private originals = new Map<number, BoxRect>();

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
    const buf = fs.readFileSync(this.image);
    const size = readImageSize(buf);
    const authoring = readAuthoringFile(root, this.templatesDir);
    this.originals.clear();
    const annotations = boxesForImage(authoring, path.basename(this.image)).map((box, index) => {
      const pixel = size ? rectToPixel(box.rect, size.width, size.height) : undefined;
      const id = index + 1;
      if (pixel) this.originals.set(id, box.rect);
      return pixel ? { id, category: box.path, ...pixel } : undefined;
    }).filter((item): item is { id: number; category: string; x: number; y: number; w: number; h: number } => !!item);
    const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png';
    void this.panel.webview.postMessage({
      type: 'config',
      boxMode: true,
      keybindings: vscode.workspace.getConfiguration('okScriptToolkit').get('annotationKeybindings'),
      copyCoordsSpace: vscode.workspace.getConfiguration('okScriptToolkit').get('copyCoordsSpace', true),
    });
    void this.panel.webview.postMessage({
      type: 'load',
      imagePath: this.image,
      imageBase64: `data:${mime};base64,${buf.toString('base64')}`,
      annotations,
      allCategories: {},
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
      original: this.originals.get(ann.id),
    }));
    const error = replaceImageBoxes(this.rootDir, this.templatesDir, path.basename(this.image), size.width, size.height, edited);
    if (error) void vscode.window.showErrorMessage(tr('Could not save the box resource.'));
  }
}

let boxEditorPanel: vscode.WebviewPanel | undefined;
let boxEditor: BoxEditor | undefined;

export function openBoxEditor(extensionUri: vscode.Uri, data: TemplateAssetData, imagePath: string): void {
  const images = data.listImages();
  const root = getProjectConfig().projectDir;
  const templatesDir = templatesDirectory(root);
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
  boxEditorPanel = panel;
  boxEditor.open(imagePath, images);
  panel.onDidDispose(() => {
    boxEditorPanel = undefined;
    boxEditor = undefined;
  });
}

export function previewRectForPath(root: string, boxPath: string): { imagePath: string; bbox: [number, number, number, number] } | undefined {
  const authoring = readAuthoringFile(root, templatesDirectory(root)).boxes.find((box) => box.path === boxPath);
  const runtime = readRuntimeFile(root, runtimeArgs(root).declared, runtimeArgs(root).fromConfig).boxes.find((box) => box.path === boxPath);
  const rect = runtime?.rect || authoring?.rect;
  if (!authoring || !rect) return undefined;
  const imagePath = path.join(root, templatesDirectory(root), authoring.image);
  if (!fs.existsSync(imagePath)) return undefined;
  const size = readImageSize(fs.readFileSync(imagePath));
  const pixel = size ? rectToPixel(rect, size.width, size.height) : undefined;
  if (!pixel) return undefined;
  return { imagePath, bbox: [pixel.x, pixel.y, pixel.w, pixel.h] };
}

export function posPaths(root: string): string[] {
  const args = runtimeArgs(root);
  return readRuntimeFile(root, args.declared, args.fromConfig).boxes.map((box) => box.path);
}
