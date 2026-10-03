import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { AnnotationPanel } from './annotationPanel';
import { cropTemplateThumbFileAsync, THUMB_HEIGHT } from './pngCrop';
import { injectWebviewLocalization, tr } from './localization';
import { TempScreenshotStore } from './tempScreenshotStore';
import { captureGameWindow, getProjectConfig, probeWindowConfig } from './screenshotCapture';
import { takePendingDrag } from './tempDrag';
import { ideSetting, labelEnumClassName, labelEnumPathInputError, labelEnumPathSetting, normalizeLabelEnumPathInput, setIdeSetting, templatesDirectory } from './projectConfig';
import { labelEnumRenameImpact, labelEnumRenameMessage, referencingFiles, writableClassName } from './labelEnumGuard';
import { derivedEnumPath, isPathInsideRoot, needsEnumPathPrompt, SaveTarget, saveToAssetsItems } from './saveToAssetsPure';
import { onAnnotationDataChanged, sameAnnotationFile } from './cocoAnnotationData';
import { isSameSize, scaleBoxes, SwapBox } from './annotationSwapPure';
import { applySharedAssets, getNonce } from './webviewHtml';
import {
  DEFAULT_POSITION_JSON,
  DEFAULT_POSITION_PY_DIR,
  PositionPublishFormat,
  PositionPublishOptions,
  publishPositionsByFormat,
} from './positionPublishStore';

/* ---------------- 控制器 ---------------- */

const liveControllers = new Set<AssetGalleryController>();

/**
 * 扫项目里的 `.py`，找出**按旧类名 import** 的文件（相对项目根）。
 *
 * 只在"类名真的变了"时才调用（罕见），所以不做缓存、也不做增量。
 * 排除目录照抄 VS Code 自己的默认值加 `__pycache__` —— 扫进虚拟环境里的几千个文件
 * 既慢又没意义（那些不是项目代码）。
 *
 * 返回**全部**命中；文案里只列前几个，但总数照实报。
 */
async function findLabelEnumReferences(className: string, projectRoot: string): Promise<string[]> {
  if (!projectRoot || !className) return [];
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(projectRoot, '**/*.py'),
      new vscode.RelativePattern(projectRoot, '**/{node_modules,.venv,venv,.git,__pycache__}/**'),
      LABEL_ENUM_REFERENCE_SCAN_LIMIT,
    );
  } catch {
    return [];
  }
  const sources: Array<{ path: string; source: string }> = [];
  for (const uri of uris) {
    try {
      sources.push({
        path: path.relative(projectRoot, uri.fsPath).split(path.sep).join('/'),
        source: fs.readFileSync(uri.fsPath, 'utf-8'),
      });
    } catch {
      // 读不了就跳过 —— 这是"提示"不是"校验"，不能因为一个文件读不了就少报或误报
    }
  }
  return referencingFiles(sources, className);
}

/** 引用扫描的文件数上限。项目代码远小于这个数，设它只为兜住"工作区开错根"这种情形。 */
const LABEL_ENUM_REFERENCE_SCAN_LIMIT = 2000;

export function repaintAllAssetGalleries(): void {
  for (const c of [...liveControllers]) void c.update();
}

