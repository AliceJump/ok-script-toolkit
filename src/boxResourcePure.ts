/**
 * 框资源的纯数据契约。与 JetBrains 侧 `core/BoxResource.kt`、`core/BoxRuntimePath.kt` 一一对应。
 *
 * 两份文件，关系对标模板的两份 COCO：
 *
 * | 文件 | 是什么 | 谁读写 |
 * |---|---|---|
 * | `<模板目录>/boxes.json` | 框标注资源（带原图文件名） | 框资源管理 |
 * | `src/scene/boxes.json`（或约定 / config.py 指定的别处） | 运行时位置表 | 框管理、补全；业务项目 `ScreenPosition` 加载 |
 *
 * 设计见 `docs/box-resources.md`。本模块不读盘、不 import `vscode`。
 */
import * as path from 'path';

export const BOX_FILE_VERSION = 1;
export const BOX_RECT_DECIMALS = 6;
export const AUTHORING_FILE_NAME = 'boxes.json';

/** 运行时文件的探测位置（相对项目根）。ok-nte 的位置表就在这里。 */
export const PROBE_BOX_CANDIDATES = ['src/scene/boxes.json'];

/** 留给现有点击点，框路径不能占用这个根。 */
export const RESERVED_BOX_ROOTS = ['panels'];

export type BoxRect = [number, number, number, number];

export interface AuthoringBox {
  path: string;
  image: string;
  rect: BoxRect;
}

export interface RuntimeBox {
  path: string;
  rect: BoxRect;
}

