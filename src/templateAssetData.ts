import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeRgba, encodePngRgb } from './pngCrop';
import {
  AssetPackCancelledError, AssetPackPageTask,
  isAssetPackPoolInitialized, renderPagesViaPool,
} from './assetPack';
import { tr } from './localization';
import { labelEnumNameSetting, templatesDirectory } from './projectConfig';
import { PYTHON_KEYWORDS, writableClassName } from './labelEnumGuard';
import { isPathInsideRoot } from './saveToAssetsPure';
import { authoringReadErrors, captureAuthoring, removeImageBoxes, restoreAuthoring } from './boxResourceStore';
import { capturePointAuthoring, removeImagePoints, restorePointAuthoring } from './pointResourceStore';
import { CocoAnnotationData, CocoData, CocoImage, CocoAnnotation, filenameKey, readImageHeaderSize } from './cocoAnnotationData';
import { AUTHORING_FILE_NAME, parseBoxCoco } from './boxResourcePure';
export { CocoImage, CocoAnnotation, CocoCategory, CocoData, filenameKey } from './cocoAnnotationData';

const COCO_JSON = 'coco_annotations.json';

export class TemplateAssetData extends CocoAnnotationData {
  constructor(root: vscode.WorkspaceFolder | string | undefined, fileName = 'coco_annotations.json') {
    const rootDir = typeof root === 'string' ? root : root ? root.uri.fsPath : '';
    super(rootDir, templatesDirectory(rootDir), fileName, fileName === AUTHORING_FILE_NAME
      ? text => parseBoxCoco(text, name => this.resolveImageSize(path.join(this.templatesDir, name)))
      : undefined);
  }

  override setRoot(rootDir: string): void {
    super.setRoot(rootDir, templatesDirectory(rootDir));
  }

  /* ---------- 删除图片文件和COCO数据 ---------- */

  deleteImage(imagePath: string): true | false | string {
    if (this.fileName === AUTHORING_FILE_NAME) {
      const templates = new TemplateAssetData(this.root);
      templates.load();
      return templates.deleteImage(imagePath);
    }
    const templates = templatesDirectory(this.rootDir);
    this.load();
    if (this.readErrors.length || authoringReadErrors(this.rootDir, templates).length) return false;
    const snapshot = captureAuthoring(this.rootDir, templates);
    const pointSnapshot = capturePointAuthoring(this.rootDir, templates);
    if (!snapshot || !pointSnapshot) return false;
    const staged = `${imagePath}.${process.pid}.ok-delete`;
    let moved = false;
    let committed = false;
    let pointsRemoved = false;
    try {
      if (!removeImageBoxes(this.rootDir, templates, path.basename(imagePath))) return false;
      if (!removeImagePoints(this.rootDir, templates, path.basename(imagePath))) throw new Error('points');
      pointsRemoved = true;
      // 挪走文件后，大小写不同的记录不能再靠 realpath 对上，所以先记下 id。
      const imageId = this.getSwapImageEntry(imagePath)?.id;
      if (fs.existsSync(imagePath)) {
        fs.renameSync(imagePath, staged);
        moved = true;
      }
      if (imageId !== undefined) {
        this.cocoData.images = this.cocoData.images.filter((img) => img.id !== imageId);
        this.cocoData.annotations = this.cocoData.annotations.filter((ann) => ann.image_id !== imageId);
        this._cleanupCategories();
        this._dirty = true;
      }
      if (imageId !== undefined || fs.existsSync(this.cocoPath)) this.save();
      committed = true;
      if (moved && !this.removeStagedImage(staged)) return staged;
      return true;
    } catch {
      if (committed) return moved && fs.existsSync(staged) ? staged : false;
      if (moved && fs.existsSync(staged) && !fs.existsSync(imagePath)) {
        try { fs.renameSync(staged, imagePath); } catch { /* 原路径占着时留给下面的框恢复判断 */ }
      }
      if (fs.existsSync(imagePath)) {
        restoreAuthoring(this.rootDir, templates, snapshot);
        if (pointsRemoved) restorePointAuthoring(this.rootDir, templates, pointSnapshot);
      }
      try { this.load(); } catch { /* 标注写盘没成功时，内存仍可能是删过的那份 */ }
      return false;
    }
  }

