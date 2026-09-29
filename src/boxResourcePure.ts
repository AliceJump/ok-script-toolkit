/**
 * 框资源的纯数据契约。与 JetBrains 侧 `core/BoxResource.kt`、`core/BoxRuntimePath.kt` 一一对应。
 *
 * 两份文件，关系对标模板的两份 COCO：
 *
 * | 文件 | 是什么 | 坐标 |
 * |---|---|---|
 * | `<模板目录>/boxes.json`（version 2） | 框标注资源（带原图与尺寸） | **Pixel bbox `[x, y, w, h]`** |
 * | `src/scene/boxes.json`（或约定 / config.py 指定的别处） | 运行时位置表 | normalized `[left, top, right, bottom]` |
 *
 * Authoring 与模板标注共用同一套 Pixel 模型（图片 width/height + 像素 bbox，见
 * `templateAssetData.ts` 的 `CocoImage`）；归一化只发生在 Publish（`publishBoxes`）。
 * 旧 version 1（normalized rect）不受支持：解析直接报 `version` 错误，不做迁移。
 *
 * 设计见 `docs/box-resources.md`。本模块不读盘、不 import `vscode`。
 */
import * as path from 'path';
import { clampBoxToSize, isSameSize, scaleBox, type ImageSize, type SwapBox } from './annotationSwapPure';

export const AUTHORING_VERSION = 2;
export const RUNTIME_VERSION = 1;
export const AUTHORING_FILE_NAME = 'boxes.json';

/** 运行时文件的探测位置（相对项目根）。ok-nte 的位置表就在这里。 */
export const PROBE_BOX_CANDIDATES = ['src/scene/boxes.json'];

/** 留给现有点击点，框路径不能占用这个根。 */
export const RESERVED_BOX_ROOTS = ['panels'];

/** Runtime（发布产物）专用的 normalized 矩形。 */
export type NormalizedRect = [number, number, number, number];
/** Authoring 专用的像素 bbox，与模板 COCO 的 `bbox` 同形。 */
export type PixelBbox = [number, number, number, number];

export interface AuthoringImage {
  file: string;
  width: number;
  height: number;
}

export interface AuthoringBox {
  path: string;
  image: string;
  bbox: PixelBbox;
}

export interface AuthoringFile {
  version: number;
  images: AuthoringImage[];
  boxes: AuthoringBox[];
}

export interface RuntimeBox {
  path: string;
  rect: NormalizedRect;
}

export interface RuntimeFile {
  version: number;
  boxes: RuntimeBox[];
}

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxParseResult<T> {
  file: T;
  errors: string[];
}

export type BoxRuntimeLayer = 'convention' | 'configPy' | 'probe';

