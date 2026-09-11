import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { AnnotationPanel } from './annotationPanel';
import { cropTemplateThumbFileAsync, THUMB_HEIGHT } from './pngCrop';
import { injectWebviewLocalization, tr } from './localization';
import { TempScreenshotStore } from './tempScreenshotStore';
import { captureGameWindow } from './screenshotCapture';
import { takePendingDrag } from './tempDrag';

/* ---------------- 控制器 ---------------- */

const liveControllers = new Set<AssetGalleryController>();

export function repaintAllAssetGalleries(): void {
  for (const c of [...liveControllers]) void c.update();
}

class AssetGalleryController {
  private generation = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly extensionUri: vscode.Uri,
    private readonly globalState?: vscode.Memento,
    private readonly tempStore?: TempScreenshotStore,
  ) {
    liveControllers.add(this);
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
    );
  }

  attachHtml(): void {
    this.webview.html = assetGalleryHtml(this.webview, this.extensionUri);
  }

  async update(): Promise<void> {
    if (this.disposed || !this.isVisible()) return;
    const gen = ++this.generation;

    this.data.load();
    const imageFiles = this.data.listImages();

    // 构建元数据
    const metas = imageFiles.map((imgPath) => {
      const cats = this.data.getCategoriesForImage(imgPath);
      const entry = this.data.getImageEntryForPath(imgPath);
      return {
        name: path.basename(imgPath),
        imagePath: imgPath,
        width: entry?.width ?? 0,
        height: entry?.height ?? 0,
        categories: cats,
      };
    });

    await this.webview.postMessage({ type: 'templates', templates: metas });
    if (gen !== this.generation) return;

    // 分批推送缩略图
    const batchSize = 8;
    for (let i = 0; i < metas.length; i += batchSize) {
      if (gen !== this.generation || this.disposed) return;
      const items: { name: string; url: string }[] = [];
      for (const meta of metas.slice(i, i + batchSize)) {
        const entry = this.data.getImageEntryForPath(meta.imagePath);
        const bbox: [number, number, number, number] = [0, 0, entry?.width ?? 100, entry?.height ?? 100];
        const file = await cropTemplateThumbFileAsync(meta.imagePath, bbox, this.thumbDir, THUMB_HEIGHT);
        if (!file) continue;
        items.push({
          name: meta.name,
          url: this.webview.asWebviewUri(vscode.Uri.file(file)).toString(true),
        });
      }
      if (items.length) {
        await this.webview.postMessage({ type: 'thumbs', items });
      }
      if (gen !== this.generation || this.disposed) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (gen === this.generation && !this.disposed) {
      void this.webview.postMessage({ type: 'thumbDone' });
    }
  }

  private async onMessage(msg: {
    type?: string;
    name?: string;
    imagePath?: string;
    command?: string;
    base64Png?: string;
    tempId?: string;
    dragKind?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.update();
        break;
      case 'openAnnotation': {
        if (msg.imagePath) {
          const imageList = this.data.listImages();
          AnnotationPanel.show(this.extensionUri, this.data, this.thumbDir, msg.imagePath, imageList, () => {
            void this.update();
          });
        }
        break;
      }
      case 'screenshot': {
        // 从剪贴板粘贴截图
        await this.handleScreenshot();
        break;
      }
      case 'saveToAssets': {
        await this.handleSaveToAssets();
        break;
      }
      case 'deleteImage': {
        if (msg.imagePath) {
          await this.handleDeleteImage(msg.imagePath);
        }
        break;
      }
      case 'importFile': {
        await this.handleImportFile();
        break;
      }
      case 'dropTemp': {
        // 优先使用 dataTransfer 里携带的 id；跨 origin 读不到时回退到宿主中继
        const id = msg.tempId || takePendingDrag();
        if (id) await this.handleDropTemp(id);
        break;
      }
    }
  }

  /* ---------- 截图处理 ---------- */
  private async handleScreenshot(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }

    const outputDir = path.join(folder.uri.fsPath, 'ok_templates');
    fs.mkdirSync(outputDir, { recursive: true });

    // Generate filename with timestamp
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const outputPath = path.join(outputDir, `screenshot_${ts}.png`);

    const outcome = await captureGameWindow(outputPath);
    if (!outcome.ok) {
      if (outcome.reason === 'noScript') {
        void vscode.window.showErrorMessage(tr('Screenshot script not found. capture_game_window.py is missing from the extension.'));
      } else if (outcome.reason === 'failed') {
        void vscode.window.showErrorMessage(tr('Screenshot failed: {error}', { error: outcome.error || '' }));
      }
      return;
    }

    // Add to COCO data
    try {
      await TemplateAssetData.addImageToCoco(outputPath);
      void vscode.window.showInformationMessage(tr('Screenshot saved: {name}', { name: path.basename(outputPath) }));
      await this.update();
    } catch (e) {
      void vscode.window.showErrorMessage(tr('Screenshot saved but COCO update failed: {error}', { error: String(e) }));
    }
  }

  /* ---------- 保存到 assets ---------- */
  private async handleSaveToAssets(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }
    const targets = [
      { label: 'assets', description: tr('saveToAssetsStandaloneApp'), folder: path.join(folder.uri.fsPath, 'assets') },
      { label: 'ok_tasks/assets', description: tr('saveToAssetsCustomScripts'), folder: path.join(folder.uri.fsPath, 'ok_tasks', 'assets') },
    ];

    const pick = await vscode.window.showQuickPick(
      targets.map((t) => ({ label: t.label, description: t.description, target: t.folder })),
      { placeHolder: tr('Save COCO data + images to...') },
    );
    if (!pick) return;

    // 读取上次输入的 enum 文件路径，回退到默认值
    const defaultEnumPath = this.globalState?.get<string>('okScriptToolkit.lastEnumFilePath') || '';
    const enumFilePath = await vscode.window.showInputBox({
      prompt: tr('LabelEnum.py file path (relative to workspace root, leave empty to skip)'),
      placeHolder: tr('e.g. assets/data/LabelEnum.py or src/label_enum.py'),
      value: defaultEnumPath,
    });
    if (enumFilePath === undefined) return;
    const trimmedEnumPath = enumFilePath.trim();
    const generateEnum = trimmedEnumPath.length > 0;
    // 将相对路径解析为绝对路径
    const absEnumPath = generateEnum ? path.join(folder.uri.fsPath, trimmedEnumPath) : undefined;

    // 记住本次输入的路径
    if (this.globalState) {
      void this.globalState.update('okScriptToolkit.lastEnumFilePath', trimmedEnumPath);
    }

    try {
      this.data.ensureTemplateFolder();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: tr('Saving to assets…'),
          cancellable: true,
        },
        async (progress, token) => {
          await this.data.saveToAssets(
            pick.target,
            generateEnum,
            absEnumPath,
            (done, total) => {
              // page 渲染在 worker 池并行，完成顺序可能乱序，done 单调递增
              progress.report({ message: tr('Packing pages {done}/{total}…', { done, total }) });
            },
            token,
          );
        },
      );
      void vscode.window.showInformationMessage(tr('Saved to: {path}', { path: pick.label }));
    } catch (e) {
      if (e instanceof vscode.CancellationError) {
        void vscode.window.showInformationMessage(tr('Save to assets cancelled.'));
      } else {
        void vscode.window.showErrorMessage(tr('Save failed: {error}', { error: String(e) }));
      }
    }
  }

  /* ---------- 删除图片 ---------- */
  private async handleDeleteImage(imagePath: string): Promise<void> {
    const name = path.basename(imagePath);
    const confirm = await vscode.window.showWarningMessage(
      tr("Delete '{name}'? This cannot be undone.", { name }),
      { modal: true },
      tr('Delete'),
    );
    if (confirm !== tr('Delete')) return;

    if (this.data.deleteImage(imagePath)) {
      void vscode.window.showInformationMessage(tr('Deleted: {name}', { name }));
      await this.update();
    } else {
      void vscode.window.showErrorMessage(tr('Failed to delete: {name}', { name }));
    }
  }

  /* ---------- 导入文件 ---------- */
  private async handleImportFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      // 裁剪/打包管线支持 PNG/JPEG/BMP（纯 JS 解码），其他格式（如 webp）缺
      // 少可靠解码器，产出的标注与缩略图会是坏的，这里直接限制可选类型
      filters: { [tr('importImagesFilter')]: ['png', 'jpg', 'jpeg', 'bmp'] },
      title: tr('Import images to ok_templates'),
    });
    if (!uris || uris.length === 0) return;

    this.data.ensureTemplateFolder();
    let count = 0;
    for (const uri of uris) {
      if (this.data.importImageFile(uri.fsPath)) count++;
    }
    if (count > 0) {
      void vscode.window.showInformationMessage(tr('Imported {count} image(s)', { count: String(count) }));
      await this.update();
    }
  }

  /* ---------- 接收临时截图拖拽 ---------- */
  private async handleDropTemp(tempId: string): Promise<void> {
    if (!this.tempStore) return;
    const target = this.tempStore.get(tempId);
    if (!target) {
      void vscode.window.showWarningMessage(tr('The dragged screenshot is no longer available.'));
      return;
    }
    const dst = this.data.importImageFile(target.filePath);
    if (!dst) {
      void vscode.window.showErrorMessage(tr('Failed to add to template assets: {error}', { error: target.name }));
      return;
    }
    void vscode.window.showInformationMessage(tr('Added to template assets: {name}', { name: path.basename(dst) }));
    await this.update();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    liveControllers.delete(this);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ---------------- 侧边栏视图 ---------------- */

export class TemplateAssetViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.templateAssets';

  constructor(
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly extensionUri: vscode.Uri,
    private readonly globalState?: vscode.Memento,
    private readonly tempStore?: TempScreenshotStore,
  ) { }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.thumbDir), this.extensionUri],
    };
    const controller = new AssetGalleryController(
      view.webview,
      this.data,
      this.thumbDir,
      () => view.visible,
      this.extensionUri,
      this.globalState,
      this.tempStore,
    );
    controller.attachHtml();
    view.onDidChangeVisibility(() => { if (view.visible) void controller.update(); });
    view.onDidDispose(() => controller.dispose());
  }
}

