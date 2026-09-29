/**
 * 框资源的读盘侧。纯规则在 `boxResourcePure.ts`。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AuthoringBox,
  AuthoringFile,
  BoxRect,
  PixelBox,
  RuntimeFile,
  authoringFile,
  emptyAuthoringFile,
  emptyRuntimeFile,
  imageFileName,
  parseAuthoring,
  parseRuntime,
  isStorableRect,
  pixelToRect,
  publishBoxes,
  resolveBoxRuntimePlan,
  runtimeWriteTarget,
  serializeAuthoring,
  serializeRuntime,
  unionOnImage,
  boxPathError,
  effectiveBoxRuntimeFile,
  replaceAuthoringImages,
  sameBoxFile,
} from './boxResourcePure';

export interface EditedBox {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  original?: BoxRect;
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

function writeText(file: string, text: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

export function readAuthoringFile(rootDir: string, templatesDirectory: string): AuthoringFile {
  return readAuthoringResult(rootDir, templatesDirectory).file;
}

function readAuthoringResult(rootDir: string, templatesDirectory: string): { file: AuthoringFile; errors: string[] } {
  const file = authoringFile(rootDir, templatesDirectory);
  const read = readText(file);
  if (read.missing) return { file: emptyAuthoringFile(), errors: [] };
  if (read.error || read.text === undefined) return { file: emptyAuthoringFile(), errors: ['read'] };
  return parseAuthoring(read.text);
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
  return file.boxes.filter((box) => sameImage(box.image, fileName));
}

/** 删图时去掉它的框。文件还不存在就什么都不写。 */
export function removeImageBoxes(rootDir: string, templatesDirectory: string, fileName: string): boolean {
  const target = authoringFile(rootDir, templatesDirectory);
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return false;
  if (!fs.existsSync(target)) return true;
  const next = parsed.file.boxes.filter((box) => !sameImage(box.image, fileName));
  if (next.length === parsed.file.boxes.length) return true;
  return writeText(target, serializeAuthoring({ version: 1, boxes: next }));
}

/** 两张图的框整套对调。框坐标是相对整图的，不按像素再缩放。文件还不存在且两边都没有框时不创建文件。 */
export function swapImageBoxes(rootDir: string, templatesDirectory: string, fileA: string, fileB: string): boolean {
  const target = authoringFile(rootDir, templatesDirectory);
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return false;
  const nameA = imageFileName(fileA);
  const nameB = imageFileName(fileB);
  let changed = false;
  const next = parsed.file.boxes.map((box) => {
    if (sameImage(box.image, nameA)) {
      changed = true;
      return { ...box, image: nameB };
    }
    if (sameImage(box.image, nameB)) {
      changed = true;
      return { ...box, image: nameA };
    }
    return box;
  });
  if (!changed) return true;
  return writeText(target, serializeAuthoring({ version: 1, boxes: next }));
}

export function replaceImageBoxes(
  rootDir: string,
  templatesDirectory: string,
  fileName: string,
  width: number,
  height: number,
  boxes: EditedBox[],
): string | undefined {
  const image = imageFileName(fileName);
  if (!image || width <= 0 || height <= 0) return 'image';
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return 'parse';
  const merged = replaceAuthoringImages(parsed.file.boxes, [{ fileName, width, height, boxes }]);
  if (merged.error) return merged.error;
  const text = serializeAuthoring({ version: 1, boxes: merged.boxes });
  return writeText(authoringFile(rootDir, templatesDirectory), text) ? undefined : 'write';
}

export function addBox(rootDir: string, templatesDirectory: string, boxPath: string, image: string, rect: BoxRect): string | undefined {
  if (!isStorableRect(rect)) return 'rect';
  const pathError = boxPathError(boxPath);
  if (pathError) return pathError;
  const fileName = imageFileName(image);
  if (!fileName) return 'image';
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return 'parse';
  const current = parsed.file;
  if (current.boxes.some((box) => box.path === boxPath)) return 'duplicate';
  const text = serializeAuthoring({
    version: 1,
    boxes: [...current.boxes, { path: boxPath, image: fileName, rect }],
  });
  return writeText(authoringFile(rootDir, templatesDirectory), text) ? undefined : 'write';
}

export function publishRuntime(rootDir: string, templatesDirectory: string, declared?: string, fromConfigPy?: string): boolean {
  const parsed = readAuthoringResult(rootDir, templatesDirectory);
  if (parsed.errors.length) return false;
  const runtime = readRuntimeResult(rootDir, declared, fromConfigPy);
  if (runtime.errors.length) return false;
  const authoringPath = authoringFile(rootDir, templatesDirectory);
  const target = runtimeWriteTarget(resolveBoxRuntimePlan(rootDir, declared, fromConfigPy));
  if (sameStoredFile(authoringPath, target)) return false;
  const text = serializeRuntime(publishBoxes(parsed.file));
  return writeText(target, text);
}

export function runtimeOnlyPaths(authoring: AuthoringFile, runtime: RuntimeFile): string[] {
  const live = new Set(authoring.boxes.map((box) => box.path));
  return runtime.boxes.map((box) => box.path).filter((boxPath) => !live.has(boxPath));
}

export function rectFromPixels(boxes: PixelBox[], width: number, height: number): BoxRect | undefined {
  if (boxes.length === 1) return pixelToRect(boxes[0], width, height);
  return unionOnImage(boxes, width, height);
}