export interface BoxRuntimePlan {
  preferred?: string;
  probeCandidates: string[];
  layer: BoxRuntimeLayer;
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 段规则的**唯一来源**，随 webview 的 `config` 消息下发。
 *
 * webview 是浏览器脚本、`require` 不了这里，所以宿主把字面量随 config 消息下发；
 * 谁要是把它复制进 media/，两边迟早漂移（`scripts/test_box_resource.js` 守着这一点）。
 */
export const BOX_PATH_SEGMENT_SOURCE = SEGMENT.source;

export function emptyAuthoringFile(): AuthoringFile {
  return { version: AUTHORING_VERSION, images: [], boxes: [] };
}

export function emptyRuntimeFile(): RuntimeFile {
  return { version: RUNTIME_VERSION, boxes: [] };
}

/** 标注资源路径。跟随模板目录，与 `<模板目录>/coco_annotations.json` 同一规则。 */
export function authoringFile(rootDir: string, templatesDirectory: string): string {
  return path.join(rootDir, templatesDirectory, AUTHORING_FILE_NAME);
}

function toAbsolute(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 运行时框文件的取值链，对标 `resolveCocoFeaturePlan`：
 * 项目约定 `boxes.runtime` > `config.py` 的 `boxes_json` > `src/scene/boxes.json`。
 */
export function resolveBoxRuntimePlan(
  rootDir: string,
  declared?: string,
  fromConfigPy?: string,
): BoxRuntimePlan {
  const probeCandidates = PROBE_BOX_CANDIDATES.map((rel) => path.join(rootDir, rel));
  const declaredPath = nonEmpty(declared);
  if (declaredPath) {
    return { preferred: toAbsolute(rootDir, declaredPath), probeCandidates, layer: 'convention' };
  }
  const fromPy = nonEmpty(fromConfigPy);
  if (fromPy) {
    return { preferred: toAbsolute(rootDir, fromPy), probeCandidates, layer: 'configPy' };
  }
  return { probeCandidates, layer: 'probe' };
}

/** 首选存在时只用首选。都不存在时返回空，调用方改用 [runtimeWriteTarget] 创建。 */
export function effectiveBoxRuntimeFile(plan: BoxRuntimePlan, exists: (file: string) => boolean): string | undefined {
  if (plan.preferred && exists(plan.preferred)) return plan.preferred;
  return plan.probeCandidates.find(exists);
}

/** 发布时要写入的那个文件：已声明的首选，否则探测位置。文件可以尚不存在。 */
export function runtimeWriteTarget(plan: BoxRuntimePlan): string {
  return plan.preferred ?? plan.probeCandidates[0];
}

/** 规范化后是否指向同一路径。Windows 上大小写不计。符号链接由读盘侧再比一次真实路径。 */
export function sameBoxFile(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function boxRuntimeRelPaths(plan: BoxRuntimePlan, rootDir: string): string[] {
  const all = plan.preferred ? [plan.preferred, ...plan.probeCandidates] : plan.probeCandidates;
  return [...new Set(all)]
    .map((abs) => path.relative(rootDir, abs).replace(/\\/g, '/'))
    .filter((rel) => rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 合法返回 `undefined`。否则返回稳定错误码，供界面翻译。 */
export function boxPathError(value: string): 'empty' | 'segment' | 'shallow' | 'reserved' | undefined {
  const pathValue = value.trim();
  if (!pathValue) return 'empty';
  const segments = pathValue.split('.');
  if (segments.length < 2) return 'shallow';
  if (segments.some((segment) => !SEGMENT.test(segment))) return 'segment';
  if (RESERVED_BOX_ROOTS.includes(segments[0])) return 'reserved';
  return undefined;
}

export function imageFileName(value: string): string {
  const normalized = value.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  return normalized;
}

function sameImage(a: string, b: string): boolean {
  return imageFileName(a).toLowerCase() === imageFileName(b).toLowerCase();
}

export function boxesForImageFile(file: AuthoringFile, fileName: string): AuthoringBox[] {
  return file.boxes.filter((box) => sameImage(box.image, fileName));
}

/* ────────────────────────────────────────────────────────────────
 * Pixel bbox（Authoring）与模板标注同一条校验线：
 * 整数、正的宽高、落在原图 width × height 之内。
 * ──────────────────────────────────────────────────────────────── */

/** 非整数输入按四舍五入收进像素格（编辑器画布本来就只产生整数）。 */
export function roundPixelBbox(bbox: readonly number[]): PixelBbox {
  return [Math.round(bbox[0]), Math.round(bbox[1]), Math.round(bbox[2]), Math.round(bbox[3])];
}

/**
 * Authoring 的 bbox 校验。`size` 缺失时退回"只查正性"（图片尺寸未知不能造出假边界），
 * 尺寸可用时必须完整落在 `0,0,width,height` 之内。返回 `undefined` 表示合法。
 */
export function pixelBboxError(
  bbox: readonly number[],
  size?: { width: number; height: number },
): 'rect' | undefined {
  if (bbox.length !== 4 || !bbox.every((item) => Number.isFinite(item))) return 'rect';
  const [x, y, w, h] = roundPixelBbox(bbox);
  if (x < 0 || y < 0 || w < 1 || h < 1) return 'rect';
  if (size && size.width > 0 && size.height > 0) {
    if (x + w > size.width || y + h > size.height) return 'rect';
  }
  return undefined;
}

function clampPixelBbox(bbox: PixelBbox, size: { width: number; height: number }): PixelBbox {
  if (!(size.width > 0 && size.height > 0)) return bbox;
  const w = Math.min(Math.max(1, bbox[2]), size.width);
  const h = Math.min(Math.max(1, bbox[3]), size.height);
  return [
    Math.min(Math.max(0, bbox[0]), size.width - w),
    Math.min(Math.max(0, bbox[1]), size.height - h),
    w,
    h,
  ];
}

/** 同一张原图上的像素框取最小包围矩形。空列表返回 `undefined`。不做任何归一化。 */
export function unionPixelBoxes(boxes: readonly PixelBox[]): PixelBox | undefined {
  if (boxes.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/* ────────────────────────────────────────────────────────────────
 * Runtime 转换层：normalized ↔ Pixel。
 *
 * 只允许 Publish（`publishBoxes`）、Runtime Preview（`previewRectForPath`）
 * 和旧格式迁移调用；Authoring 的编辑 / 保存主流程不得使用。
 * ──────────────────────────────────────────────────────────────── */

/** normalized rect → Pixel bbox（Runtime Preview 用）。 */
export function rectToPixel(rect: NormalizedRect, width: number, height: number): PixelBox | undefined {
  if (width <= 0 || height <= 0) return undefined;
  const [left, top, right, bottom] = rect;
  const x = Math.round(left * width);
  const y = Math.round(top * height);
  const w = Math.round((right - left) * width);
  const h = Math.round((bottom - top) * height);
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

/** Pixel bbox → normalized rect（Publish 用）。 */
export function pixelToRect(box: PixelBox, width: number, height: number): NormalizedRect | undefined {
  if (width <= 0 || height <= 0 || box.w <= 0 || box.h <= 0) return undefined;
  return [box.x / width, box.y / height, (box.x + box.w) / width, (box.y + box.h) / height];
}

/** Runtime 序列化约束：0–1、left<right、top<bottom。Authoring 不得使用。 */
export function isStorableRuntimeRect(rect: readonly number[]): boolean {
  if (rect.length !== 4 || !rect.every((item) => Number.isFinite(item))) return false;
  const [left, top, right, bottom] = rect;
  return left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && left < right && top < bottom;
}

/* ────────────────────────────────────────────────────────────────
 * Authoring 的内存编辑。全程 Pixel，不出现 normalized。
 * ──────────────────────────────────────────────────────────────── */

export interface AuthoringEditBox {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AuthoringImageEdit {
  fileName: string;
  width: number;
  height: number;
  boxes: readonly AuthoringEditBox[];
}

/**
 * 在内存里依次替换多张图的框，并登记 / 刷新它们的图片尺寸。任一图不合法就整批失败，
 * 调用方此时还不能写盘 —— 一次确认里的多张图要么一起留下，要么保持原文件。
 *
 * 尺寸来源是**本次编辑拿到的真实值**（调用方读的图片头），已有的 images 条目被直接
 * 刷新成这个值：authoring 自己就是尺寸的事实来源，不需要拿旧记录顶。
 */
export function replaceAuthoringImages(
  existing: AuthoringFile,
  edits: readonly AuthoringImageEdit[],
): { file: AuthoringFile; error?: string } {
  let current: AuthoringFile = {
    version: AUTHORING_VERSION,
    images: existing.images.slice(),
    boxes: existing.boxes.slice(),
  };
  for (const edit of edits) {
    const image = imageFileName(edit.fileName);
    if (!image || !(edit.width > 0) || !(edit.height > 0)) return { file: existing, error: 'image' };
    const kept = current.boxes.filter((box) => !sameImage(box.image, image));
    const taken = new Set(kept.map((box) => box.path));
    const next: AuthoringBox[] = [];
    for (const box of edit.boxes) {
      const pathError = boxPathError(box.path);
      if (pathError) return { file: existing, error: pathError };
      if (taken.has(box.path)) return { file: existing, error: 'duplicate' };
      taken.add(box.path);
      const bbox = roundPixelBbox([box.x, box.y, box.w, box.h]);
      if (pixelBboxError(bbox, { width: edit.width, height: edit.height })) {
        return { file: existing, error: 'rect' };
      }
      next.push({ path: box.path, image, bbox });
    }
    const entryIndex = current.images.findIndex((item) => sameImage(item.file, image));
    const entry: AuthoringImage = { file: image, width: edit.width, height: edit.height };
    if (entryIndex >= 0) current.images[entryIndex] = entry;
    else current.images.push(entry);
    current = { version: AUTHORING_VERSION, images: current.images, boxes: [...kept, ...next] };
  }
  return { file: current };
}

/* ────────────────────────────────────────────────────────────────
 * Publish：Pixel → normalized 的唯一入口。
 * ──────────────────────────────────────────────────────────────── */

/** 单条框的发布投影。图片条目缺失或尺寸非法时返回 `undefined`，调用方必须报告而不是静默跳过。 */
export function publishedRect(
  box: AuthoringBox,
  images: readonly AuthoringImage[],
): NormalizedRect | undefined {
  const entry = images.find((item) => sameImage(item.file, box.image));
  if (!entry || !(entry.width > 0) || !(entry.height > 0)) return undefined;
  return pixelToRect({ x: box.bbox[0], y: box.bbox[1], w: box.bbox[2], h: box.bbox[3] }, entry.width, entry.height);
}

/** Publish：把 Pixel authoring 投影成 normalized runtime。丢 image，留几何。 */
export function publishBoxes(file: AuthoringFile): { file: RuntimeFile; errors: string[] } {
  const boxes: RuntimeBox[] = [];
  const errors: string[] = [];
  for (const box of file.boxes) {
    const rect = publishedRect(box, file.images);
    if (!rect) {
      errors.push(`size:${box.path}`);
      continue;
    }
    boxes.push({ path: box.path, rect });
  }
  return { file: { version: RUNTIME_VERSION, boxes }, errors };
}

export type PublishStatus = 'same' | 'unpublished' | 'runtimeOnly';

export function publishStatus(authoring: AuthoringFile, runtime: RuntimeFile): Array<{ path: string; status: PublishStatus }> {
  const runtimeByPath = new Map(runtime.boxes.map((box) => [box.path, box]));
  const seen = new Set<string>();
  const result: Array<{ path: string; status: PublishStatus }> = [];
  for (const box of authoring.boxes) {
    seen.add(box.path);
    const published = runtimeByPath.get(box.path);
    const target = publishedRect(box, authoring.images);
    const same = published !== undefined && target !== undefined && sameRect(published.rect, target);
    result.push({ path: box.path, status: same ? 'same' : 'unpublished' });
  }
  for (const box of runtime.boxes) {
    if (!seen.has(box.path)) result.push({ path: box.path, status: 'runtimeOnly' });
  }
  return result;
}

function sameRect(a: NormalizedRect, b: NormalizedRect): boolean {
  return a.length === b.length && a.every((value, index) => formatRectNumber(value) === formatRectNumber(b[index]));
}

/* ────────────────────────────────────────────────────────────────
 * 图片交换：Pixel authoring 不能再"只换 image 名"——
 * 尺寸不同时坐标语义会变，必须按比例映射。映射与钳制直接复用模板
 * 标注交换的纯逻辑（`annotationSwapPure.scaleBox`：x' = x * W2 / W1，
 * 再钳制进目标边界，宽高至少 1px）。
 * ──────────────────────────────────────────────────────────────── */

export function swapImageBoxes(file: AuthoringFile, fileA: string, fileB: string): { file: AuthoringFile; error?: 'size' } {
  const nameA = imageFileName(fileA);
  const nameB = imageFileName(fileB);
  const entryA = file.images.find((item) => sameImage(item.file, nameA));
  const entryB = file.images.find((item) => sameImage(item.file, nameB));
  const sizeA: ImageSize | undefined = entryA && entryA.width > 0 && entryA.height > 0 ? entryA : undefined;
  const sizeB: ImageSize | undefined = entryB && entryB.width > 0 && entryB.height > 0 ? entryB : undefined;
  if (!sizeA || !sizeB) return { file, error: 'size' };

  const remap = (box: AuthoringBox, target: string, from: ImageSize, to: ImageSize): AuthoringBox => {
    if (isSameSize(from, to)) return { ...box, image: target };
    const scaled: SwapBox = scaleBox(
      { category: box.path, x: box.bbox[0], y: box.bbox[1], w: box.bbox[2], h: box.bbox[3] },
      from,
      to,
    );
    return { path: box.path, image: target, bbox: [scaled.x, scaled.y, scaled.w, scaled.h] };
  };

  const next = file.boxes.map((box) => {
    if (sameImage(box.image, nameA)) return remap(box, nameB, sizeA, sizeB);
    if (sameImage(box.image, nameB)) return remap(box, nameA, sizeB, sizeA);
    return box;
  });
  return { file: { version: AUTHORING_VERSION, images: file.images.slice(), boxes: next } };
}

/* ────────────────────────────────────────────────────────────────
 * 解析 / 序列化。Authoring 不再与 Runtime 共用 normalized 规则。
 * ──────────────────────────────────────────────────────────────── */

export function parseAuthoring(text: string): BoxParseResult<AuthoringFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { file: emptyAuthoringFile(), errors: ['json'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { file: emptyAuthoringFile(), errors: ['root'] };
  }
  const record = raw as { version?: unknown };
  // version 1（旧 normalized rect）不支持，也不迁移：authoring 只有 Pixel 一种模型。
  if (record.version !== AUTHORING_VERSION) {
    return { file: emptyAuthoringFile(), errors: ['version'] };
  }
  const errors: string[] = [];
  const imagesRecord = (raw as { images?: unknown }).images;
  if (!Array.isArray(imagesRecord)) {
    return { file: emptyAuthoringFile(), errors: ['images'] };
  }
  const images: AuthoringImage[] = [];
  const byFile = new Map<string, AuthoringImage>();
  imagesRecord.forEach((entry, index) => {
    const item = entry as { file?: unknown; width?: unknown; height?: unknown };
    const file = typeof item?.file === 'string' ? imageFileName(item.file) : '';
    const width = typeof item?.width === 'number' && Number.isFinite(item.width) ? Math.round(item.width) : 0;
    const height = typeof item?.height === 'number' && Number.isFinite(item.height) ? Math.round(item.height) : 0;
    if (!file || width <= 0 || height <= 0) {
      errors.push(`images:${index}`);
      return;
    }
    if (byFile.has(file.toLowerCase())) {
      errors.push(`images:${index}:duplicate`);
      return;
    }
    const parsed: AuthoringImage = { file, width, height };
    byFile.set(file.toLowerCase(), parsed);
    images.push(parsed);
  });

  const boxesRecord = (raw as { boxes?: unknown }).boxes;
  if (!Array.isArray(boxesRecord)) {
    return { file: { version: AUTHORING_VERSION, images, boxes: [] }, errors: [...errors, 'boxes'] };
  }
  const boxes: AuthoringBox[] = [];
  const seen = new Set<string>();
  boxesRecord.forEach((entry, index) => {
    const item = entry as { path?: unknown; image?: unknown; bbox?: unknown };
    if (typeof item?.path !== 'string' || boxPathError(item.path)) {
      errors.push(`${index}:path`);
      return;
    }
    const image = typeof item?.image === 'string' ? imageFileName(item.image) : '';
    const imageEntry = image ? byFile.get(image.toLowerCase()) : undefined;
    if (!imageEntry) {
      errors.push(`${index}:image`);
      return;
    }
    if (!Array.isArray(item.bbox)) {
      errors.push(`${index}:rect`);
      return;
    }
    const bbox = roundPixelBbox(item.bbox as number[]);
    if (pixelBboxError(bbox, imageEntry)) {
      errors.push(`${index}:rect`);
      return;
    }
    if (seen.has(item.path)) {
      errors.push(`${index}:duplicate`);
      return;
    }
    seen.add(item.path);
    boxes.push({ path: item.path, image: imageEntry.file, bbox });
  });
  boxes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  images.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { file: { version: AUTHORING_VERSION, images, boxes }, errors };
}

export function serializeAuthoring(file: AuthoringFile): string {
  const images = [...file.images].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const boxes = uniqueAuthoring(file.boxes);
  const imageBody = images.map((image) =>
    `    { "file": ${JSON.stringify(image.file)}, "width": ${Math.round(image.width)}, "height": ${Math.round(image.height)} }`,
  ).join(',\n');
  const boxBody = boxes.map((box) =>
    [
      '    {',
      `      "path": ${JSON.stringify(box.path)},`,
      `      "image": ${JSON.stringify(box.image)},`,
      `      "bbox": [${box.bbox.map((value) => Math.round(value)).join(', ')}]`,
      '    }',
    ].join('\n'),
  ).join(',\n');
  return [
    '{',
    `  "version": ${AUTHORING_VERSION},`,
    '  "images": [' + (imageBody ? `\n${imageBody}\n  ` : '') + '],',
    '  "boxes": [' + (boxBody ? `\n${boxBody}\n  ` : '') + ']',
    '}',
    '',
  ].join('\n');
}

function uniqueAuthoring(boxes: readonly AuthoringBox[]): AuthoringBox[] {
  const seen = new Set<string>();
  return [...boxes]
    .filter((box) => {
      if (seen.has(box.path)) return false;
      seen.add(box.path);
      return true;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* ────────────────────────────────────────────────────────────────
 * Runtime 解析 / 序列化（normalized，6 位小数）。
 * `quantizeRect` / `BOX_RECT_DECIMALS` / `formatRectNumber` 是 Runtime 的
 * 输出稳定性契约，Authoring 已不再使用，但不能删。
 * ──────────────────────────────────────────────────────────────── */

const BOX_RECT_DECIMALS = 6;

export function parseRuntime(text: string): BoxParseResult<RuntimeFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { file: emptyRuntimeFile(), errors: ['json'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { file: emptyRuntimeFile(), errors: ['root'] };
  }
  const record = raw as { version?: unknown; boxes?: unknown };
  const errors: string[] = [];
  if (record.version !== RUNTIME_VERSION) errors.push('version');
  if (!Array.isArray(record.boxes)) {
    errors.push('boxes');
    return { file: emptyRuntimeFile(), errors };
  }
  const boxes: RuntimeBox[] = [];
  const seen = new Set<string>();
  record.boxes.forEach((entry, index) => {
    const parsed = parseRuntimeEntry(entry);
    if (!parsed.box) {
      errors.push(`${index}:${parsed.error}`);
      return;
    }
    if (seen.has(parsed.box.path)) {
      errors.push(`${index}:duplicate`);
      return;
    }
    seen.add(parsed.box.path);
    boxes.push(parsed.box);
  });
  boxes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { file: { version: RUNTIME_VERSION, boxes }, errors };
}

function parseRuntimeEntry(entry: unknown): { box?: RuntimeBox; error?: string } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'entry' };
  const record = entry as { path?: unknown; rect?: unknown };
  if (typeof record.path !== 'string' || boxPathError(record.path)) return { error: 'path' };
  const rect = Array.isArray(record.rect) && record.rect.length === 4
    && record.rect.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? (record.rect as unknown as NormalizedRect)
    : undefined;
  if (!rect || !isStorableRuntimeRect(rect)) return { error: 'rect' };
  return { box: { path: record.path.trim(), rect } };
}

export function serializeRuntime(file: RuntimeFile): string {
  const boxes = uniqueRuntime(file.boxes);
  const body = boxes.map((box) =>
    [
      '    {',
      `      "path": ${JSON.stringify(box.path)},`,
      `      "rect": [${quantizeRect(box.rect).map(formatRectNumber).join(', ')}]`,
      '    }',
    ].join('\n'),
  ).join(',\n');
  return [
    '{',
    `  "version": ${RUNTIME_VERSION},`,
    '  "boxes": [' + (body ? `\n${body}\n  ` : '') + ']',
    '}',
    '',
  ].join('\n');
}

function uniqueRuntime(boxes: readonly RuntimeBox[]): RuntimeBox[] {
  const seen = new Set<string>();
  return [...boxes]
    .filter((box) => {
      if (seen.has(box.path)) return false;
      seen.add(box.path);
      return true;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function quantizeRect(rect: NormalizedRect): NormalizedRect {
  let left = Number(formatRectNumber(rect[0]));
  let top = Number(formatRectNumber(rect[1]));
  let right = Number(formatRectNumber(rect[2]));
  let bottom = Number(formatRectNumber(rect[3]));
  if (left >= right) {
    if (right < 1) right = Math.min(1, left + 0.000001);
    if (left >= right) left = Math.max(0, right - 0.000001);
  }
  if (top >= bottom) {
    if (bottom < 1) bottom = Math.min(1, top + 0.000001);
    if (top >= bottom) top = Math.max(0, bottom - 0.000001);
  }
  return [left, top, right, bottom];
}

function formatRectNumber(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return normalized.toFixed(BOX_RECT_DECIMALS);
}

/* ────────────────────────────────────────────────────────────────
 * 显隐（编辑器会话状态，不进任何文件）。
 * ──────────────────────────────────────────────────────────────── */

export function applyVisibility(
  ids: readonly string[],
  hidden: ReadonlySet<string>,
  action: 'showAll' | 'hideAll' | 'only' | 'toggle',
  target?: string,
): Set<string> {
  if (action === 'showAll') return new Set();
  if (action === 'hideAll') return new Set(ids);
  if (action === 'only') {
    const next = new Set(ids);
    if (target !== undefined) next.delete(target);
    return next;
  }
  const live = new Set(ids);
  const next = new Set([...hidden].filter((id) => live.has(id)));
  if (target === undefined || !live.has(target)) return next;
  if (next.has(target)) next.delete(target);
  else next.add(target);
  return next;
}

export function isAnnotationVisible(id: string, hidden: ReadonlySet<string>): boolean {
  return !hidden.has(id);
}
