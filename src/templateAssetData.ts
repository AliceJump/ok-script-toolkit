import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeRgba, encodePngRgb, readImageSize } from './pngCrop';
import {
  AssetPackCancelledError, AssetPackPageTask,
  isAssetPackPoolInitialized, renderPagesViaPool,
} from './assetPack';
import { tr } from './localization';

/* ---------------- COCO 数据类型 ---------------- */

export interface CocoImage {
  id: number;
  file_name: string;
  width: number;
  height: number;
}

export interface CocoAnnotation {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number]; // [x, y, w, h]
  area: number;
  iscrowd: number;
}

export interface CocoCategory {
  id: number;
  name: string;
  supercategory: string;
}

export interface CocoData {
  images: CocoImage[];
  annotations: CocoAnnotation[];
  categories: CocoCategory[];
}

/* ---------------- 文件名归一化（兼容大小写/扩展名） ---------------- */

export function filenameKey(name: string): string {
  return path.basename(name).toLowerCase().replace(/\.[^.]+$/, '');
}

/* ---------------- 模板素材数据管理 ---------------- */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);
const TEMPLATE_FOLDER = 'ok_templates';
const COCO_JSON = 'coco_annotations.json';

/** 只读图片头拿宽高（PNG/JPEG/BMP），不做像素解码；失败返回 undefined */
function readImageHeaderSize(src: string): { width: number; height: number } | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(src, 'r');
    // JPEG 的 SOF marker 可能被 EXIF 等大 APP 段推后，多读一些
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return readImageSize(buf.subarray(0, read));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export class TemplateAssetData {
  private rootDir: string;
  private cocoData: CocoData = { images: [], annotations: [], categories: [] };
  private cocoPath: string;
  private templateFolder: string;
  private _dirty = false;

  constructor(root: vscode.WorkspaceFolder | string | undefined) {
    this.rootDir = typeof root === 'string' ? root : root ? root.uri.fsPath : '';
    this.templateFolder = path.join(this.rootDir, TEMPLATE_FOLDER);
    this.cocoPath = path.join(this.templateFolder, COCO_JSON);
  }

  /** Add an image file to COCO data (static helper for external callers). */
  static async addImageToCoco(imagePath: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error(tr('noWorkspaceFolder'));
    const data = new TemplateAssetData(folder);
    await data.load();
    data.addImageEntry(imagePath, 0, 0);
    // Read actual dimensions (PNG/JPEG/BMP via header)
    try {
      const buf = fs.readFileSync(imagePath);
      const dims = readImageSize(buf);
      if (dims) {
        const img = data.cocoData.images.find(i => i.file_name === path.basename(imagePath));
        if (img) { img.width = dims.width; img.height = dims.height; }
      }
    } catch { /* ignore */ }
    data.save();
  }

  get root(): string { return this.rootDir; }
  get templatesDir(): string { return this.templateFolder; }

  /* ---------- 初始化/加载 ---------- */

  ensureTemplateFolder(): string {
    if (!fs.existsSync(this.templateFolder)) {
      fs.mkdirSync(this.templateFolder, { recursive: true });
    }
    return this.templateFolder;
  }

  load(): CocoData {
    this.ensureTemplateFolder();
    if (fs.existsSync(this.cocoPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cocoPath, 'utf-8'));
        this.cocoData = {
          images: raw.images ?? [],
          annotations: raw.annotations ?? [],
          categories: raw.categories ?? [],
        };
      } catch {
        this.cocoData = { images: [], annotations: [], categories: [] };
      }
    } else {
      this.cocoData = { images: [], annotations: [], categories: [] };
    }
    this._dirty = false;
    return this.cocoData;
  }

  save(): void {
    this.ensureTemplateFolder();
    fs.writeFileSync(this.cocoPath, JSON.stringify(this.cocoData, null, 2), 'utf-8');
    this._dirty = false;
  }

  get data(): CocoData { return this.cocoData; }

  /* ---------- 图片列表 ---------- */

  listImages(): string[] {
    this.ensureTemplateFolder();
    try {
      return fs.readdirSync(this.templateFolder)
        .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
        .sort((a, b) => {
          const sa = fs.statSync(path.join(this.templateFolder, a));
          const sb = fs.statSync(path.join(this.templateFolder, b));
          return sb.mtimeMs - sa.mtimeMs; // 最新的在前
        })
        .map((f) => path.join(this.templateFolder, f));
    } catch {
      return [];
    }
  }

  /* ---------- 图片名称管理 ---------- */

  nextImageName(): string {
    const existing = new Set(
      this.cocoData.images.map((img) => path.basename(img.file_name, path.extname(img.file_name)))
    );
    let i = 1;
    while (existing.has(String(i))) i++;
    return String(i);
  }

  /* ---------- COCO 图片操作 ---------- */

  getImageEntryForPath(imagePath: string): CocoImage | undefined {
    const key = filenameKey(imagePath);
    return this.cocoData.images.find((img) => filenameKey(img.file_name) === key);
  }

  getImageId(imagePath: string): number | undefined {
    return this.getImageEntryForPath(imagePath)?.id;
  }

  addImageEntry(imagePath: string, width: number, height: number): void {
    const filename = path.basename(imagePath);
    if (this.getImageEntryForPath(imagePath)) return;
    let maxId = 0;
    for (const img of this.cocoData.images) {
      if (img.id > maxId) maxId = img.id;
    }
    this.cocoData.images.push({ id: maxId + 1, file_name: filename, width, height });
    this._dirty = true;
  }

  removeImageEntry(imagePath: string): void {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return;
    this.cocoData.images = this.cocoData.images.filter((img) => img.id !== imageId);
    this.cocoData.annotations = this.cocoData.annotations.filter((ann) => ann.image_id !== imageId);
    this._cleanupCategories();
    this._dirty = true;
  }

  /* ---------- COCO 标注操作 ---------- */

  getAnnotationsForImage(imagePath: string): Array<CocoAnnotation & { categoryName: string }> {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return [];
    return this.cocoData.annotations
      .filter((ann) => ann.image_id === imageId)
      .map((ann) => ({
        ...ann,
        categoryName: this.getCategoryName(ann.category_id) || String(ann.category_id),
      }));
  }

  setAnnotationsForImage(imagePath: string, annotations: Array<{ category: string; x: number; y: number; w: number; h: number }>): void {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return;
    // 移除旧标注
    this.cocoData.annotations = this.cocoData.annotations.filter((ann) => ann.image_id !== imageId);
    // 添加新标注
    let maxAnnId = 0;
    for (const ann of this.cocoData.annotations) {
      if (ann.id > maxAnnId) maxAnnId = ann.id;
    }
    for (const ann of annotations) {
      const catId = this._getOrCreateCategoryId(ann.category);
      maxAnnId++;
      this.cocoData.annotations.push({
        id: maxAnnId,
        image_id: imageId,
        category_id: catId,
        bbox: [ann.x, ann.y, ann.w, ann.h],
        area: ann.w * ann.h,
        iscrowd: 0,
      });
    }
    this._cleanupCategories();
    this._dirty = true;
  }

  /* ---------- 分类操作 ---------- */

  getCategoryName(catId: number): string | undefined {
    return this.cocoData.categories.find((c) => c.id === catId)?.name;
  }

  _getOrCreateCategoryId(name: string): number {
    const existing = this.cocoData.categories.find((c) => c.name === name);
    if (existing) return existing.id;
    let maxId = 0;
    for (const c of this.cocoData.categories) {
      if (c.id > maxId) maxId = c.id;
    }
    const newId = maxId + 1;
    this.cocoData.categories.push({ id: newId, name, supercategory: '' });
    return newId;
  }

  _cleanupCategories(): void {
    const usedIds = new Set(this.cocoData.annotations.map((ann) => ann.category_id));
    this.cocoData.categories = this.cocoData.categories.filter((c) => usedIds.has(c.id));
  }

  /* ---------- 获取图片关联的分类名 ---------- */

  getCategoriesForImage(imagePath: string): string[] {
    const imageId = this.getImageId(imagePath);
    if (imageId === undefined) return [];
    const catIds = new Set(
      this.cocoData.annotations
        .filter((ann) => ann.image_id === imageId)
        .map((ann) => ann.category_id)
    );
    return this.cocoData.categories
      .filter((c) => catIds.has(c.id))
      .map((c) => c.name);
  }

  /* ---------- 删除图片文件和COCO数据 ---------- */

  deleteImage(imagePath: string): boolean {
    try {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      this.removeImageEntry(imagePath);
      this.save();
      return true;
    } catch {
      return false;
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
   * cancellationToken 可在渲染中途取消（已完成的 page 保留，抛 CancellationError）。
   */
  async saveToAssets(
    targetFolder: string,
    generateEnum = false,
    enumPath?: string,
    onProgress?: (done: number, total: number) => void,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellationToken?.isCancellationRequested) throw new vscode.CancellationError();
    const targetImagesDir = path.join(targetFolder, 'images');

    // 清空目标目录中的旧图片（重新生成前清理）
    if (fs.existsSync(targetImagesDir)) {
      for (const f of fs.readdirSync(targetImagesDir)) {
        try { fs.unlinkSync(path.join(targetImagesDir, f)); } catch { /* ignore */ }
      }
    }
    if (!fs.existsSync(targetImagesDir)) fs.mkdirSync(targetImagesDir, { recursive: true });

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
        outPath: path.join(targetImagesDir, `${pageIndex + 1}.png`),
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

    // writeFileSync 直接覆盖旧的 coco_annotations.json；
    // 不再清扫目录下其他 .json——目标目录（如 assets/）顶层可能放有无关 JSON
    const cocoTarget = path.join(targetFolder, COCO_JSON);
    fs.writeFileSync(cocoTarget, JSON.stringify(croppedCoco, null, 2), 'utf-8');

    // Generate label enum if requested
    if (generateEnum) {
      const labels = croppedCoco.categories.map(c => c.name).sort();
      const enumFile = enumPath || path.join(targetFolder, 'LabelEnum.py');
      this.generateLabelEnum(enumFile, labels);
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

  /** Generate a Python enum file from category labels. */
  private generateLabelEnum(filePath: string, labels: string[]): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const className = path.basename(filePath, '.py');
    let content = 'from enum import Enum\n\n\n';
    content += `class ${className}(str, Enum):\n`;
    for (const label of labels) {
      content += `    ${label} = '${label}'\n`;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /* ---------- 添加截图（base64 PNG） ---------- */

  addScreenshot(base64Png: string): string | undefined {
    try {
      this.ensureTemplateFolder();
      const name = this.nextImageName();
      const filePath = path.join(this.templateFolder, `${name}.png`);
      const buf = Buffer.from(base64Png, 'base64');
      fs.writeFileSync(filePath, buf);

      // 读取图片尺寸
      const dims = readImageSize(buf);
      this.addImageEntry(filePath, dims?.width ?? 0, dims?.height ?? 0);
      this.save();
      return filePath;
    } catch {
      return undefined;
    }
  }
}
