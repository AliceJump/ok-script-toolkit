import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureEditorTracker, insertIntoPythonEditor } from './pythonEditor';
import { FeatureData } from './featureData';
import { annotatedImageFile, cropTemplateThumbFileAsync, openAnnotatedImage, THUMB_HEIGHT } from './pngCrop';
import { featureAliases } from './providers';
import { injectWebviewLocalization, tr } from './localization';
import { applySharedAssets, getNonce } from './webviewHtml';
import { readAuthoringFile } from './boxResourceStore';
import { readPoints } from './pointResourceStore';
import { templatesDirectory } from './projectConfig';

export type ResourcePreviewMode = 'template' | 'rect' | 'point';

interface ResourceMeta {
  name: string;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  imagePath: string;
  kind: ResourcePreviewMode;
  expression: string;
}

export function primaryFeatureAlias(): string {
  const aliases = featureAliases();
  return aliases.length ? aliases[0] : 'fL';
}

const liveControllers = new Set<GalleryController>();

export function repaintAllGalleries(): void {
  for (const c of [...liveControllers]) void c.update();
}

function clampContextBox(
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number, number, number] {
  const contextW = Math.max(64, Math.round(width * 0.12));
  const contextH = Math.max(48, Math.round(height * 0.12));
  const left = Math.max(0, Math.min(width - contextW, Math.round(x - contextW / 2)));
  const top = Math.max(0, Math.min(height - contextH, Math.round(y - contextH / 2)));
  return [left, top, Math.min(contextW, width), Math.min(contextH, height)];
}

