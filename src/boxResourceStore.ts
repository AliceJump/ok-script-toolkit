/**
 * 框资源的读盘侧。纯规则在 `boxResourcePure.ts`。
 *
 * Authoring 是 Pixel bbox + 图片尺寸（version 2），与模板标注同一模型；
 * normalized 只存在于 Runtime / Publish。version 1（旧 normalized）不受支持，
 * 读盘直接报 `version` 错误，不做迁移。
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AuthoringBox,
  AuthoringFile,
  PixelBox,
  RuntimeFile,
  authoringFile,
  boxesForImageFile,
  boxPathError,
  effectiveBoxRuntimeFile,
  emptyAuthoringFile,
  emptyRuntimeFile,
  imageFileName,
  parseAuthoring,
  parseRuntime,
  pixelBboxError,
  publishBoxes,
  publishStatus,
  replaceAuthoringImages,
  resolveBoxRuntimePlan,
  roundPixelBbox,
  runtimeWriteTarget,
  sameBoxFile,
  serializeAuthoring,
  serializeRuntime,
  swapImageBoxes as swapImageBoxesPure,
  unionPixelBoxes,
} from './boxResourcePure';
import { readImageSize } from './imageHeader';

export interface EditedBox {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function sameImage(a: string, b: string): boolean {
  return imageFileName(a).toLowerCase() === imageFileName(b).toLowerCase();
}

/** 发布目标和标注文件是否是同一个文件。已存在的符号链接按真实路径比较。 */
function sameStoredFile(a: string, b: string): boolean {
  try {
    if (fs.existsSync(a) && fs.existsSync(b)) return sameBoxFile(fs.realpathSync(a), fs.realpathSync(b));
  } catch {
    // 读真实路径失败时退回规范化路径，避免把标注文件当成可写的运行时目标。
  }
  return sameBoxFile(a, b);
}

function readText(file: string): { text?: string; missing?: boolean; error?: boolean } {
  try {
    if (!fs.existsSync(file)) return { missing: true };
  } catch {
    return { error: true };
  }
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch {
    return { error: true };
  }
}

/**
 * 与模板 COCO 的 `TemplateAssetData.save()` 同一条写盘线：
 * 同目录临时文件 + 原子替换 + Windows 瞬时锁重试 + 失败清理。
 */
function writeText(file: string, text: string): boolean {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, text, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) return false;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } catch {
    return false;
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* 保留写盘错误 */ }
  }
}

