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
import { currentWorkspaceFolderUri, ideSetting, labelEnumClassName, labelEnumPathSetting, normalizeLabelEnumPathInput, setIdeSetting, templatesDirectory } from './projectConfig';
import { labelEnumRenameImpact, labelEnumRenameMessage, referencingFiles, writableClassName } from './labelEnumGuard';
import { derivedEnumPath, needsEnumPathPrompt, SaveTarget, saveToAssetsItems } from './saveToAssetsPure';
import { getNonce } from './webviewHtml';

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
async function findLabelEnumReferences(className: string): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !className) return [];
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      '**/*.py',
      '**/{node_modules,.venv,venv,.git,__pycache__}/**',
      LABEL_ENUM_REFERENCE_SCAN_LIMIT,
    );
  } catch {
    return [];
  }
  const sources: Array<{ path: string; source: string }> = [];
  for (const uri of uris) {
    try {
      sources.push({
        path: path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/'),
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
      case 'screenshot': {
        // 从剪贴板粘贴截图
        await this.handleScreenshot(msg.hardForeground);
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

  /**
   * 截图并登记进 COCO。
   *
   * **public 是刻意的**：快捷键命令（`okScriptToolkit.screenshotToTemplate`）要复用它 ——
   * 截图实现只此一处，命令只负责"打开面板 + 调这里"，绝不另造一套，
   * 否则两条路径的截图行为（落盘位置、COCO 登记）迟早漂移。
   */
  async handleScreenshot(hardForeground?: boolean): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }

    const outputDir = path.join(folder.uri.fsPath, templatesDirectory(folder.uri.fsPath));
    fs.mkdirSync(outputDir, { recursive: true });

    // Generate filename with timestamp
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
    const targets: SaveTarget[] = [
      { label: 'assets', description: tr('saveToAssetsStandaloneApp'), folder: path.join(folder.uri.fsPath, 'assets') },
      { label: 'ok_tasks/assets', description: tr('saveToAssetsCustomScripts'), folder: path.join(folder.uri.fsPath, 'ok_tasks', 'assets') },
    ];

    // 枚举路径 / 类名的取值链：**IDE 设置 > 项目约定 > 兜底**。
    // 个人偏好排最高是用户定的：项目文件是"团队开箱默认"，我改过就用我的。
    // 路径留空即跳过生成枚举。
    //
    // 注意路径必须走 `labelEnumPathSetting` 而不是直接拿 `labelEnum.path` —— 后者是**模块路径**
    // （`src/data/FeatureList`，不带 .py，与 config.py 的 label_enum_relative_path 同形），
    // 而对话框里要的是**文件路径**；取值链里统一补后缀（见 `normalizeLabelEnumFile`）。
    //
    // 个人偏好以前存在 `context.globalState` 里，已**废弃**：它是全局的（A 项目填过的值
    // 会带到 B 项目，而消费点按当前工作区拼绝对路径 → 静默造出错误目录树），
    // 而且不在设置界面、不在溯源面板。现在写进 IDE 设置（工作区文件夹级），可见可改可恢复。
    //
    // ⚠️ 写设置必须 **await**。`setIdeSetting` 是异步的，`void` 掉之后紧接着的
    // `confirmLabelEnumRename` 会读到**旧值** —— 用户在对话框里改了类名、守卫却拿旧名字
    // 去比对，于是漏报"这次会改掉项目里 N 处 import"。
    //
    // ⚠️ 枚举路径/类名的读写**必须绑定当前工作区文件夹 URI**，防止 A 项目的值串到 B 项目。
    const folderUri = folder.uri;
    const rememberEnumPath = (value: string) => setIdeSetting('labelEnumPath', value, folderUri);
    const rememberEnumName = (value: string) => setIdeSetting('labelEnumName', value, folderUri);
    let enumPath = labelEnumPathSetting(folderUri);
    /** 我**设过**的类名（空 = 没设过）。列表里显示这个而不是解析后的值 —— 见 `saveToAssetsPure` */
    let enumName = ideSetting<string>('labelEnumName', folderUri) ?? '';

    // 目标选择与两项枚举设置共用一轮循环：改完任一项都要回到目标选择，所以列表每次都重新构造。
    let targetFolder = '';
    let targetLabel = '';
    /** 用户是否已经在「改路径」里做过决定 —— 决定过就不再追问，哪怕他清空了 */
    let enumPathDecided = false;
    for (;;) {
      const pick = await vscode.window.showQuickPick(
        saveToAssetsItems({
          targets,
          enumPath,
          enumName,
          labels: {
            path: tr('Enum file path'),
            name: tr('Enum class name'),
            notSet: tr('Not set — click to set'),
            derived: tr('Derived from the file name'),
          },
        }),
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
          prompt: tr('LabelEnum class name (leave empty to derive it from the file name)'),
          // 提示里给出**当前生效**的类名（可能是项目约定或文件名推导出来的），
          // 输入框本身留空 = 撤销我的设置。这样"看得到现在的值"与"能清掉覆盖"同时成立。
          placeHolder: enumPath ? labelEnumClassName(path.join(folder.uri.fsPath, enumPath)) : '',
          value: enumName,
        });
        if (edited === undefined) continue; // 取消 → 回到列表
        enumName = edited.trim();
        await rememberEnumName(enumName);
        continue;
      }
      const edited = await vscode.window.showInputBox({
        prompt: tr('LabelEnum.py file path (relative to workspace root, leave empty to skip)'),
        placeHolder: tr('e.g. assets/data/LabelEnum.py or src/label_enum.py'),
        value: enumPath,
      });
      if (edited === undefined) continue; // 取消改路径 → 回到目标选择
      // ⚠️ 必须归一化再消费：用户很可能填的是模块路径（`src/data/feature_list`，与 config.py
      // 的 label_enum_relative_path 同形），直接拼绝对路径会生成一个**没有扩展名**的文件。
      enumPath = normalizeLabelEnumPathInput(edited);
      enumPathDecided = true;
      await rememberEnumPath(enumPath);
    }

    // 已经有生效路径时**不再弹输入框**（每次保存都要按一次回车是纯噪音）。
    // 唯一"没定过"的情形是首次使用 —— 那时必须问：留空即"不生成枚举"。
    // 预填 `<目标目录>/LabelEnum.py`（此时目标已经选好了）：不预填的话默认选项就变成
    // "不生成枚举"，而按回车本该得到一个合法的、写在项目里的路径。
    if (needsEnumPathPrompt(enumPath, enumPathDecided)) {
      const edited = await vscode.window.showInputBox({
        prompt: tr('LabelEnum.py file path (relative to workspace root, leave empty to skip)'),
        placeHolder: tr('e.g. assets/data/LabelEnum.py or src/label_enum.py'),
        value: derivedEnumPath(targetLabel),
      });
      if (edited === undefined) return;
      enumPath = normalizeLabelEnumPathInput(edited);
      await rememberEnumPath(enumPath);
    }

    const generateEnum = enumPath.length > 0;
    // 将相对路径解析为绝对路径
    const absEnumPath = generateEnum ? path.join(folder.uri.fsPath, enumPath) : undefined;

    // 覆盖已有枚举文件、且**类名会变**时先问一句。这是唯一一处"个人覆盖能把项目弄坏"
    // 的地方：项目的代码按类名 import（`from src.data.feature_list import FeatureList`），
    // 改名之后那些 import 全部 ImportError，而保存成功的提示照样会弹出来。
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
              // page 渲染在 worker 池并行，完成顺序可能乱序，done 单调递增
              progress.report({ message: tr('Packing pages {done}/{total}…', { done, total }) });
            },
            token,
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

  /**
   * 覆盖已有枚举文件、且**类名会变**时先问一句。
   *
   * 为什么这道闸在 UI 层而不是 `TemplateAssetData.generateLabelEnum` 里：那是个同步的
   * 数据写入，里面弹模态框会让它没法被测、也把 UI 决策塞进了数据层。判据本身是纯函数
   * （`labelEnumGuard.ts`），IO 与弹窗留在这里。
   *
   * 返回 `false` = 用户选择放弃这次保存（**整个**保存，不只是枚举 —— 半保存状态更难解释）。
   *
   * 失败一律放行：读不了文件、扫不了项目都只影响"提示的完整度"，不能反过来阻断保存。
   */
  private async confirmLabelEnumRename(absEnumPath: string, folderUri: vscode.Uri): Promise<boolean> {
    let existingSource: string | undefined;
    try {
      existingSource = fs.readFileSync(absEnumPath, 'utf-8');
    } catch {
      return true; // 文件不存在 → 全新生成，没有旧名字可废
    }
    // 用**将要写入的那个类名**（`writableClassName` 会把非法标识符退回兜底名）去比 ——
    // 直接拿用户填的原始值比，会为"填了个非法名字、实际什么都没变"的情况报警。
    const newClassName = writableClassName(labelEnumClassName(absEnumPath, this.data.root, folderUri));
    const impact = labelEnumRenameImpact({ existingSource, newClassName });
    if (!impact) return true;

    const refs = await findLabelEnumReferences(impact.existingClassName);
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
      // 目录名可配，所以标题必须带上实际值 —— 否则目录改成 my_templates 后
      // 对话框还在说"导入到 ok_templates"，用户在找一个不存在的目录。
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

  /**
   * 打开面板并**立即触发它的截图动作**（快捷键入口）。
   *
   * 复用面板自己的 [AssetGalleryController.handleScreenshot] —— 不新增截图实现。
   * 面板已开着时 `show()` 只 reveal，随后照样截图，行为一致。
   */
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
  return injectWebviewLocalization(
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  );
}