export interface AuthoringFile {
  version: number;
  boxes: AuthoringBox[];
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

export function emptyAuthoringFile(): AuthoringFile {
  return { version: BOX_FILE_VERSION, boxes: [] };
}

export function emptyRuntimeFile(): RuntimeFile {
  return { version: BOX_FILE_VERSION, boxes: [] };
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

export function rectToPixel(rect: BoxRect, width: number, height: number): PixelBox | undefined {
  if (width <= 0 || height <= 0) return undefined;
  const [left, top, right, bottom] = rect;
  const x = Math.round(left * width);
  const y = Math.round(top * height);
  const w = Math.round((right - left) * width);
  const h = Math.round((bottom - top) * height);
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

export function pixelToRect(box: PixelBox, width: number, height: number): BoxRect | undefined {
  if (width <= 0 || height <= 0 || box.w <= 0 || box.h <= 0) return undefined;
  return [box.x / width, box.y / height, (box.x + box.w) / width, (box.y + box.h) / height];
}

export function samePixel(a: PixelBox, b: PixelBox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * 写回标注资源时用。像素框没变就保留原来的浮点，避免「打开后直接保存」把文件写脏。
 * 变过才从像素重新归一化。
 */
export function rectForSave(
  original: BoxRect | undefined,
  pixel: PixelBox,
  width: number,
  height: number,
): BoxRect | undefined {
  if (original) {
    const quantized = rectToPixel(original, width, height);
    if (quantized && samePixel(quantized, pixel)) return original;
  }
  return pixelToRect(pixel, width, height);
}

export interface AuthoringEditBox {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  original?: BoxRect;
  unchanged?: boolean;
}

export interface AuthoringImageEdit {
  fileName: string;
  width: number;
  height: number;
  boxes: readonly AuthoringEditBox[];
}

/**
 * 在内存里依次替换多张图的框。任一图不合法就整批失败，调用方此时还不能写盘。
 * 这样一次确认里的多张图要么一起留下，要么保持原文件。
 */
export function replaceAuthoringImages(
  existing: readonly AuthoringBox[],
  edits: readonly AuthoringImageEdit[],
): { boxes: AuthoringBox[]; error?: string } {
  let current = existing.slice();
  for (const edit of edits) {
    const image = imageFileName(edit.fileName);
    if (!image || edit.width <= 0 || edit.height <= 0) return { boxes: existing.slice(), error: 'image' };
    const kept = current.filter((box) => !sameImage(box.image, image));
    const taken = new Set(kept.map((box) => box.path));
    const next: AuthoringBox[] = [];
    for (const box of edit.boxes) {
      const pathError = boxPathError(box.path);
      if (pathError) return { boxes: existing.slice(), error: pathError };
      if (taken.has(box.path)) return { boxes: existing.slice(), error: 'duplicate' };
      taken.add(box.path);
      const rect = box.unchanged && box.original
        ? box.original
        : rectForSave(box.original, { x: box.x, y: box.y, w: box.w, h: box.h }, edit.width, edit.height);
      if (!rect || !isStorableRect(rect)) return { boxes: existing.slice(), error: 'rect' };
      next.push({ path: box.path, image, rect });
    }
    current = [...kept, ...next];
  }
  return { boxes: current };
}

function sameImage(a: string, b: string): boolean {
  return imageFileName(a).toLowerCase() === imageFileName(b).toLowerCase();
}

/** 同一张原图上的像素框取最小包围矩形，再归一化。空列表返回 `undefined`。 */
export function unionOnImage(boxes: readonly PixelBox[], width: number, height: number): BoxRect | undefined {
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
  return pixelToRect({ x: left, y: top, w: right - left, h: bottom - top }, width, height);
}

export function publishBoxes(file: AuthoringFile): RuntimeFile {
  return {
    version: BOX_FILE_VERSION,
    boxes: file.boxes.map((box) => ({ path: box.path, rect: [...box.rect] as BoxRect })),
  };
}

export type PublishStatus = 'same' | 'unpublished' | 'runtimeOnly';

export function publishStatus(authoring: AuthoringFile, runtime: RuntimeFile): Array<{ path: string; status: PublishStatus }> {
  const runtimeByPath = new Map(runtime.boxes.map((box) => [box.path, box]));
  const seen = new Set<string>();
  const result: Array<{ path: string; status: PublishStatus }> = [];
  for (const box of authoring.boxes) {
    seen.add(box.path);
    const published = runtimeByPath.get(box.path);
    const same = published !== undefined && sameRect(published.rect, box.rect);
    result.push({ path: box.path, status: same ? 'same' : 'unpublished' });
  }
  for (const box of runtime.boxes) {
    if (!seen.has(box.path)) result.push({ path: box.path, status: 'runtimeOnly' });
  }
  return result;
}

function sameRect(a: BoxRect, b: BoxRect): boolean {
  return a.length === b.length && a.every((value, index) => formatRectNumber(value) === formatRectNumber(b[index]));
}

function quantizeRect(rect: BoxRect): BoxRect {
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

export function parseAuthoring(text: string): BoxParseResult<AuthoringFile> {
  return parseBoxes(text, true);
}

export function parseRuntime(text: string): BoxParseResult<RuntimeFile> {
  const parsed = parseBoxes(text, false);
  return {
    file: { version: parsed.file.version, boxes: parsed.file.boxes.map(({ path: boxPath, rect }) => ({ path: boxPath, rect })) },
    errors: parsed.errors,
  };
}

export function serializeAuthoring(file: AuthoringFile): string {
  const boxes = uniqueAuthoring(file.boxes);
  const body = boxes.map((box) =>
    [
      '    {',
      `      "path": ${JSON.stringify(box.path)},`,
      `      "image": ${JSON.stringify(box.image)},`,
      `      "rect": [${quantizeRect(box.rect).map(formatRectNumber).join(', ')}]`,
      '    }',
    ].join('\n'),
  ).join(',\n');
  return `{\n  "version": ${BOX_FILE_VERSION},\n  "boxes": [${body ? `\n${body}\n  ` : ''}]\n}\n`;
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
  return `{\n  "version": ${BOX_FILE_VERSION},\n  "boxes": [${body ? `\n${body}\n  ` : ''}]\n}\n`;
}

function parseBoxes(text: string, requireImage: boolean): BoxParseResult<AuthoringFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { file: emptyAuthoringFile(), errors: ['json'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { file: emptyAuthoringFile(), errors: ['root'] };
  }
  const record = raw as { version?: unknown; boxes?: unknown };
  const errors: string[] = [];
  if (record.version !== BOX_FILE_VERSION) errors.push('version');
  if (!Array.isArray(record.boxes)) {
    errors.push('boxes');
    return { file: emptyAuthoringFile(), errors };
  }
  const boxes: AuthoringBox[] = [];
  const seen = new Set<string>();
  record.boxes.forEach((entry, index) => {
    const parsed = parseBoxEntry(entry, requireImage);
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
  return { file: { version: BOX_FILE_VERSION, boxes }, errors };
}

function parseBoxEntry(entry: unknown, requireImage: boolean): { box?: AuthoringBox; error?: string } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'entry' };
  const record = entry as { path?: unknown; image?: unknown; rect?: unknown };
  if (typeof record.path !== 'string' || boxPathError(record.path)) return { error: 'path' };
  const image = typeof record.image === 'string' ? imageFileName(record.image) : '';
  if (requireImage && !image) return { error: 'image' };
  const rect = parseRect(record.rect);
  if (!rect) return { error: 'rect' };
  return { box: { path: record.path.trim(), image, rect } };
}

/** 与解析时的矩形约束一致。写盘前拒绝，避免下次读取把整个文件判为损坏。 */
export function isStorableRect(rect: readonly number[]): boolean {
  if (rect.length !== 4 || !rect.every((item) => Number.isFinite(item))) return false;
  const [left, top, right, bottom] = rect;
  return left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && left < right && top < bottom;
}

function parseRect(value: unknown): BoxRect | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
  const rect = value as BoxRect;
  const [left, top, right, bottom] = rect;
  if (left < 0 || top < 0 || right > 1 || bottom > 1) return undefined;
  if (left >= right || top >= bottom) return undefined;
  return [left, top, right, bottom];
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

function uniqueRuntime(boxes: readonly RuntimeBox[]): RuntimeBox[] {
  return uniqueAuthoring(boxes.map((box) => ({ ...box, image: '' }))).map(({ path: boxPath, rect }) => ({ path: boxPath, rect }));
}

function formatRectNumber(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return normalized.toFixed(BOX_RECT_DECIMALS);
}
