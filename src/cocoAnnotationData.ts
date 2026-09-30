/** Shared COCO authoring for templates and boxes. No VS Code dependency. */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { readImageSize } from './imageHeader';
import { pixelBboxError } from './annotationGeometry';

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

export function filenameKey(name: string): string {
  return path.basename(name).toLowerCase().replace(/\.[^.]+$/, '');
}

/* ---------------- 模板素材数据管理 ---------------- */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

/** 只读图片头拿宽高（PNG/JPEG/BMP），不做像素解码；失败返回 undefined */
export function readImageHeaderSize(src: string): { width: number; height: number } | undefined {
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

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

export type CocoDecoder = (text: string) => { data: CocoData; errors: string[]; legacy?: boolean };

export function emptyCocoData(): CocoData {
  return { images: [], annotations: [], categories: [] };
}

export const parseCocoData: CocoDecoder = (text) => {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: emptyCocoData(), errors: ['root'] };
    if (!['images', 'annotations', 'categories'].every(key => Array.isArray(raw[key]))) {
      return { data: emptyCocoData(), errors: ['coco'] };
    }
    const errors: string[] = [];
    const imageIds = new Set<number>();
    const categoryIds = new Set<number>();
    const annotationIds = new Set<number>();
    for (const [index, image] of raw.images.entries()) {
      if (!image || !Number.isInteger(image.id) || imageIds.has(image.id) || typeof image.file_name !== 'string'
        || !image.file_name || !Number.isFinite(image.width) || !Number.isFinite(image.height)
        || image.width < 0 || image.height < 0) errors.push('image:' + index);
      else imageIds.add(image.id);
    }
    for (const [index, category] of raw.categories.entries()) {
      if (!category || !Number.isInteger(category.id) || categoryIds.has(category.id) || typeof category.name !== 'string') errors.push('category:' + index);
      else categoryIds.add(category.id);
    }
    for (const [index, annotation] of raw.annotations.entries()) {
      const image = raw.images.find((item: CocoImage) => item?.id === annotation?.image_id);
      if (!annotation || !Number.isInteger(annotation.id) || annotationIds.has(annotation.id)
        || !imageIds.has(annotation.image_id) || !categoryIds.has(annotation.category_id)
        || !Array.isArray(annotation.bbox) || pixelBboxError(annotation.bbox, image)) errors.push('annotation:' + index);
      else annotationIds.add(annotation.id);
    }
    return errors.length ? { data: emptyCocoData(), errors }
      : { data: { images: raw.images, annotations: raw.annotations, categories: raw.categories }, errors: [] };
  } catch {
    return { data: emptyCocoData(), errors: ['json'] };
  }
};

/** Keep structurally readable template records visible; readErrors still blocks writes. */
function templateDisplayData(text: string): CocoData {
  try {
    const raw = JSON.parse(text);
    if (!raw || !['images', 'annotations', 'categories'].every(key => Array.isArray(raw[key]))) return emptyCocoData();
    return {
      images: raw.images.filter((image: CocoImage) => image && Number.isInteger(image.id)
        && typeof image.file_name === 'string' && Number.isFinite(image.width) && Number.isFinite(image.height)),
      categories: raw.categories.filter((category: CocoCategory) => category && Number.isInteger(category.id)
        && typeof category.name === 'string'),
      annotations: raw.annotations.filter((annotation: CocoAnnotation) => annotation
        && [annotation.id, annotation.image_id, annotation.category_id].every(Number.isInteger)
        && Array.isArray(annotation.bbox) && annotation.bbox.length === 4 && annotation.bbox.every(Number.isFinite)),
    };
  } catch { return emptyCocoData(); }
}

