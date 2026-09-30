import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { addBox, pixelUnionFromAnnotations, readAuthoringFile, boxNamesError } from './boxResourceStore';
import { AUTHORING_FILE_NAME, BOX_PATH_SEGMENT_SOURCE, RESERVED_BOX_ROOTS } from './boxResourcePure';
import { onAnnotationDataChanged, sameAnnotationFile } from './cocoAnnotationData';
import { readImageSize } from './pngCrop';
import { injectWebviewLocalization, tr } from './localization';
import { applySharedAssets, getNonce } from './webviewHtml';

/* ---------------- 标注数据类型 ---------------- */

interface Annotation {
  id: number;
  category: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ---------------- 控制器 ---------------- */

class AnnotationController {
  private generation = 0;
  private disposed = false;
  private saving = false;
  private sourceRevision: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private _currentImage: string | undefined;
  private _imageList: string[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly onSaved: (imagePath: string) => void,
    private readonly boxMode = false,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
      onAnnotationDataChanged(file => {
        if (this.saving || !this._currentImage) return;
        if (sameAnnotationFile(this.data.annotationFile, file)) {
          let revision: string | undefined;
          try { revision = fs.readFileSync(file, 'utf8'); } catch { /* deleted or unreadable source */ }
          if (revision !== this.sourceRevision) this.reloadIfShowing([this._currentImage]);
        } else if (!this.boxMode && sameAnnotationFile(file, path.resolve(this.data.templatesDir, AUTHORING_FILE_NAME))) {
          void this.webview.postMessage({ type: 'boxPaths', boxPaths: this.boxOccupancy() });
        }
      }),
      // 面板开着时改设置也要热更新（review 意见：不要靠「切一下视图」触发）
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('okScriptToolkit.copyCoordsSpace') ||
            e.affectsConfiguration('okScriptToolkit.annotationKeybindings')) {
          this.sendConfig();
        }
      }),
    );
  }

  get dataFile(): string { return this.data.annotationFile; }

  get currentImage(): string | undefined { return this._currentImage; }

  /**
   * 外部改动了某张图的标注（素材面板的「交换标注」）后，若面板正显示它则重新拉取。
   *
   * 必须做：本面板是常驻 webview 且**逐操作自动落盘**，它内存里的 `annotations`
   * 是打开那一刻的快照。交换后不同步的话，用户下一次拖框/删除会把整份旧数据写回去
   * —— 交换的结果被静默覆盖，看起来像"交换根本没生效"。
   */
  reloadIfShowing(imagePaths: readonly string[]): void {
    if (this.disposed || !this._currentImage) return;
    if (!imagePaths.includes(this._currentImage)) return;
    void this.loadImage(this._currentImage);
  }

  attachHtml(): void {
    this.webview.html = annotationHtml(this.webview.cspSource, this.extensionUri, this.webview);
    this.sendConfig();
  }

  /** 读取扩展设置并发送面板配置到 webview（快捷键 + 坐标分隔偏好） */
  private sendConfig(): void {
    const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
    const kb = cfg.get<Record<string, string>>('annotationKeybindings');
    // 坐标逗号后加空格是个人习惯 → application 作用域，只在用户设置里存在
    const copyCoordsSpace = cfg.get<boolean>('copyCoordsSpace', true);
    void this.webview.postMessage({
      type: 'config',
      boxMode: this.boxMode,
      keybindings: kb,
      copyCoordsSpace,
      // 框路径规则：给「生成框」输入框做即时校验，规则只有这一个来源。
      // 不给的话输入框就无法判定段名，只能走到"拦不住"那一侧。
      boxPathRule: {
        segment: BOX_PATH_SEGMENT_SOURCE,
        reservedRoots: [...RESERVED_BOX_ROOTS],
      },
    });
  }

  open(imagePath: string, imageList: string[]): void {
    this._imageList = [...imageList];
    this._currentImage = imagePath;
    this.loadImage(imagePath);
  }

  private async loadImage(imagePath: string): Promise<void> {
    if (this.disposed) return;
    this._currentImage = imagePath;
    const generation = ++this.generation;
    this.data.load();
    this.sourceRevision = this.data.revision;

    // 读取图片为 base64（异步读，避免大截图阻塞扩展宿主）；
    // webview 原生渲染 PNG/JPEG/BMP，MIME 按魔数判定
    let imageBase64 = '';
    try {
      const buf = await fs.promises.readFile(imagePath);
      const mime = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
        ? 'image/jpeg'
        : buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d
          ? 'image/bmp'
          : 'image/png';
      imageBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      imageBase64 = '';
    }

    if (this.disposed || generation !== this.generation) return;
    // 读取标注数据
    const annotations = this.data.getAnnotationsForImage(imagePath, true);

    // 获取所有分类名（用于验证唯一性）
    const allCategories: Record<string, string> = {};
    for (const img of this.data.data.images) {
      const imgPath = path.join(this.data.templatesDir, img.file_name);
      if (imgPath === imagePath) continue;
      const cats = this.data.getCategoriesForImage(imgPath);
      for (const c of cats) {
        allCategories[c] = img.file_name;
      }
    }

    const boxPaths = this.boxOccupancy();

    const currentIndex = this._imageList.indexOf(imagePath);

    await this.webview.postMessage({
      type: 'load',
      imagePath,
      imageBase64,
      annotations: annotations.map((a) => ({
        id: a.id,
        category: a.categoryName,
        x: a.bbox[0],
        y: a.bbox[1],
        w: a.bbox[2],
        h: a.bbox[3],
      })),
      allCategories,
      boxPaths,
      currentIndex,
      totalImages: this._imageList.length,
      filename: path.basename(imagePath),
    });
  }

  private boxOccupancy(): Record<string, string> {
    const authoring = readAuthoringFile(this.data.root, this.data.templatesDir);
    return Object.fromEntries(authoring.boxes.map(box => [box.path, box.image]));
  }

  private async onMessage(msg: {
    type?: string;
    annotation?: Annotation;
    annotations?: Annotation[];
    index?: number;
    category?: string;
    text?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    path?: string;
    boxes?: Array<{ x: number; y: number; w: number; h: number }>;
    ok?: boolean;
    error?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // ready 重发一次配置：attachHtml 时机太早、webview 脚本可能还没挂监听
        this.sendConfig();
        if (this._currentImage) {
          await this.loadImage(this._currentImage);
        }
        break;
      case 'save': {
        if (!this._currentImage || !msg.annotations) break;
        if (!this.persistAnnotations(this._currentImage, msg.annotations.map((a) => ({
          category: a.category, x: a.x, y: a.y, w: a.w, h: a.h,
        })))) break;
        this.onSaved(this._currentImage);
        break;
      }
      case 'generateBox': {
        if (!this._currentImage || !msg.path || !msg.boxes?.length) {
          void this.webview.postMessage({ type: 'generateBoxResult', ok: false, error: 'path' });
          break;
        }
        let size: { width: number; height: number } | undefined;
        try {
          size = readImageSize(fs.readFileSync(this._currentImage));
        } catch {
          void this.webview.postMessage({ type: 'generateBoxResult', ok: false, error: 'image' });
          break;
        }
        // Pixel annotations → Pixel union → Pixel authoring。中途不再绕 normalized；
        // 越界与否由 addBox 按图片头尺寸校验（与保存链同一道闸）。
        const union = size ? pixelUnionFromAnnotations(msg.boxes) : undefined;
        const root = this.data.root;
        const error = union && root
          ? addBox(root, path.relative(root, this.data.templatesDir), msg.path, path.basename(this._currentImage), union)
          : 'image';
        void this.webview.postMessage({ type: 'generateBoxResult', ok: !error, error: error || '' });
        if (!error) this.onSaved(this._currentImage);
        break;
      }
      case 'navigate': {
        if (msg.index === undefined || msg.index < 0 || msg.index >= this._imageList.length) break;
        await this.loadImage(this._imageList[msg.index]);
        break;
      }
      case 'deleteAnnotation': {
        if (!this._currentImage || !msg.annotation) break;
        const annotations = this.data.getAnnotationsForImage(this._currentImage, true);
        const annId = (msg.annotation as unknown as { id: number }).id;
        const filtered = annotations.filter((a) => a.id !== annId);
        if (!this.persistAnnotations(
          this._currentImage,
          filtered.map((a) => ({ category: a.categoryName, x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3] })),
        )) break;
        this.onSaved(this._currentImage);
        // 重新加载
        await this.loadImage(this._currentImage);
        break;
      }
      case 'copyColor': {
        if (typeof msg.category === 'string') {
          await vscode.env.clipboard.writeText(msg.category);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.category }));
        }
        break;
      }
      case 'copyText': {
        // 框选复制归一化坐标等任意文本
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          await vscode.env.clipboard.writeText(msg.text);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.text }));
        }
        break;
      }
    }
  }

  private persistAnnotations(
    imagePath: string,
    annotations: Array<{ category: string; x: number; y: number; w: number; h: number }>,
  ): boolean {
    try {
      this.saving = true;
      this.data.load();
      const namesError = this.boxMode ? boxNamesError(this.data, imagePath, annotations.map(ann => ann.category)) : undefined;
      if (namesError) throw new Error(namesError);
      if (!this.data.setAnnotationsForImage(imagePath, annotations)) {
        void vscode.window.showErrorMessage(tr('Could not save annotations.'));
        return false;
      }
      this.data.save();
      this.sourceRevision = this.data.revision;
      return true;
    } catch (error) {
      console.error('[ok-script] save annotations:', error);
      void vscode.window.showErrorMessage(tr('Could not save annotations.'));
      return false;
    } finally {
      this.saving = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ---------------- 面板 ---------------- */

export class AnnotationPanel {
  static current: AnnotationPanel | undefined;
  static currentBoxes: AnnotationPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    data: TemplateAssetData,
    thumbDir: string,
    imagePath: string,
    imageList: string[],
    onSaved: (imagePath: string) => void,
    boxMode = false,
  ): void {
    const current = boxMode ? AnnotationPanel.currentBoxes : AnnotationPanel.current;
    if (current && !sameAnnotationFile(current.controller.dataFile, data.annotationFile)) current.panel.dispose();
    else if (current) {
      current.panel.reveal();
      current.controller.open(imagePath, imageList);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      boxMode ? 'okScriptToolkitBoxAnnotation' : 'okScriptToolkitAnnotation',
      tr('Annotation Editor'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(thumbDir),
          vscode.Uri.file(data.templatesDir),
          extensionUri,
        ],
      },
    );
    const controller = new AnnotationController(
      panel.webview,
      extensionUri,
      data,
      thumbDir,
      () => panel.visible,
      onSaved,
      boxMode,
    );
    const instance = new AnnotationPanel(panel, controller, boxMode);
    if (boxMode) AnnotationPanel.currentBoxes = instance;
    else AnnotationPanel.current = instance;
    controller.open(imagePath, imageList);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: AnnotationController,
    boxMode: boolean,
  ) {
    controller.attachHtml();
    panel.onDidDispose(() => {
      controller.dispose();
      if (boxMode && AnnotationPanel.currentBoxes === this) AnnotationPanel.currentBoxes = undefined;
      else if (!boxMode && AnnotationPanel.current === this) AnnotationPanel.current = undefined;
    });
  }
}

/* ---------------- HTML ---------------- */

export function annotationHtml(cspSource: string, extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const file = path.join(extensionUri.fsPath, 'media', 'annotationPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'annotationPanel', name),
  ).toString(true);
  return injectWebviewLocalization(applySharedAssets(webview, extensionUri,
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  ));
}