/** 图片文件头读尺寸。读不出返回 undefined。 */
function imageHeaderSize(file: string): { width: number; height: number } | undefined {
  try {
    return readImageSize(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** 读标注资源。version 1（旧 normalized）不受支持：解析直接报 `version` 错误，不做迁移。 */
function readAuthoringResult(rootDir: string, templatesDirectory: string): { file: AuthoringFile; errors: string[] } {
  const file = authoringFile(rootDir, templatesDirectory);
  const read = readText(file);
  if (read.missing) return { file: emptyAuthoringFile(), errors: [] };
  if (read.error || read.text === undefined) return { file: emptyAuthoringFile(), errors: ['read'] };
  return parseAuthoring(read.text);
}

export function readAuthoringFile(rootDir: string, templatesDirectory: string): AuthoringFile {
  return readAuthoringResult(rootDir, templatesDirectory).file;
}

/** 缺文件不是错误。读失败 / 解析失败时返回错误码，调用方不能把结果当成空目录。 */
export function authoringReadErrors(rootDir: string, templatesDirectory: string): string[] {
  return readAuthoringResult(rootDir, templatesDirectory).errors;
}

/**
 * 图片尺寸查询：authoring 里登记的**有效**条目优先，缺失或 0 尺寸占位（`parseAuthoring`
 * 对"引用了未登记图片"的占位）时回退到图片头 —— 与 `swapImageBoxes` 的补登记同一条规则。
 *
 * 交换前的 UI 预检查走这里。只在 `swapImageBoxes` 里补登记的话，从未标过框的新截图
 * 仍然会在弹确认框之前就被 "Cannot read image size" 拦下。
 */
export function authoringImageSize(
  rootDir: string,
  templatesDirectory: string,
  fileName: string,
): { width: number; height: number } | undefined {
  const name = imageFileName(fileName);
  if (!name) return undefined;
  const entry = readAuthoringFile(rootDir, templatesDirectory).images.find((item) => sameImage(item.file, name));
  if (entry && entry.width > 0 && entry.height > 0) return { width: entry.width, height: entry.height };
  return imageHeaderSize(path.join(rootDir, templatesDirectory, name));
}

export function runtimeReadErrors(rootDir: string, declared?: string, fromConfigPy?: string): string[] {
  return readRuntimeResult(rootDir, declared, fromConfigPy).errors;
}

export function readRuntimeFile(rootDir: string, declared?: string, fromConfigPy?: string): RuntimeFile {
  return readRuntimeResult(rootDir, declared, fromConfigPy).file;
}

function readRuntimeResult(rootDir: string, declared?: string, fromConfigPy?: string): { file: RuntimeFile; errors: string[] } {
  const plan = resolveBoxRuntimePlan(rootDir, declared, fromConfigPy);
  const file = effectiveBoxRuntimeFile(plan, (candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  if (!file) return { file: emptyRuntimeFile(), errors: [] };
  const read = readText(file);
  if (read.missing) return { file: emptyRuntimeFile(), errors: [] };
  if (read.error || read.text === undefined) return { file: emptyRuntimeFile(), errors: ['read'] };
  return parseRuntime(read.text);
}

export function boxesForImage(file: AuthoringFile, fileName: string): AuthoringBox[] {
  return boxesForImageFile(file, fileName);
}

/** 删图前记下 boxes.json。缺文件是空快照；读失败返回 null，调用方应停止删除。 */
export function captureAuthoring(rootDir: string, templatesDirectory: string): { text: string | null } | null {
  const read = readText(authoringFile(rootDir, templatesDirectory));
  if (read.error) return null;
  if (read.missing) return { text: null };
  return { text: read.text ?? '' };
}

/** 图片文件还在时，把删图前的 boxes.json 写回去。快照为空就删掉这次多出来的文件。 */
export function restoreAuthoring(rootDir: string, templatesDirectory: string, snapshot: { text: string | null }): boolean {
  const target = authoringFile(rootDir, templatesDirectory);
  if (snapshot.text === null) {
    if (!fs.existsSync(target)) return true;
    try {
      fs.unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }
  return writeText(target, snapshot.text);
}

/** 删图时去掉它的框和尺寸登记。文件还不存在就什么都不写。 */
export function removeImageBoxes(rootDir: string, templatesDirectory: string, fileName: string): boolean {
  const target = authoringFile(rootDir, templatesDirectory);
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return false;
  if (!fs.existsSync(target)) return true;
  const nextBoxes = parsed.file.boxes.filter((box) => !sameImage(box.image, fileName));
  const nextImages = parsed.file.images.filter((entry) => !sameImage(entry.file, fileName));
  if (nextBoxes.length === parsed.file.boxes.length && nextImages.length === parsed.file.images.length) return true;
  return writeText(target, serializeAuthoring({
    version: parsed.file.version,
    images: nextImages,
    boxes: nextBoxes,
  }));
}

/**
 * 新增一个框：直接接收 / 保存 Pixel bbox。
 *
 * 复用模板标注的登记模式（对标 `TemplateAssetData.ensureSwapImage`）：
 * 图片头读尺寸 → 登记进 authoring 的 `images` → 校验 bbox 落在图内 → 全局查重 → 追加。
 * 文件不存在时，这次合法保存就是它的创建时刻。
 */
export function addBox(rootDir: string, templatesDirectory: string, boxPath: string, image: string, box: PixelBox): string | undefined {
  const boxPathTrimmed = boxPath.trim();
  const pathError = boxPathError(boxPathTrimmed);
  if (pathError) return pathError;
  const fileName = imageFileName(image);
  if (!fileName) return 'image';
  const header = imageHeaderSize(path.join(rootDir, templatesDirectory, fileName));
  if (!header) return 'image';
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return 'parse';
  const current = boxesForImageFile(parsed.file, fileName)
    .map((item) => ({ path: item.path, x: item.bbox[0], y: item.bbox[1], w: item.bbox[2], h: item.bbox[3] }));
  if (current.some((item) => item.path === boxPathTrimmed)) return 'duplicate';
  const merged = replaceAuthoringImages(parsed.file, [{
    fileName,
    width: header.width,
    height: header.height,
    boxes: [...current, { path: boxPathTrimmed, x: box.x, y: box.y, w: box.w, h: box.h }],
  }]);
  if (merged.error) return merged.error;
  return writeText(authoringFile(rootDir, templatesDirectory), serializeAuthoring(merged.file)) ? undefined : 'write';
}

/** 用这张图上的像素框替换标注资源里引用它的条目。成功返回 null。 */
export function replaceImageBoxes(
  rootDir: string,
  templatesDirectory: string,
  fileName: string,
  width: number,
  height: number,
  boxes: EditedBox[],
): string | undefined {
  const image = imageFileName(fileName);
  if (!image || !(width > 0) || !(height > 0)) return 'image';
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return 'parse';
  const merged = replaceAuthoringImages(parsed.file, [{
    fileName: image,
    width,
    height,
    boxes: boxes.map((box) => ({ path: box.path, x: box.x, y: box.y, w: box.w, h: box.h })),
  }]);
  if (merged.error) return merged.error;
  return writeText(authoringFile(rootDir, templatesDirectory), serializeAuthoring(merged.file)) ? undefined : 'write';
}

/**
 * 两张图的框整套对调。Pixel authoring 下坐标语义依赖图片尺寸：
 * 同尺寸直接换 `image`；不同尺寸按比例映射（复用模板交换的 `scaleBox`），
 * 映射与钳制在纯层完成。缺文件或两边都没有框时不创建文件。
 *
 * 目标图片没有尺寸登记时（常见：把框换到一张从未标过框的新截图上），
 * 先从图片头补登记再交换 —— 补不出来才拒绝。
 */
export function swapImageBoxes(rootDir: string, templatesDirectory: string, fileA: string, fileB: string): boolean {
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return false;
  if (parsed.file.boxes.length === 0) return true;
  let images = parsed.file.images;
  const ensureEntry = (fileName: string): boolean => {
    const name = imageFileName(fileName);
    const existing = images.find((entry) => sameImage(entry.file, name));
    // 已登记且尺寸有效才放行；缺失或 0 尺寸占位的条目从图片头补齐/覆盖
    if (existing && existing.width > 0 && existing.height > 0) return true;
    const header = imageHeaderSize(path.join(rootDir, templatesDirectory, name));
    if (!header) return false;
    const fresh: AuthoringFile["images"][number] = { file: name, width: header.width, height: header.height };
    images = existing
      ? images.map((entry) => (sameImage(entry.file, name) ? fresh : entry))
      : [...images, fresh];
    return true;
  };
  if (!ensureEntry(fileA) || !ensureEntry(fileB)) return false;
  const prepared: AuthoringFile = { version: parsed.file.version, images, boxes: parsed.file.boxes };
  const swapped = swapImageBoxesPure(prepared, fileA, fileB);
  if (swapped.error) return false;
  if (serializeAuthoring(swapped.file) === serializeAuthoring(prepared)) return true;
  return writeText(authoringFile(rootDir, templatesDirectory), serializeAuthoring(swapped.file));
}

/**
 * 发布。Pixel → normalized 的转换在纯层 `publishBoxes`；
 * 返回具体错误（`size:<path>` / `parse` / `runtimeRead` / `same` / `write`）供界面报告，
 * 不再让所有失败共用一个说不清的布尔值。
 */
export function publishRuntime(
  rootDir: string,
  templatesDirectory: string,
  declared?: string,
  fromConfigPy?: string,
): { ok: boolean; errors: string[] } {
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return { ok: false, errors: ['parse'] };
  const runtime = readRuntimeResult(rootDir, declared, fromConfigPy);
  if (runtime.errors.length) return { ok: false, errors: ['runtimeRead'] };
  const authoringPath = authoringFile(rootDir, templatesDirectory);
  const target = runtimeWriteTarget(resolveBoxRuntimePlan(rootDir, declared, fromConfigPy));
  if (sameStoredFile(authoringPath, target)) return { ok: false, errors: ['same'] };
  const published = publishBoxes(parsed.file);
  if (published.errors.length) return { ok: false, errors: published.errors };
  return writeText(target, serializeRuntime(published.file))
    ? { ok: true, errors: [] }
    : { ok: false, errors: ['write'] };
}

/** 运行时里存在、标注里已经没有的 path（发布前要确认会删掉它们）。 */
export function runtimeOnlyPaths(authoring: AuthoringFile, runtime: RuntimeFile): string[] {
  const live = new Set(authoring.boxes.map((box) => box.path));
  return runtime.boxes.map((box) => box.path).filter((boxPath) => !live.has(boxPath));
}

/** 从选中的像素标注生成一个框：直接 Pixel union，不做任何归一化。 */
export function pixelUnionFromAnnotations(boxes: readonly PixelBox[]): PixelBox | undefined {
  return unionPixelBoxes(boxes);
}

export { publishStatus, roundPixelBbox, pixelBboxError };
