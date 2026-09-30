/** Box name rules, COCO export projection, and runtime geometry. */
import * as path from 'path';
import { CocoData, emptyCocoData, parseCocoData } from './cocoAnnotationData';
import { pixelBboxError, roundPixelBbox } from './annotationGeometry';
export { pixelBboxError, roundPixelBbox } from './annotationGeometry';

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
  return { images: [], boxes: [] };
}

export function emptyRuntimeFile(): RuntimeFile {
  return { version: RUNTIME_VERSION, boxes: [] };
}

/** 标注资源路径。跟随模板目录，与 `<模板目录>/coco_annotations.json` 同一规则。 */
export function authoringFile(rootDir: string, templatesDirectory: string): string {
  return path.resolve(rootDir, templatesDirectory, AUTHORING_FILE_NAME);
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
 * 只允许 Publish（`publishBoxes`）调用；Authoring 的编辑 / 保存主流程不得使用。
 * rectToPixel 仅用于导入旧 normalized 源文件，日常编辑直接使用 COCO bbox。
 * ──────────────────────────────────────────────────────────────── */

/** normalized rect → Pixel bbox（旧源文件兼容导入）。 */
export function rectToPixel(rect: NormalizedRect, width: number, height: number): PixelBox | undefined {
  if (width <= 0 || height <= 0) return undefined;
  const [left, top, right, bottom] = rect;
  const x = Math.round(left * width);
  const y = Math.round(top * height);
  const w = Math.round(right * width) - x;
  const h = Math.round(bottom * height) - y;
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
  const seen = new Set<string>();
  for (const box of file.boxes) {
    const nameError = boxPathError(box.path);
    if (nameError) { errors.push(nameError + ':' + box.path); continue; }
    if (seen.has(box.path)) { errors.push('duplicate:' + box.path); continue; }
    seen.add(box.path);
    const rect = publishedRect(box, file.images);
    if (!rect) {
      errors.push(`size:${box.path}`);
      continue;
    }
    if (!isStorableRuntimeRect(rect)) { errors.push('rect:' + box.path); continue; }
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

/** Only an export/preview view; the authoring file itself is ordinary COCO. */
export function authoringFromCoco(data: CocoData): AuthoringFile {
  const images = data.images.map(image => ({ file: image.file_name, width: image.width, height: image.height }));
  const imageById = new Map(data.images.map(image => [image.id, image]));
  const categoryById = new Map(data.categories.map(category => [category.id, category]));
  const boxes = data.annotations.map(annotation => ({
    path: categoryById.get(annotation.category_id)!.name.trim(),
    image: imageById.get(annotation.image_id)!.file_name,
    bbox: annotation.bbox,
  }));
  return { images, boxes };
}

function cocoFromAuthoring(file: AuthoringFile): CocoData {
  const data = emptyCocoData();
  const images = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const image of file.images) {
    const id = data.images.length + 1;
    images.set(image.file.toLowerCase(), id);
    data.images.push({ id, file_name: image.file, width: image.width, height: image.height });
  }
  for (const box of file.boxes) {
    let imageId = images.get(box.image.toLowerCase());
    if (imageId === undefined) {
      imageId = data.images.length + 1;
      data.images.push({ id: imageId, file_name: box.image, width: 0, height: 0 });
      images.set(box.image.toLowerCase(), imageId);
    }
    const name = box.path.trim();
    let categoryId = categories.get(name);
    if (categoryId === undefined) {
      categoryId = data.categories.length + 1;
      data.categories.push({ id: categoryId, name, supercategory: '' });
      categories.set(name, categoryId);
    }
    data.annotations.push({ id: data.annotations.length + 1, image_id: imageId, category_id: categoryId,
      bbox: box.bbox, area: box.bbox[2] * box.bbox[3], iscrowd: 0 });
  }
  return data;
}

/** Compatibility import only. All subsequent edits use the shared COCO store. */
export function parseBoxCoco(text: string, sizeOf?: (name: string) => { width: number; height: number } | undefined): { data: CocoData; errors: string[]; legacy?: boolean } {
  let raw;
  try { raw = JSON.parse(text); } catch { return { data: emptyCocoData(), errors: ['json'] }; }
  if (!raw || !Array.isArray(raw.boxes)) return parseCocoData(text);
  if (![1, 2].includes(raw.version)) return { data: emptyCocoData(), errors: ['version'] };
  const file = emptyAuthoringFile();
  const errors: string[] = [];
  for (const [index, box] of raw.boxes.entries()) {
    if (!box || typeof box.path !== 'string' || typeof box.image !== 'string' || !imageFileName(box.image)) {
      errors.push(index + ':entry'); continue;
    }
    const name = imageFileName(box.image);
    let image = file.images.find(item => sameImage(item.file, name));
    if (!image) {
      const old = Array.isArray(raw.images) ? raw.images.find((item: { file?: string }) => item?.file && sameImage(item.file, name)) : undefined;
      const size = old && old.width > 0 && old.height > 0 ? old : sizeOf?.(name);
      image = { file: name, width: size?.width ?? 0, height: size?.height ?? 0 };
      file.images.push(image);
    }
    let bbox: PixelBbox;
    if (raw.version === 1) {
      if (!Array.isArray(box.rect) || !isStorableRuntimeRect(box.rect) || !image.width || !image.height) {
        errors.push('size:' + box.path); continue;
      }
      const pixel = rectToPixel(box.rect as NormalizedRect, image.width, image.height);
      if (!pixel) { errors.push(index + ':rect'); continue; }
      bbox = [pixel.x, pixel.y, pixel.w, pixel.h];
    } else {
      if (!Array.isArray(box.bbox) || box.bbox.length !== 4) { errors.push(index + ':rect'); continue; }
      bbox = roundPixelBbox(box.bbox);
    }
    if (pixelBboxError(bbox, image)) { errors.push(index + ':rect'); continue; }
    file.boxes.push({ path: box.path.trim(), image: name, bbox });
  }
  if (errors.length) return { data: emptyCocoData(), errors };
  return { ...parseCocoData(JSON.stringify(cocoFromAuthoring(file))), legacy: true };
}

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