/* ---------------- 编辑器面板 ---------------- */

export class TemplateAssetPanel {
  static current: TemplateAssetPanel | undefined;

  static show(data: TemplateAssetData, thumbDir: string, extensionUri: vscode.Uri, globalState?: vscode.Memento, tempStore?: TempScreenshotStore): void {
    if (TemplateAssetPanel.current) {
      TemplateAssetPanel.current.panel.reveal();
      void TemplateAssetPanel.current.controller.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okScriptToolkitTemplateAssets',
      tr('Template Assets'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(thumbDir), extensionUri],
      },
    );
    const controller = new AssetGalleryController(
      panel.webview,
      data,
      thumbDir,
      () => panel.visible,
      extensionUri,
      globalState,
      tempStore,
    );
    TemplateAssetPanel.current = new TemplateAssetPanel(panel, controller);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: AssetGalleryController,
  ) {
    controller.attachHtml();
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) void this.controller.update();
    });
    panel.onDidDispose(() => {
      this.controller.dispose();
      TemplateAssetPanel.current = undefined;
    });
  }
}

/* ---------------- HTML ---------------- */

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 24; i++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

function assetGalleryHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const file = path.join(extensionUri.fsPath, 'media', 'templateAssetPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'templateAssetPanel', name),
  ).toString(true);
  return injectWebviewLocalization(
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  );
}