const changeListeners = new Set<(file: string) => void>();
export function onAnnotationDataChanged(listener: (file: string) => void): { dispose(): void } {
  changeListeners.add(listener);
  return { dispose: () => { changeListeners.delete(listener); } };
}
export function sameAnnotationFile(a: string, b: string): boolean {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
export function notifyAnnotationDataChanged(file: string): void {
  for (const listener of changeListeners) {
    try { listener(path.resolve(file)); } catch (error) { console.error('[ok-script] refresh annotations:', error); }
  }
}

export function writeAnnotationText(file: string, text: string, notify = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, text, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); break; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve the write error */ }
  }
  if (notify) notifyAnnotationDataChanged(file);
}

export class CocoAnnotationData {
  protected cocoData: CocoData = emptyCocoData();
  protected cocoPath: string;
  protected templateFolder: string;
  protected _dirty = false;
  readErrors: string[] = [];
  private legacy = false;
  private loadedText: string | undefined;
  get revision(): string | undefined { return this.loadedText; }

  constructor(protected rootDir: string, directory: string, readonly fileName = 'coco_annotations.json', private readonly decode: CocoDecoder = parseCocoData) {
    this.templateFolder = path.resolve(rootDir, directory);
    this.cocoPath = path.join(this.templateFolder, fileName);
  }

  setRoot(rootDir: string, directory: string): void {
    this.rootDir = rootDir;
    this.templateFolder = path.resolve(rootDir, directory);
    this.cocoPath = path.join(this.templateFolder, this.fileName);
    this.cocoData = emptyCocoData();
    this.readErrors = [];
    this.legacy = false;
    this.loadedText = undefined;
  }