class AssetGalleryController {
  private generation = 0;
  private disposed = false;
  /** 上次刷新时 authoring 是否不可读（用于只在状态翻转时弹一次提示） */
  private lastReadErrors = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly extensionUri: vscode.Uri,
    private readonly tempStore?: TempScreenshotStore,
  ) {
    liveControllers.add(this);
    this.disposables.push(onAnnotationDataChanged(file => {
      if (sameAnnotationFile(file, this.data.annotationFile)) void this.update();
    }));
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

    const authoringErrors = this.data.readErrors;
    if (authoringErrors.length && !this.lastReadErrors) {
      void vscode.window.showErrorMessage(tr('The annotation source is invalid. Fix the source file before saving or exporting.'));
    }
    this.lastReadErrors = authoringErrors.length > 0;
    const metas = imageFiles.map((imgPath) => {
      const size = this.imagePixelSize(imgPath);
      const cats = this.data.getCategoriesForImage(imgPath);
      return {
        name: path.basename(imgPath),
        imagePath: imgPath,
        width: size.width,
        height: size.height,
        categories: cats,
        annotations: this.data.getAnnotationsForImage(imgPath, true).length,
      };
    });

    await this.webview.postMessage({ type: 'templates', templates: metas });
    if (gen !== this.generation) return;

    const batchSize = 8;
    for (let i = 0; i < metas.length; i += batchSize) {
      if (gen !== this.generation || this.disposed) return;
      await this.pushThumbs(metas.slice(i, i + batchSize).map((meta) => meta.imagePath), gen);
      if (gen !== this.generation || this.disposed) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (gen === this.generation && !this.disposed) {
      void this.webview.postMessage({ type: 'thumbDone' });
    }
  }

  private imagePixelSize(imagePath: string): { width: number; height: number } {
    return this.data.resolveImageSize(imagePath) ?? { width: 0, height: 0 };
  }

  private async pushThumbs(imagePaths: readonly string[], generation = this.generation): Promise<number> {
    const items: { name: string; url: string }[] = [];
    for (const imagePath of imagePaths) {
      if (generation !== this.generation || this.disposed) return 0;
      const size = this.imagePixelSize(imagePath);
      const bbox: [number, number, number, number] = [0, 0, size.width > 0 ? size.width : 100, size.height > 0 ? size.height : 100];
      const file = await cropTemplateThumbFileAsync(imagePath, bbox, this.thumbDir, THUMB_HEIGHT);
      if (generation !== this.generation || this.disposed) return 0;
      if (!file) continue;
      items.push({
        name: path.basename(imagePath),
        url: this.webview.asWebviewUri(vscode.Uri.file(file)).toString(true),
      });
    }
    if (items.length) await this.webview.postMessage({ type: 'thumbs', items });
    return items.length;
  }

  private async onMessage(msg: {
    type?: string;
    name?: string;
    imagePath?: string;
    targetPath?: string;
    imagePaths?: string[];
    command?: string;
    base64Png?: string;
    tempId?: string;
    dragKind?: string;
    hardForeground?: boolean;
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
      case 'openSource': {
        if (msg.imagePath && this.data.listImages().includes(msg.imagePath)) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.imagePath));
        }
        break;
      }
      case 'screenshot': {
        await this.handleScreenshot(msg.hardForeground);
        break;
      }
      case 'saveToAssets': {
        await this.handlePublish();
        break;
      }
      case 'deleteImage': {
        if (msg.imagePath) {
          await this.handleDeleteImage(msg.imagePath);
        }
        break;
      }
      case 'swapAnnotations': {
        if (msg.imagePath && msg.targetPath) {
          await this.handleSwapAnnotations(msg.imagePath, msg.targetPath);
        }
        break;
      }
      case 'requestThumbs': {
        const requested = Array.isArray(msg.imagePaths) ? msg.imagePaths : [];
        if (requested.length > 0) {
          const allowed = new Set(this.data.listImages());
          await this.pushThumbs(requested.filter((imagePath) => typeof imagePath === 'string' && allowed.has(imagePath)));
        }
        break;
      }
      case 'importFile': {
        await this.handleImportFile();
        break;
      }
      case 'dropTemp': {
        const id = msg.tempId || takePendingDrag();
        if (id) await this.handleDropTemp(id);
        break;
      }
    }
  }

  /* ---------- 截图处理 ---------- */

  async handleScreenshot(hardForeground?: boolean): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }

    const projectRoot = this.data.root || folder.uri.fsPath;
    const outputDir = path.join(projectRoot, templatesDirectory(projectRoot));
    fs.mkdirSync(outputDir, { recursive: true });

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const outputPath = path.join(outputDir, `screenshot_${ts}.png`);

    const outcome = await captureGameWindow(outputPath, hardForeground ? 'foreground' : undefined);
    if (!outcome.ok) {
      if (outcome.reason === 'noScript') {
        void vscode.window.showErrorMessage(tr('Screenshot script not found. capture_game_window.py is missing from the extension.'));
      } else if (outcome.reason === 'failed') {
        void vscode.window.showErrorMessage(tr('Screenshot failed: {error}', { error: outcome.error || '' }));
      }
      return;
    }

    void vscode.window.showInformationMessage(tr('Screenshot saved: {name}', { name: path.basename(outputPath) }));
    await this.update();
  }

  /* ---------- 统一发布 ---------- */

  private async handlePublish(): Promise<void> {
    const resources = await vscode.window.showQuickPick(
      [
        { label: 'Template', resource: 'template' as const, picked: true },
        { label: 'Rect', resource: 'rect' as const, picked: true },
        { label: 'Point', resource: 'point' as const, picked: true },
      ],
      {
        canPickMany: true,
        placeHolder: 'Select resources to publish',
      },
    );
    if (!resources?.length) return;

    const selected = new Set(resources.map(item => item.resource));
    if (selected.has('template')) {
      await this.handleSaveToAssets();
    }
    if (selected.has('rect') || selected.has('point')) {
      await this.handlePublishPositions({
        rect: selected.has('rect'),
        point: selected.has('point'),
      });
    }
  }

  private async handlePublishPositions(selection: { rect: boolean; point: boolean }): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'JSON', description: DEFAULT_POSITION_JSON, format: 'json' as PositionPublishFormat },
        {
          label: 'Python data + parser',
          description: `${DEFAULT_POSITION_PY_DIR}/ScreenRatio.py + PositionMap.py`,
          format: 'python' as PositionPublishFormat,
        },
      ],
      { placeHolder: 'Position export format' },
    );
    if (!choice) return;

    const root = this.data.root;
    const directory = templatesDirectory(root);
    const options: PositionPublishOptions = {
      ...selection,
      jsonTarget: DEFAULT_POSITION_JSON,
      pythonTargetDir: DEFAULT_POSITION_PY_DIR,
    };
    let result = publishPositionsByFormat(root, directory, choice.format, options);
    if (!result.ok && result.errors.includes('manual') && result.protectedFiles?.length) {
      const names = result.protectedFiles.map(file => path.relative(root, file)).join('\n');
      const overwrite = await vscode.window.showWarningMessage(
        `These Python files were not generated by ok-script-toolkit and would be overwritten:\n${names}`,
        { modal: true },
        'Overwrite',
      );
      if (overwrite !== 'Overwrite') return;
      result = publishPositionsByFormat(root, directory, choice.format, {
        ...options,
        overwriteManual: true,
      });
    }

    if (!result.ok) {
      const detail = result.errors.join(', ') || 'unknown';
      void vscode.window.showErrorMessage(`Could not publish positions: ${detail}`);
      return;
    }
    const files = result.files.map(file => path.relative(root, file).replace(/\\/g, '/')).join(', ');
    void vscode.window.showInformationMessage(`Published positions: ${files}`);
  }

  /* ---------- Template 发布 ---------- */

  private async handleSaveToAssets(): Promise<void> {
    if (this.data.readErrors.length) {
      void vscode.window.showErrorMessage(tr('The annotation source is invalid. Fix the source file before saving or exporting.'));
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }
    const projectRoot = this.data.root || folder.uri.fsPath;
    const targets: SaveTarget[] = [
      { label: 'assets', description: tr('saveToAssetsStandaloneApp'), folder: path.join(projectRoot, 'assets') },
      { label: 'ok_tasks/assets', description: tr('saveToAssetsCustomScripts'), folder: path.join(projectRoot, 'ok_tasks', 'assets') },
    ];

    const folderUri = folder.uri;
    const rememberEnumPath = (value: string) => setIdeSetting('labelEnumPath', value, folderUri);
    const rememberEnumName = (value: string) => setIdeSetting('labelEnumName', value, folderUri);
    const validateEnumPathInput = (value: string): string | undefined =>
      labelEnumPathInputError(value)
        ? tr('Enum file path must be relative and stay within the workspace root.')
        : undefined;
    let enumPath = labelEnumPathSetting(folderUri, this.data.root);
    if (!enumPath && this.data.root) {
      const { pythonPath } = getProjectConfig();
      const discovered = (await probeWindowConfig(this.data.root, pythonPath))?.labelEnumRelativePath;
      if (discovered) {
        try { enumPath = normalizeLabelEnumPathInput(discovered); } catch { /* invalid project path */ }
      }
    }
    let enumName = ideSetting<string>('labelEnumName', folderUri) ?? '';

    let targetFolder = '';
    let targetLabel = '';
    let enumPathDecided = false;
    for (;;) {
      const quickPickItems = saveToAssetsItems({
        targets,
        enumPath,
        enumName,
        labels: {
          path: tr('Enum file path'),
          name: tr('Enum class name'),
          notSet: tr('Not set — click to set'),
          derived: tr('Not set — follows the project convention'),
        },
      }).map((item) => item.separator
        ? { ...item, kind: vscode.QuickPickItemKind.Separator }
        : item);
      const pick = await vscode.window.showQuickPick(
        quickPickItems,
        { placeHolder: tr('Save COCO data + images to...') },
      );
      if (!pick) return;
      if (pick.separator) continue;
      if (pick.target) {
        targetFolder = pick.target;
        targetLabel = pick.label;
        break;
      }
      if (pick.edit === 'enumName') {
        const edited = await vscode.window.showInputBox({
          prompt: tr('LabelEnum class name (leave empty to follow the project convention)'),
          placeHolder: enumPath ? labelEnumClassName(path.join(projectRoot, enumPath)) : '',
          value: enumName,
        });
        if (edited === undefined) continue;
        enumName = edited.trim();
        await rememberEnumName(enumName);
        continue;
      }
      const edited = await vscode.window.showInputBox({
        prompt: tr('LabelEnum.py file path (relative to workspace root, leave empty to skip)'),
        placeHolder: tr('e.g. assets/data/LabelEnum.py or src/label_enum.py'),
        value: enumPath,
        validateInput: validateEnumPathInput,
      });
      if (edited === undefined) continue;
      enumPath = normalizeLabelEnumPathInput(edited);
      enumPathDecided = true;
      await rememberEnumPath(enumPath);
    }

    if (needsEnumPathPrompt(enumPath, enumPathDecided)) {
      const edited = await vscode.window.showInputBox({
        prompt: tr('LabelEnum.py file path (relative to workspace root, leave empty to skip)'),
        placeHolder: tr('e.g. assets/data/LabelEnum.py or src/label_enum.py'),
        value: derivedEnumPath(targetLabel),
        validateInput: validateEnumPathInput,
      });
      if (edited === undefined) return;
      enumPath = normalizeLabelEnumPathInput(edited);
      await rememberEnumPath(enumPath);
    }

    const generateEnum = enumPath.length > 0;
    const absEnumPath = generateEnum ? path.join(projectRoot, enumPath) : undefined;
    if (absEnumPath && !isPathInsideRoot(projectRoot, absEnumPath)) {
      void vscode.window.showErrorMessage(tr('Enum file path must be relative and stay within the workspace root.'));
      return;
    }

    if (absEnumPath && !(await this.confirmLabelEnumRename(absEnumPath, folderUri))) return;

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
            targetFolder,
            generateEnum,
            absEnumPath,
            (done, total) => {
              progress.report({ message: tr('Packing pages {done}/{total}…', { done, total }) });
            },
            token,
            folderUri,
          );
        },
      );
      void vscode.window.showInformationMessage(tr('Saved to: {path}', { path: targetLabel }));
    } catch (e) {
      if (e instanceof vscode.CancellationError) {
        void vscode.window.showInformationMessage(tr('Save to assets cancelled.'));
      } else {
        void vscode.window.showErrorMessage(tr('Save failed: {error}', { error: String(e) }));
      }
    }
  }

  private async confirmLabelEnumRename(absEnumPath: string, folderUri: vscode.Uri): Promise<boolean> {
    let existingSource: string | undefined;
    try {
      existingSource = fs.readFileSync(absEnumPath, 'utf-8');
    } catch {
      return true;
    }
    const newClassName = writableClassName(labelEnumClassName(absEnumPath, this.data.root, folderUri));
    const impact = labelEnumRenameImpact({ existingSource, newClassName });
    if (!impact) return true;

    const refs = await findLabelEnumReferences(impact.existingClassName, this.data.root);
    const overwrite = tr('Overwrite anyway');
    const choice = await vscode.window.showWarningMessage(
      labelEnumRenameMessage(impact, refs, tr),
      { modal: true },
      overwrite,
    );
    return choice === overwrite;
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

    const deleted = this.data.deleteImage(imagePath);
    if (deleted === true) {
      void vscode.window.showInformationMessage(tr('Deleted: {name}', { name }));
      await this.update();
    } else if (typeof deleted === 'string') {
      void vscode.window.showErrorMessage(tr('Deleted the record for {name}, but the temporary file is still at {path}.', { name, path: deleted }));
      await this.update();
    } else {
      void vscode.window.showErrorMessage(tr('Failed to delete: {name}', { name }));
    }
  }

  /* ---------- 交换两张图的标注 ---------- */

  private async handleSwapAnnotations(sourcePath: string, targetPath: string): Promise<void> {
    if (!sourcePath || !targetPath || sourcePath === targetPath) return;
    const allowed = new Set(this.data.listImages());
    if (!allowed.has(sourcePath) || !allowed.has(targetPath)) {
      void vscode.window.showErrorMessage(tr('Failed to swap annotations.'));
      return;
    }
    const sourceEntry = this.data.getSwapImageEntry(sourcePath);
    const targetEntry = this.data.getSwapImageEntry(targetPath);
    if (sourceEntry && targetEntry && sourceEntry.id === targetEntry.id) {
      void vscode.window.showErrorMessage(tr('Failed to swap annotations.'));
      return;
    }

    const sourceSize = this.data.resolveImageSize(sourcePath);
    const targetSize = this.data.resolveImageSize(targetPath);
    if (!sourceSize || !targetSize) {
      void vscode.window.showErrorMessage(tr('Cannot read image size, so annotations cannot be swapped.'));
      return;
    }

    const sourceBoxes = this.boxesOf(sourcePath);
    const targetBoxes = this.boxesOf(targetPath);
    if (sourceBoxes.length === 0 && targetBoxes.length === 0) {
      void vscode.window.showInformationMessage(tr('Neither image has annotations, nothing to swap.'));
      return;
    }

    const first = path.basename(sourcePath);
    const second = path.basename(targetPath);
    const scaled = !isSameSize(sourceSize, targetSize);
    const detail = [
      scaled
        ? tr('Sizes differ ({from} → {to}); boxes are scaled proportionally.', {
            from: `${sourceSize.width}×${sourceSize.height}`,
            to: `${targetSize.width}×${targetSize.height}`,
          })
        : '',
      tr('{first}: {firstCount} boxes, {second}: {secondCount} boxes', {
        first,
        second,
        firstCount: String(sourceBoxes.length),
        secondCount: String(targetBoxes.length),
      }),
    ].filter((line) => line.length > 0).join('\n');

    const swap = tr('Swap');
    const choice = await vscode.window.showWarningMessage(
      tr("Swap annotations between '{first}' and '{second}'?", { first, second }),
      { modal: true, detail },
      swap,
    );
    if (choice !== swap) return;

    this.data.load();
    const currentImages = new Set(this.data.listImages());
    if (!currentImages.has(sourcePath) || !currentImages.has(targetPath)) {
      void vscode.window.showWarningMessage(tr('Annotations changed while confirming. Retry the swap.'));
      return;
    }
    const currentSourceSize = this.data.resolveImageSize(sourcePath);
    const currentTargetSize = this.data.resolveImageSize(targetPath);
    if (this.data.getSwapImageEntry(sourcePath)?.id !== sourceEntry?.id
      || this.data.getSwapImageEntry(targetPath)?.id !== targetEntry?.id
      || !currentSourceSize || !currentTargetSize
      || !isSameSize(currentSourceSize, sourceSize) || !isSameSize(currentTargetSize, targetSize)
      || JSON.stringify(this.boxesOf(sourcePath)) !== JSON.stringify(sourceBoxes)
      || JSON.stringify(this.boxesOf(targetPath)) !== JSON.stringify(targetBoxes)) {
      void vscode.window.showWarningMessage(tr('Annotations changed while confirming. Retry the swap.'));
      return;
    }

    let ok: boolean;
    try {
      ok = this.data.swapAnnotationsForImages(
        sourcePath,
        targetPath,
        scaleBoxes(targetBoxes, targetSize, sourceSize),
        scaleBoxes(sourceBoxes, sourceSize, targetSize),
        sourceSize,
        targetSize,
      );
    } catch {
      void vscode.window.showErrorMessage(tr('Failed to swap annotations.'));
      return;
    }
    if (!ok) {
      void vscode.window.showErrorMessage(tr('Failed to swap annotations.'));
      return;
    }
    await this.update();
    AnnotationPanel.current?.controller.reloadIfShowing([sourcePath, targetPath]);
    void vscode.window.showInformationMessage(
      tr("Swapped annotations between '{first}' and '{second}'.", { first, second }),
    );
  }

  private boxesOf(imagePath: string): SwapBox[] {
    return this.data.getAnnotationsForImage(imagePath, true).map((ann) => ({
      category: ann.categoryName,
      x: ann.bbox[0],
      y: ann.bbox[1],
      w: ann.bbox[2],
      h: ann.bbox[3],
    }));
  }

  /* ---------- 导入文件 ---------- */
  private async handleImportFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { [tr('importImagesFilter')]: ['png', 'jpg', 'jpeg', 'bmp'] },
      title: tr('Import images to {dir}', { dir: templatesDirectory(this.data.root) }),
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

  static show(data: TemplateAssetData, thumbDir: string, extensionUri: vscode.Uri, tempStore?: TempScreenshotStore): void {
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
      tempStore,
    );
    TemplateAssetPanel.current = new TemplateAssetPanel(panel, controller);
  }

  static showScreenshot(
    data: TemplateAssetData,
    thumbDir: string,
    extensionUri: vscode.Uri,
    tempStore?: TempScreenshotStore,
  ): void {
    TemplateAssetPanel.show(data, thumbDir, extensionUri, tempStore);
    void TemplateAssetPanel.current?.controller.handleScreenshot();
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

function assetGalleryHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const file = path.join(extensionUri.fsPath, 'media', 'templateAssetPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'templateAssetPanel', name),
  ).toString(true);
  return injectWebviewLocalization(applySharedAssets(webview, extensionUri,
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js'))
      .split('__ASSET_MODE__').join('annotations'),
  ));
}
