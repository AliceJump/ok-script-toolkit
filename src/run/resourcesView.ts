import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FeatureData } from '../featureData';
import { injectWebviewLocalization, tr } from '../localization';
import { AnnotationPanel } from '../annotationPanel';
import { TemplateAssetData } from '../templateAssetData';
import { TemplateAssetPanel } from '../templateAssetPanel';
import { TempScreenshotStore } from '../tempScreenshotStore';
import { applySharedAssets, errorPage, getNonce } from '../webviewHtml';
import { countUnpublished, diffPublishSets } from './publishDiff';
import { primaryFeatureAlias } from '../templatePanel';
import { templatesDirectory } from '../projectConfig';

type LibraryMode = 'draft' | 'published';

/** Unified Resources view: inbox (temp shots) + draft/published library. */
export class ResourcesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'okScriptToolkit.resources';

  private view?: vscode.WebviewView;
  private mode: LibraryMode = 'draft';
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly assets: TemplateAssetData,
    private readonly features: FeatureData,
    private readonly tempStore: TempScreenshotStore,
    private readonly thumbDir: string,
  ) {
    this.subs.push(tempStore.onChange(() => void this.pushInbox()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media', 'resources'),
        vscode.Uri.joinPath(this.extensionUri, 'media', 'shared'),
        vscode.Uri.file(this.tempStore.directory),
        vscode.Uri.file(this.thumbDir),
        vscode.Uri.file(this.assets.root || ''),
      ].filter((u) => u.fsPath),
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          await this.pushInbox();
          await this.pushLibrary();
          break;
        case 'setMode':
          this.mode = msg.mode === 'published' ? 'published' : 'draft';
          await this.pushLibrary();
          break;
        case 'annotateInbox':
          if (msg.id) await this.annotateInbox(String(msg.id));
          break;
        case 'deleteInbox':
          if (msg.id) this.tempStore.remove(String(msg.id));
          break;
        case 'openAnnotation':
          await this.openAnnotation(msg.imagePath || msg.name);
          break;
        case 'insert':
          if (msg.expression) {
            await vscode.commands.executeCommand('okScriptToolkit.insertResourceReference', String(msg.expression));
          }
          break;
        case 'copy':
          if (msg.expression) await vscode.env.clipboard.writeText(String(msg.expression));
          break;
        case 'publish':
          await TemplateAssetPanel.publish(this.assets, this.thumbDir, this.extensionUri, this.tempStore);
          await this.pushLibrary();
          break;
        default:
          break;
      }
    });
  }

  /** 在资源视图里定位某个资源：切到已发布并把搜索框填成名字 */
  reveal(name: string): void {
    this.mode = 'published';
    void this.pushLibrary().then(() => this.view?.webview.postMessage({ type: 'reveal', name }));
  }

  async captureToInbox(): Promise<void> {
    const { captureGameWindow } = await import('../screenshotCapture');
    const out = this.tempStore.newFilePath();
    const result = await captureGameWindow(out);
    if (!result.ok) {
      void vscode.window.showErrorMessage(result.error || tr('Screenshot failed'));
      return;
    }
    this.tempStore.register(out);
    void vscode.commands.executeCommand(`${ResourcesViewProvider.viewType}.focus`);
    await this.pushInbox();
  }

  private async annotateInbox(id: string): Promise<void> {
    const shot = this.tempStore.get(id);
    if (!shot) return;
    // Reuse temp→assets flow used by the old temp panel when possible.
    const destDir = path.isAbsolute(templatesDirectory(this.assets.root))
      ? templatesDirectory(this.assets.root)
      : path.join(this.assets.root, templatesDirectory(this.assets.root));
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch { /* ignore */ }
    const dest = path.join(destDir, path.basename(shot.filePath));
    try {
      fs.copyFileSync(shot.filePath, dest);
    } catch (e) {
      void vscode.window.showErrorMessage(tr('Failed to add screenshot to drafts: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
      return;
    }
    this.assets.load();
    AnnotationPanel.show(this.extensionUri, this.assets, this.thumbDir, dest, this.assets.listImages(), () => {
      void this.pushLibrary();
    });
  }

  private async openAnnotation(imagePath: string | undefined): Promise<void> {
    if (!imagePath) return;
    this.assets.load();
    const images = this.assets.listImages();
    const resolved = images.find((image) => path.resolve(image) === path.resolve(imagePath))
      || images.find((image) => path.basename(image) === path.basename(imagePath));
    if (!resolved) {
      void vscode.window.showWarningMessage(tr('This image is not in Annotation Management yet. Add it there first.'));
      return;
    }
    AnnotationPanel.show(this.extensionUri, this.assets, this.thumbDir, resolved, images, () => {
      void this.pushLibrary();
    });
  }

  private async pushInbox(): Promise<void> {
    const webview = this.view?.webview;
    if (!webview) return;
    const items = this.tempStore.list().map((shot) => ({
      id: shot.id,
      name: shot.name,
      url: webview.asWebviewUri(vscode.Uri.file(shot.filePath)).toString(true),
    }));
    void webview.postMessage({ type: 'inbox', items });
    if (this.view) {
      this.view.badge = items.length
        ? { value: items.length, tooltip: tr('Inbox screenshots') }
        : undefined;
    }
  }

  private async pushLibrary(): Promise<void> {
    const webview = this.view?.webview;
    if (!webview) return;
    this.assets.load();
    this.features.refresh(true);
    const alias = primaryFeatureAlias();
    const draftImages = this.assets.listImages();
    // 草稿按模板名（标注类别）列出，和已发布的 fL.<名字> 对得上；
    // 不比较 bbox：发布会裁切 + 装箱，草稿与运行时坐标系不同（见 publishPreview.ts）
    const draftItems: { name: string; imagePath: string; kind: 'template'; expression: string; width?: number; height?: number }[] = [];
    const seen = new Set<string>();
    for (const imagePath of draftImages) {
      for (const ann of this.assets.getAnnotationsForImage(imagePath, true)) {
        if (!ann.categoryName || seen.has(ann.categoryName)) continue;
        seen.add(ann.categoryName);
        draftItems.push({
          name: ann.categoryName,
          imagePath,
          kind: 'template',
          expression: `${alias}.${ann.categoryName}`,
          width: ann.bbox?.[2] !== undefined ? Math.round(ann.bbox[2]) : undefined,
          height: ann.bbox?.[3] !== undefined ? Math.round(ann.bbox[3]) : undefined,
        });
      }
    }
    const published = [...this.features.all()].map((ft) => ({
      name: ft.name,
      imagePath: ft.imagePath,
      kind: 'template' as const,
      expression: `${alias}.${ft.name}`,
      width: ft.width,
      height: ft.height,
    }));
    const diffs = diffPublishSets(
      draftItems.map((d) => ({ name: d.name })),
      published.map((p) => ({ name: p.name })),
    );
    const statuses = Object.fromEntries(diffs.map((d) => [d.name, d.status]));
    const unpublished = countUnpublished(diffs);
    const items = this.mode === 'draft' ? draftItems : published;
    void webview.postMessage({
      type: 'library',
      mode: this.mode,
      items,
      statuses,
      unpublished,
    });
    // Thumbs: prefer annotated crop when present
    const thumbItems: { name: string; url: string }[] = [];
    for (const it of items.slice(0, 40)) {
      const src = it.imagePath;
      if (src && fs.existsSync(src)) {
        thumbItems.push({ name: it.name, url: webview.asWebviewUri(vscode.Uri.file(src)).toString(true) });
      }
    }
    if (thumbItems.length) void webview.postMessage({ type: 'thumbs', items: thumbItems });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'resources', 'index.html');
    let html = '';
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch (e) {
      return errorPage(tr('Error'), tr('Unable to read view file: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    const resource = (name: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'resources', name),
    ).toString(true);
    return injectWebviewLocalization(applySharedAssets(webview, this.extensionUri, html
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('resources.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
    ));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