  get annotationFile(): string { return this.cocoPath; }

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
    this.readErrors = [];
    this.legacy = false;
    this.loadedText = undefined;
    try {
      this.loadedText = fs.readFileSync(this.cocoPath, 'utf8');
      const parsed = this.decode(this.loadedText);
      this.cocoData = this.fileName === 'coco_annotations.json' && parsed.errors.length
        ? templateDisplayData(this.loadedText) : parsed.data;
      this.readErrors = parsed.errors;
      this.legacy = parsed.legacy === true;
    } catch (error) {
      this.cocoData = emptyCocoData();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.readErrors = ['read'];
    }
    this._dirty = false;
    return this.cocoData;
  }

  save(): void {
    if (this.readErrors.length) throw new Error('Unreadable annotation file: ' + this.readErrors.join(', '));
    // Conversion is read-only until a successful edit. Keep the original legacy source.
    if (this.legacy && fs.existsSync(this.cocoPath)) {
      fs.copyFileSync(this.cocoPath, this.cocoPath + '.pre-coco.' + randomUUID() + '.bak', fs.constants.COPYFILE_EXCL);
    }
    const text = JSON.stringify(this.cocoData, null, 2);
    writeAnnotationText(this.cocoPath, text, false);
    this.loadedText = text;
    this.legacy = false;
    this._dirty = false;
    notifyAnnotationDataChanged(this.cocoPath);
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
      [...this.cocoData.images.map(img => img.file_name), ...this.listImages()].map(name => path.basename(name, path.extname(name)))
    );
    // Both editors share the directory; reserve names even for missing files and legacy box sources.
    for (const source of new Set([this.fileName, 'coco_annotations.json', 'boxes.json'])) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.templateFolder, source), 'utf8'));
        const names: unknown[] = [
          ...(Array.isArray(raw?.images) ? raw.images.flatMap((image: { file_name?: string; file?: string } | null) => [image?.file_name, image?.file]) : []),
          ...(Array.isArray(raw?.boxes) ? raw.boxes.map((box: { image?: string } | null) => box?.image) : []),
        ];
        for (const name of names) {
          if (typeof name === 'string') existing.add(filenameKey(name.replace(/\\/g, '/')));
        }
      } catch { /* Missing or unreadable sources do not prevent copying image files. */ }
    }
    let i = 1;
    while (existing.has(String(i))) i++;
    return String(i);
  }

  /* ---------- COCO 图片操作 ---------- */

  getImageEntryForPath(imagePath: string): CocoImage | undefined {
    const key = filenameKey(imagePath);
    return this.cocoData.images.find((img) => filenameKey(img.file_name) === key);
  }

  /** Swaps must use the selected file, not the legacy same-stem fallback used by other callers. */
  getSwapImageEntry(imagePath: string): CocoImage | undefined {
    const fileName = path.basename(imagePath);
    const exact = this.cocoData.images.find((img) => img.file_name === fileName);
    if (exact) return exact;
    const caseInsensitive = this.cocoData.images.filter((img) => img.file_name.toLowerCase() === fileName.toLowerCase());
    if (caseInsensitive.length !== 1) return undefined;
    // On case-sensitive disks `foo.png` and `Foo.png` are different files; accept the fallback only for the same file.
    const candidatePath = path.join(path.dirname(imagePath), caseInsensitive[0].file_name);
    return sameFile(imagePath, candidatePath) ? caseInsensitive[0] : undefined;
  }

  getImageId(imagePath: string): number | undefined {
    return this.getImageEntryForPath(imagePath)?.id;
  }

  /**
   * 图片的**真实**尺寸，供标注交换做比例映射。
   *
   * 先读文件头再退回 COCO 记录，顺序不能反：COCO 里的 width/height 可能是 0
   * （老数据、或登记时读不出尺寸），拿 0 当除数会算出 Infinity；而反过来，
   * 文件头读不出来时 COCO 至少还是个已知值。两者都没有才返回 undefined，
   * 由调用方决定"拒绝交换"而不是"按 1 倍瞎搬"。
   */
  resolveImageSize(imagePath: string): { width: number; height: number } | undefined {
    const header = readImageHeaderSize(imagePath);
    if (header && header.width > 0 && header.height > 0) return header;
    const entry = this.getSwapImageEntry(imagePath);
    if (entry && entry.width > 0 && entry.height > 0) {
      return { width: entry.width, height: entry.height };
    }
    return undefined;
  }

  /**
   * 交换落盘前补一条图片记录。已有精确记录就用它。
   * 同名不同扩展名不能借别人的记录，必须按这次的文件名新建。
   */
  private ensureSwapImage(filePath: string, size?: { width: number; height: number }): number | undefined {
    const existing = this.getSwapImageEntry(filePath);
    if (existing) {
      if (size) {
        existing.width = size.width;
        existing.height = size.height;
      }
      return existing.id;
    }
    if (!size || size.width <= 0 || size.height <= 0) return undefined;
    const fileName = path.basename(filePath);
    const located = path.resolve(this.templateFolder, fileName);
    if (path.resolve(filePath) !== located && !sameFile(filePath, located)) return undefined;
    let maxId = 0;
    for (const img of this.cocoData.images) {
      if (img.id > maxId) maxId = img.id;
    }
    const id = maxId + 1;
    this.cocoData.images.push({ id, file_name: fileName, width: size.width, height: size.height });
    return id;
  }

  addImageEntry(imagePath: string, width: number, height: number): void {
    const filename = path.basename(imagePath);
    if (this.getSwapImageEntry(imagePath)) return;
    let maxId = 0;
    for (const img of this.cocoData.images) {
      if (img.id > maxId) maxId = img.id;
    }
    this.cocoData.images.push({ id: maxId + 1, file_name: filename, width, height });
    this._dirty = true;
  }

  removeImageEntry(imagePath: string): void {
    const imageId = this.getSwapImageEntry(imagePath)?.id;
    if (imageId === undefined) return;
    this.cocoData.images = this.cocoData.images.filter((img) => img.id !== imageId);
    this.cocoData.annotations = this.cocoData.annotations.filter((ann) => ann.image_id !== imageId);
    this._cleanupCategories();
    this._dirty = true;
  }

  /* ---------- COCO 标注操作 ---------- */

  getAnnotationsForImage(imagePath: string, exactFileName = false): Array<CocoAnnotation & { categoryName: string }> {
    const imageId = exactFileName ? this.getSwapImageEntry(imagePath)?.id : this.getImageId(imagePath);
    if (imageId === undefined) return [];
    return this.cocoData.annotations
      .filter((ann) => ann.image_id === imageId)
      .map((ann) => ({
        ...ann,
        categoryName: this.getCategoryName(ann.category_id) || String(ann.category_id),
      }));
  }

  setAnnotationsForImage(imagePath: string, annotations: Array<{ category: string; x: number; y: number; w: number; h: number }>): boolean {
    const size = this.resolveImageSize(imagePath);
    if (!size || annotations.some(ann => pixelBboxError([ann.x, ann.y, ann.w, ann.h], size))) return false;
    const imageId = this.ensureSwapImage(imagePath, size);
    if (imageId === undefined) return false;
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
    return true;
  }

  /**
   * 两张图的标注集合**整体互换**。`boxesForA` / `boxesForB` 是调用方算好的**最终**坐标
   * （已按目标图尺寸映射过，见 `annotationSwapPure.scaleBoxes`），本方法只负责落数据。
   *
   * 为什么不能"调两次 setAnnotationsForImage"：
   * ① 那条路径每次都 `_cleanupCategories()`。先写的那一侧会把"只有自己引用"的分类
   *    判成无人使用而删掉，紧接着写另一侧时再按名字重建 —— 分类名不变、**id 会漂**。
   *    中间那一刻的 cocoData 也是自相矛盾的（A 的标注已经搬走、B 的还是旧的）。
   * ② 两次调用之间任何一处抛错，会留下"换了一半"的内存状态。
   * 在副本上先摘掉旧标注、写回两边、清理分类，再一次性保存。
   * 保存失败时恢复原内存数据，磁盘文件也不会被截断。
   *
   * 返回 false 只表示这两张图没法交换（读不出尺寸，或指向同一张图）。
   * 磁盘上有、但还没写进标注文件的图会在这次保存里补登记；它原来没有框，
   * 交换后拿到的就是对方的框，对方则变成没有框。失败时什么都不改。
   */
  swapAnnotationsForImages(
    pathA: string,
    pathB: string,
    boxesForA: Array<{ category: string; x: number; y: number; w: number; h: number }>,
    boxesForB: Array<{ category: string; x: number; y: number; w: number; h: number }>,
    sizeA?: { width: number; height: number },
    sizeB?: { width: number; height: number },
  ): boolean {
    const previousData = this.cocoData;
    const previousDirty = this._dirty;
    this.cocoData = {
      images: previousData.images.map(image => ({ ...image })),
      annotations: [...previousData.annotations],
      categories: [...previousData.categories],
    };
    const idA = this.ensureSwapImage(pathA, sizeA);
    const idB = this.ensureSwapImage(pathB, sizeB);
    if (idA === undefined || idB === undefined || idA === idB) {
      this.cocoData = previousData;
      this._dirty = previousDirty;
      return false;
    }
    try {
      this.cocoData.annotations = this.cocoData.annotations.filter(
        (ann) => ann.image_id !== idA && ann.image_id !== idB,
      );

      let maxAnnId = 0;
      for (const ann of this.cocoData.annotations) {
        if (ann.id > maxAnnId) maxAnnId = ann.id;
      }
      const append = (imageId: number, boxes: typeof boxesForA): void => {
        for (const box of boxes) {
          const catId = this._getOrCreateCategoryId(box.category);
          maxAnnId++;
          this.cocoData.annotations.push({
            id: maxAnnId,
            image_id: imageId,
            category_id: catId,
            bbox: [box.x, box.y, box.w, box.h],
            area: box.w * box.h,
            iscrowd: 0,
          });
        }
      };
      append(idA, boxesForA);
      append(idB, boxesForB);

      this._cleanupCategories();
      this._dirty = true;
      this.save();
      return true;
    } catch (error) {
      this.cocoData = previousData;
      this._dirty = previousDirty;
      throw error;
    }
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
    const imageId = this.getSwapImageEntry(imagePath)?.id;
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

}