class GalleryController {
  private generation = 0;
  private disposed = false;
  private mode: ResourcePreviewMode = 'template';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly features: FeatureData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly extensionUri: vscode.Uri,
  ) {
    ensureEditorTracker();
    liveControllers.add(this);
    this.disposables.push(webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }));
  }

  attachHtml(): void {
    this.webview.html = galleryHtml(this.webview, this.extensionUri);
  }

  private templateMetas(): ResourceMeta[] {
    this.features.refresh(true);
    return [...this.features.all()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ft) => ({
        name: ft.name,
        width: ft.width,
        height: ft.height,
        bbox: [...ft.bbox],
        imagePath: ft.imagePath,
        kind: 'template' as const,
        expression: `${primaryFeatureAlias()}.${ft.name}`,
      }));
  }

  private rectMetas(): ResourceMeta[] {
    const root = this.features.root;
    const directory = templatesDirectory(root);
    const authoring = readAuthoringFile(root, directory);
    const sizeByFile = new Map(authoring.images.map(image => [image.file.toLowerCase(), image]));
    return authoring.boxes
      .map((box): ResourceMeta | undefined => {
        const image = sizeByFile.get(box.image.toLowerCase());
        if (!image) return undefined;
        return {
          name: box.path,
          width: box.bbox[2],
          height: box.bbox[3],
          bbox: box.bbox,
          imagePath: path.join(root, directory, box.image),
          kind: 'rect',
          expression: `self.pos.${box.path}.to_box()`,
        };
      })
      .filter((item): item is ResourceMeta => item !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private pointMetas(): ResourceMeta[] {
    const root = this.features.root;
    const directory = templatesDirectory(root);
    const result = readPoints(root, directory);
    if (result.errors.length) return [];
    const sizeByFile = new Map(result.file.images.map(image => [image.file.toLowerCase(), image]));
    return result.file.points
      .map((point): ResourceMeta | undefined => {
        const image = sizeByFile.get(point.image.toLowerCase());
        if (!image) return undefined;
        return {
          name: point.path,
          width: image.width,
          height: image.height,
          bbox: clampContextBox(point.x, point.y, image.width, image.height),
          imagePath: path.join(root, directory, point.image),
          kind: 'point',
          expression: `self.pos.${point.path}`,
        };
      })
      .filter((item): item is ResourceMeta => item !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private metas(mode: ResourcePreviewMode = this.mode): ResourceMeta[] {
    if (mode === 'rect') return this.rectMetas();
    if (mode === 'point') return this.pointMetas();
    return this.templateMetas();
  }

  async update(): Promise<void> {
    if (this.disposed || !this.isVisible()) return;
    const gen = ++this.generation;
    const mode = this.mode;
    const metas = this.metas(mode);
    await this.webview.postMessage({ type: 'resources', mode, resources: metas });
    if (gen !== this.generation || this.disposed || mode !== this.mode) return;

    const batchSize = 6;
    for (let i = 0; i < metas.length; i += batchSize) {
      if (gen !== this.generation || this.disposed || mode !== this.mode) return;
      const items: { name: string; url: string }[] = [];
      for (const meta of metas.slice(i, i + batchSize)) {
        const file = await cropTemplateThumbFileAsync(meta.imagePath, meta.bbox, this.thumbDir, THUMB_HEIGHT);
        if (gen !== this.generation || this.disposed || mode !== this.mode) return;
        if (!file) continue;
        items.push({ name: meta.name, url: this.webview.asWebviewUri(vscode.Uri.file(file)).toString(true) });
      }
      if (items.length) {
        if (gen !== this.generation || this.disposed || mode !== this.mode) return;
        await this.webview.postMessage({ type: 'thumbs', mode, items });
      }
      if (gen !== this.generation || this.disposed || mode !== this.mode) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (gen === this.generation && !this.disposed && mode === this.mode) {
      void this.webview.postMessage({ type: 'thumbDone', mode });
    }
  }

  private async onMessage(msg: {
    type?: string;
    mode?: ResourcePreviewMode;
    name?: string;
    expression?: string;
    imagePath?: string;
    bbox?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.update();
        break;
      case 'switchMode':
        if (msg.mode && ['template', 'rect', 'point'].includes(msg.mode)) {
          this.mode = msg.mode;
          await this.update();
        }
        break;
      case 'copy':
        if (typeof msg.expression === 'string' && msg.expression) {
          await vscode.env.clipboard.writeText(msg.expression);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.expression }));
        }
        break;
      case 'insert':
        if (typeof msg.expression === 'string' && msg.expression) {
          ensureEditorTracker();
          await insertIntoPythonEditor(msg.expression);
        }
        break;
      case 'open':
        if (typeof msg.name === 'string') {
          const meta = this.metas(this.mode).find(item => item.name === msg.name);
          if (meta) await this.openOriginalWithMarker(meta);
        }
        break;
      default:
        break;
    }
  }

  private async openOriginalWithMarker(meta: ResourceMeta): Promise<void> {
    try {
      const file = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: tr('ok-script-toolkit: Generating source image annotation…') },
        async () => meta.kind === 'template'
          ? openAnnotatedImage(meta.imagePath, meta.name, meta.bbox, this.thumbDir, this.features.root)
          : annotatedImageFile(meta.imagePath, meta.bbox, this.thumbDir),
      );
      if (!file) {
        void vscode.window.showWarningMessage(tr('Failed to generate annotated image: source image could not be decoded or was missing'));
        return;
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    } catch { /* open failure is non-fatal */ }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    liveControllers.delete(this);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

export class TemplateGalleryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.templateGallery';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly features: FeatureData,
    private readonly thumbDir: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.thumbDir), this.extensionUri],
    };
    const controller = new GalleryController(view.webview, this.features, this.thumbDir, () => view.visible, this.extensionUri);
    controller.attachHtml();
    view.onDidChangeVisibility(() => { if (view.visible) void controller.update(); });
    view.onDidDispose(() => controller.dispose());
  }
}

export class TemplateGalleryPanel {
  static current: TemplateGalleryPanel | undefined;

  static show(features: FeatureData, thumbDir: string, extensionUri: vscode.Uri): void {
    if (TemplateGalleryPanel.current) {
      TemplateGalleryPanel.current.panel.reveal();
      void TemplateGalleryPanel.current.controller.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okScriptToolkitTemplates',
      tr('Resource Preview'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.file(thumbDir), extensionUri],
      },
    );
    const controller = new GalleryController(panel.webview, features, thumbDir, () => panel.visible, extensionUri);
    TemplateGalleryPanel.current = new TemplateGalleryPanel(panel, controller);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, readonly controller: GalleryController) {
    controller.attachHtml();
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) void this.controller.update(); });
    panel.onDidDispose(() => {
      this.controller.dispose();
      TemplateGalleryPanel.current = undefined;
    });
  }
}

function galleryHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const file = path.join(extensionUri.fsPath, 'media', 'templatePanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'templatePanel', name)).toString(true);
  return injectWebviewLocalization(applySharedAssets(webview, extensionUri,
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  ));
}