  private removeStagedImage(staged: string): boolean {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.unlinkSync(staged);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) return false;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  /* ---------- 保存到项目assets（bin-packing + 枚举） ---------- */

  /**
   * 将 ok_templates 中的图片+标注导出到项目 assets 目录。
   *
   * 对齐 ok-script FeatureSet.compress_coco() 语义：
   * - 无标注图片：直接复制原图。
   * - 有标注图片：按原始 (width × height) 分组，同尺寸原图的互不重叠 bbox 打包到
   *   同一张白色 Canvas（原坐标粘贴），重叠 bbox 分到不同 page。
   * - COCO annotation bbox 保持原始坐标不变。
   * - 生成的 COCO image file_name 指向打包后的 PNG。
   *
   * page 渲染（PNG 全图解码 + 全画布 level-6 deflate 编码）在 worker 池中并行
   * 执行，主线程零阻塞；worker 池不可用或中途崩溃时回退到主线程分批渲染
   * （每个重操作之间让出事件循环）。onProgress 汇报已完成 page 数；传入
   * cancellationToken 可在渲染中途取消（临时 page 会清理，抛 CancellationError）。
   */
  async saveToAssets(
    targetFolder: string,
    generateEnum = false,
    enumPath?: string,
    onProgress?: (done: number, total: number) => void,
    cancellationToken?: vscode.CancellationToken,
    folderUri?: vscode.Uri,
  ): Promise<void> {
    if (this.readErrors.length) throw new Error(tr('The annotation source is invalid. Fix the source file before saving or exporting.'));
    if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
    const enumFile = generateEnum
      ? path.resolve(this.rootDir, enumPath || path.join(targetFolder, 'LabelEnum.py'))
      : undefined;
    if (enumFile && !isPathInsideRoot(this.rootDir, enumFile)) {
      throw new Error(tr('Enum file path must be relative and stay within the workspace root.'));
    }
    const targetImagesDir = path.join(targetFolder, 'images');

    // ── 1. 只处理有标注的图片（无标注的原图不放入 assets） ──
    const annotatedImages = this.cocoData.images.filter(
      (img) => this.cocoData.annotations.some((a) => a.image_id === img.id),
    );

    // ── 2. 有标注图片：按原始尺寸分组，bin-packing 到 Canvas ──
    //    对齐 ok-script compress_coco: 同尺寸原图的互不重叠 bbox 打包到同一张 Canvas。
    //    尺寸只从图片头读取（PNG/JPEG/BMP），失败回退 COCO 记录值，不做整图解码。
    type AnnotatedEntry = { img: CocoImage; ann: CocoAnnotation };
    const dimGroups = new Map<string, AnnotatedEntry[]>();

    for (const img of annotatedImages) {
      const src = path.join(this.templateFolder, img.file_name);
      if (!fs.existsSync(src)) continue;

      let imgW = img.width;
      let imgH = img.height;
      const headerDims = readImageHeaderSize(src);
      if (headerDims) {
        imgW = headerDims.width;
        imgH = headerDims.height;
      }

      const annotations = this.cocoData.annotations.filter((a) => a.image_id === img.id);
      for (const ann of annotations) {
        const dimKey = `${imgW}×${imgH}`;
        if (!dimGroups.has(dimKey)) dimGroups.set(dimKey, []);
        dimGroups.get(dimKey)!.push({ img: { ...img, width: imgW, height: imgH }, ann });
      }
    }

    // ── 3. 每个尺寸组内 bin-packing，先收集全部 page 再统一渲染 ──
    const pageList: Array<{
      W: number;
      H: number;
      items: Array<{ img: CocoImage; ann: CocoAnnotation }>;
    }> = [];

    for (const [_dimKey, entries] of dimGroups) {
      // 从 entries 推导画布尺寸（同组所有 entry 的 img 宽高相同）
      const W = entries[0].img.width;
      const H = entries[0].img.height;

      // 构建每张原图的 bbox 区域列表
      const imgRects = new Map<number, Array<[number, number, number, number]>>();
      for (const e of entries) {
        const [bx, by, bw, bh] = e.ann.bbox.map(Math.round) as [number, number, number, number];
        const rects = imgRects.get(e.img.id) ?? [];
        rects.push([bx, by, bx + bw, by + bh]); // 存储 [x1,y1,x2,y2] 用于重叠检测
        imgRects.set(e.img.id, rects);
      }

      // 所有唯一原图 id
      const allImgIds = [...new Set(entries.map((e) => e.img.id))];

      // Bin-packing: 将原图分配到 page，互不重叠的原图可共用同一 page
      const pages: Array<{ imgIds: number[]; occupancy: Array<[number, number, number, number]> }> = [];

      for (const imgId of allImgIds) {
        const rects = imgRects.get(imgId) ?? [];
        let assigned = false;

        for (const page of pages) {
          // 检测该原图的所有 bbox 是否与 page 已有区域冲突
          let conflict = false;
          for (const cRect of rects) {
            for (const pRect of page.occupancy) {
              if (cRect[0] < pRect[2] && cRect[2] > pRect[0] &&
                  cRect[1] < pRect[3] && cRect[3] > pRect[1]) {
                conflict = true;
                break;
              }
            }
            if (conflict) break;
          }
          if (!conflict) {
            page.imgIds.push(imgId);
            page.occupancy.push(...rects);
            assigned = true;
            break;
          }
        }

        if (!assigned) {
          pages.push({ imgIds: [imgId], occupancy: [...rects] });
        }
      }

      for (const page of pages) {
        const pageImgIds = new Set(page.imgIds);
        pageList.push({
          W,
          H,
          items: entries
            .filter((e) => pageImgIds.has(e.img.id))
            .map((e) => ({ img: e.img, ann: e.ann })),
        });
      }
    }

    // 图片和 COCO 落在目标目录内；枚举稍后在其目标目录所在卷单独暂存。
    fs.mkdirSync(targetFolder, { recursive: true });
    const stagingRoot = fs.mkdtempSync(path.join(targetFolder, '.ok-toolkit-export-'));
    const stagedImagesDir = path.join(stagingRoot, 'images');
    let enumStagingRoot: string | undefined;
    let preserveStaging = false;
    try {
    fs.mkdirSync(stagedImagesDir);
    // ── 4. 构建 page 渲染任务（id/file_name 确定性：第 i 个 page → images/{i+1}.png）──
    //    同一原图的全部 bbox 归入同一条 source；bin-packing 保证每张原图只出现在
    //    一个 page，因此整轮渲染每张原图恰好解码一次，无需跨 page 解码缓存。
    const pageTasks: AssetPackPageTask[] = pageList.map((page, pageIndex) => {
      const byImage = new Map<number, { imagePath: string; rects: Array<[number, number, number, number]> }>();
      for (const it of page.items) {
        const rect = it.ann.bbox.map(Math.round) as [number, number, number, number];
        const group = byImage.get(it.img.id);
        if (group) group.rects.push(rect);
        else byImage.set(it.img.id, { imagePath: path.join(this.templateFolder, it.img.file_name), rects: [rect] });
      }
      return {
        W: page.W,
        H: page.H,
        outPath: path.join(stagedImagesDir, `${pageIndex + 1}.png`),
        sources: [...byImage.values()],
      };
    });

    // COCO 元数据与渲染解耦：file_name/bbox 都是确定性的，渲染只产出像素文件
    const newImages: CocoImage[] = [];
    const newAnnotations: CocoAnnotation[] = [];
    let nextAnnId = 1;
    for (let pageIndex = 0; pageIndex < pageTasks.length; pageIndex++) {
      const packedImgId = pageIndex + 1;
      newImages.push({
        id: packedImgId,
        file_name: `images/${packedImgId}.png`,
        width: pageTasks[pageIndex].W,
        height: pageTasks[pageIndex].H,
      });
      for (const it of pageList[pageIndex].items) {
        const [bx, by, bw, bh] = it.ann.bbox.map(Math.round) as [number, number, number, number];
        newAnnotations.push({
          id: nextAnnId++,
          image_id: packedImgId,
          category_id: it.ann.category_id,
          bbox: [bx, by, bw, bh],
          area: bw * bh,
          iscrowd: 0,
        });
      }
    }

    // ── 5. 渲染全部 page：优先 worker 池并行（解码/deflate 离开主线程），失败回退内联 ──
    const total = pageTasks.length;
    if (total > 0 && isAssetPackPoolInitialized()) {
      try {
        await renderPagesViaPool(
          pageTasks,
          onProgress,
          () => cancellationToken?.isCancellationRequested ?? false,
        );
      } catch (err) {
        if (err instanceof AssetPackCancelledError) throw new vscode.CancellationError();
        // worker 崩溃等异常：已落盘的 page 保留，缺失的由下面的内联回退补渲
      }
    }

    // 内联回退：只补渲缺失的 page（worker 全部成功时这里一次都不跑）
    const pageMissing = (outPath: string): boolean => {
      try { return !fs.existsSync(outPath) || fs.statSync(outPath).size === 0; } catch { return true; }
    };
    let completed = total - pageTasks.filter((t) => pageMissing(t.outPath)).length;
    for (const task of pageTasks) {
      if (!pageMissing(task.outPath)) continue;
      if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
      await this.renderPageInline(task);
      completed++;
      onProgress?.(completed, total);
    }

    // ── 6. 构建并写入 COCO JSON ──
    const croppedCoco: CocoData = {
      images: newImages,
      annotations: newAnnotations,
      categories: [...this.cocoData.categories],
    };

    // 清理无引用的分类
    const usedCatIds = new Set(newAnnotations.map((a) => a.category_id));
    croppedCoco.categories = croppedCoco.categories.filter((c) => usedCatIds.has(c.id));

    // COCO 与可选枚举也先写到临时目录；任何生成失败都不触碰旧产物。
    const cocoTarget = path.join(targetFolder, COCO_JSON);
    const stagedCoco = path.join(stagingRoot, COCO_JSON);
    fs.writeFileSync(stagedCoco, JSON.stringify(croppedCoco, null, 2), 'utf-8');

    let stagedEnum: string | undefined;
    const enumInImages = enumFile !== undefined && isPathInsideRoot(targetImagesDir, enumFile);
    if (enumFile) {
      const labels = croppedCoco.categories.map(c => c.name).sort();
      if (!enumInImages) {
        // enumFile 可能经挂载点指向另一卷，必须在它自己的父目录暂存与备份。
        const enumParent = path.dirname(enumFile);
        fs.mkdirSync(enumParent, { recursive: true });
        enumStagingRoot = fs.mkdtempSync(path.join(enumParent, '.ok-toolkit-enum-'));
      }
      stagedEnum = enumInImages
        ? path.join(stagedImagesDir, path.relative(targetImagesDir, enumFile))
        : path.join(enumStagingRoot!, 'new', path.basename(enumFile));
      this.generateLabelEnum(stagedEnum, labels, folderUri);
    }
    if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();

    // 逐项保留旧产物，失败时按相反顺序恢复。提交开始后不再响应取消。
    type ExportMove = { destination: string; staged: string; backup: string; hadOriginal: boolean; installed: boolean };
    const moves: ExportMove[] = [
      { destination: targetImagesDir, staged: stagedImagesDir, backup: path.join(stagingRoot, 'old-images'), hadOriginal: false, installed: false },
      { destination: cocoTarget, staged: stagedCoco, backup: path.join(stagingRoot, 'old-coco.json'), hadOriginal: false, installed: false },
    ];
    if (enumFile && stagedEnum && !enumInImages) {
      moves.push({ destination: enumFile, staged: stagedEnum, backup: path.join(enumStagingRoot!, 'old', path.basename(enumFile)), hadOriginal: false, installed: false });
    }
    try {
      for (const move of moves) {
        fs.mkdirSync(path.dirname(move.destination), { recursive: true });
        if (fs.existsSync(move.destination)) {
          fs.mkdirSync(path.dirname(move.backup), { recursive: true });
          fs.renameSync(move.destination, move.backup);
          move.hadOriginal = true;
        }
        fs.renameSync(move.staged, move.destination);
        move.installed = true;
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const move of [...moves].reverse()) {
        try {
          if (move.installed) fs.renameSync(move.destination, move.staged);
          if (move.hadOriginal) fs.renameSync(move.backup, move.destination);
        } catch (rollbackError) {
          rollbackErrors.push(String(rollbackError));
        }
      }
      if (rollbackErrors.length) {
        preserveStaging = true;
        const backupLocations = [stagingRoot, enumStagingRoot].filter(Boolean).join(', ');
        throw new Error(`Export failed and rollback was incomplete; backups remain at ${backupLocations}: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    }
    } finally {
      // 回滚不完整时保留旧产物备份，供人工恢复。
      if (!preserveStaging) {
        try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* 清理失败不改变提交结果 */ }
        if (enumStagingRoot) {
          try { fs.rmSync(enumStagingRoot, { recursive: true, force: true }); } catch { /* 同上 */ }
        }
      }
    }
  }

  /**
   * 主线程内联渲染单个 page（worker 池不可用时的回退路径）。
   * 行为与 worker 版一致：白底画布 + 原坐标粘贴 + RGB level-6 PNG；
   * 每个重操作（解码/编码）之前让出事件循环，避免长时间冻结扩展宿主。
   */
  private async renderPageInline(task: AssetPackPageTask): Promise<void> {
    const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
    const canvasRgba = Buffer.alloc(task.W * task.H * 4, 255);
    for (const src of task.sources) {
      await yieldToLoop();
      try {
        const decoded = decodeRgba(fs.readFileSync(src.imagePath));
        for (const [bx, by, bw, bh] of src.rects) {
          const x1 = Math.max(0, bx);
          const y1 = Math.max(0, by);
          const x2 = Math.min(task.W, bx + bw);
          const y2 = Math.min(task.H, by + bh);
          if (x2 > x1 && y2 > y1) {
            for (let y = y1; y < y2; y++) {
              const srcStart = (y * decoded.width + x1) * 4;
              const dstStart = (y * task.W + x1) * 4;
              decoded.rgba.copy(canvasRgba, dstStart, srcStart, srcStart + (x2 - x1) * 4);
            }
          }
        }
      } catch {
        // 源图读取失败，跳过（与 worker 行为一致）
      }
    }
    await yieldToLoop();
    fs.mkdirSync(path.dirname(task.outPath), { recursive: true });
    fs.writeFileSync(task.outPath, encodePngRgb(task.W, task.H, canvasRgba));
  }

  /**
   * Generate a Python enum file from category labels.
   *
   * 标签来自用户输入的分类名，会**直接拼进 Python 源码**，所以两处都必须处理：
   *
   * 1. **值**用 `JSON.stringify` 序列化 —— JSON 字符串字面量与 Python 单引号字符串在
   *    转义规则上不完全等价（`'` 在 JSON 里不必转义、在 Python 里必须转义），所以这里
   *    保留单引号外壳、只替换会破坏字面量的字符，并统一走显式转义函数。
   * 2. **成员名**必须是合法 Python 标识符。分类名带空格 / 连字符 / 中文时，
   *    `   洗手 台 = '...'` 这种行会让整个文件 `SyntaxError`，用户拿到的枚举文件直接不能用。
   */
  private generateLabelEnum(filePath: string, labels: string[], folderUri?: vscode.Uri): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 类名走取值链：**IDE 设置 labelEnumName > 项目约定 labelEnum.name > 文件名推导**。
    // 解耦的意义：文件可以叫 feature_labels.py，而类叫 FeatureList。
    // （旧写法只有 basename 一条路，想叫 FeatureList 就必须把文件命名成 FeatureList.py。）
    //
    // 配置从**本对象自己的 rootDir** 读 —— 与构造函数里 `templatesDirectory(this.rootDir)`
    // 同一个根。模板数据可能来自另一个仓库，用错根会读到别人的约定文件。
    //
    // ⚠️ 个人覆盖会改掉写进源码的类名，而项目的代码按名字 import。那道闸不在这一层：
    // 覆盖前的确认在 `templateAssetPanel.ts`（UI 层）做，见 `labelEnumGuard.ts`。
    const rawClassName = labelEnumNameSetting(filePath, this.rootDir, folderUri).value;
    // 类名同样进源码：非法标识符直接退回一个安全的默认名，而不是生成坏文件。
    // 走 `writableClassName` 而**不是**内联一个正则 —— 面板的写入前校验要用**同一个**函数
    // 算"将要写入的类名"，两处各写一遍会让警告内容与实际写进去的东西不符。
    const className = writableClassName(rawClassName);
    let content = 'from enum import Enum\n\n\n';
    content += `class ${className}(str, Enum):\n`;
    if (labels.length === 0) {
      // 空枚举的类体不能什么都没有 —— 否则是 `IndentationError: expected an indented block`
      content += '    pass\n';
    }
    const usedMemberNames = new Set<string>();
    for (const label of labels) {
      // 值：单引号包裹，转义反斜杠与单引号（其余控制字符由 pythonLiteral 兜住）
      const baseName = memberNameFor(label);
      let memberName = baseName;
      let suffix = 2;
      while (usedMemberNames.has(memberName)) memberName = `${baseName}_${suffix++}`;
      usedMemberNames.add(memberName);
      content += `    ${memberName} = ${pythonStringLiteral(label)}\n`;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /* ---------- 导入外部图片文件 ---------- */

  /**
   * 把外部图片文件复制进模板目录。文件名使用 nextImageName() 生成的序号
   * （保持与面板导入一致的行为）。返回落盘后的绝对路径，失败返回 undefined。
   *
   * **不写 `coco_annotations.json`**：导入只是把文件放进模板目录。图片条目由
   * **标注保存流程**按需补登记（`setAnnotationsForImage` → `ensureSwapImage`）——
   * 否则"导进来但一张框都没标"的图会立刻在标注文件里占一条空记录。
   * 模板序号占位同时看磁盘与 COCO（见 `nextImageName`），所以不登记也不会撞名。
   */
  importImageFile(srcPath: string): string | undefined {
    try {
      this.ensureTemplateFolder();
      const ext = path.extname(srcPath);
      const name = this.nextImageName() + ext;
      const dst = path.join(this.templateFolder, name);
      fs.copyFileSync(srcPath, dst);
      return dst;
    } catch {
      return undefined;
    }
  }
}

/* ---------------- Python 源码生成助手 ---------------- */

/**
 * 把一段用户输入变成合法的 Python 单引号字符串字面量（含引号）。
 *
 * 为什么不用 `JSON.stringify`：JSON 与 Python 的字符串转义规则**不完全重合**。
 * JSON 里单引号无需转义（`"\u0027"` 反而可选），而 Python 单引号字面量里 `\'` 是必需的；
 * 反之 JSON 允许裸的 `\/`，Python 也接受但语义微妙。所以这里逐字符显式转义，
 * 只保留两边都安全的表示，避免"看起来能跑、换一个标签就炸"。
 */
export function pythonStringLiteral(value: string): string {
  let out = "'";
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '\'': out += '\\\''; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default: {
        const code = ch.codePointAt(0)!;
        // 控制字符（含 \x00-\x1f 与 \x7f）一律走 \xNN，避免源文件里出现裸控制字符
        if (code < 0x20 || code === 0x7f) {
          // 代理对不需要处理：上面已按码点判断，控制字符都是单码元
          out += `\\x${code.toString(16).padStart(2, '0')}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return `${out}'`;
}

/**
 * 把分类名转成合法的 Python 枚举成员名。
 *
 * Python 标识符不允许空格、连字符、数字开头；非 ASCII 中文虽然**语法上**能当标识符，
 * 但枚举成员会被 `LabelEnum.洗手台` 这样引用，中文成员名在大多数工具链里都是坑，
 * 因此统一规范化成 `cat_<hex>` 形式的纯 ASCII 名。
 *
 * **成员名与值相互独立**：值保留原始标签（`pythonStringLiteral(label)`），
 * 所以 `LabelEnum.cat_6d17_53f0.value == '洗手台'` 依然成立 —— 规范化不丢信息。
 */
export function memberNameFor(label: string): string {
  // 逐码点替换，避免非 BMP 字符在 JS 与 JVM 上分别变成两个和一个下划线。
  const ascii = [...label].map((ch) => /^[A-Za-z0-9_]$/.test(ch) ? ch : '_').join('');
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(ascii)) {
    // Enum.mro 是内建方法名，不能用作成员名。
    return PYTHON_KEYWORDS.has(ascii) || ascii === 'mro' ? `${ascii}_` : ascii;
  }

  // 数字开头、前导下划线（Enum 的私有/保留名）及全非 ASCII 标签统一编码。
  // 保留原始值，编码只影响源码中的成员名。
  const codepoints = [...label].map((c) => c.codePointAt(0)!);
  const suffix = codepoints.map((c) => c.toString(16)).join('_');
  const prefix = /^[0-9]/.test(ascii) ? 'n' : 'cat';
  const candidate = suffix ? `${prefix}_${suffix}` : prefix;
  return candidate;
}
