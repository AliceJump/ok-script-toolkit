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
  pixelToRect,
  publishBoxes,
  rectForSave,
  resolveBoxRuntimePlan,
  runtimeWriteTarget,
  serializeAuthoring,
  serializeRuntime,
  unionOnImage,
  boxPathError,
  effectiveBoxRuntimeFile,
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

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
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
  const file = authoringFile(rootDir, templatesDirectory);
  const text = readText(file);
  return text ? parseAuthoring(text).file : emptyAuthoringFile();
}

export function readRuntimeFile(rootDir: string, declared?: string, fromConfigPy?: string): RuntimeFile {
  const plan = resolveBoxRuntimePlan(rootDir, declared, fromConfigPy);
  const file = effectiveBoxRuntimeFile(plan, (candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  if (!file) return emptyRuntimeFile();
  const text = readText(file);
  return text ? parseRuntime(text).file : emptyRuntimeFile();
}

export function boxesForImage(file: AuthoringFile, fileName: string): AuthoringBox[] {
  return file.boxes.filter((box) => sameImage(box.image, fileName));
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
  const current = readAuthoringFile(rootDir, templatesDirectory);
  const kept = current.boxes.filter((box) => !sameImage(box.image, image));
  const taken = new Set(kept.map((box) => box.path));
  const next: AuthoringBox[] = [];
  for (const box of boxes) {
    const pathError = boxPathError(box.path);
    if (pathError) return pathError;
    if (taken.has(box.path)) return 'duplicate';
    taken.add(box.path);
    const rect = rectForSave(box.original, { x: box.x, y: box.y, w: box.w, h: box.h }, width, height);
    if (!rect) return 'rect';
    next.push({ path: box.path, image, rect });
  }
  const text = serializeAuthoring({ version: 1, boxes: [...kept, ...next] });
  return writeText(authoringFile(rootDir, templatesDirectory), text) ? undefined : 'write';
}

export function addBox(rootDir: string, templatesDirectory: string, boxPath: string, image: string, rect: BoxRect): string | undefined {
  const pathError = boxPathError(boxPath);
  if (pathError) return pathError;
  const fileName = imageFileName(image);
  if (!fileName) return 'image';
  const current = readAuthoringFile(rootDir, templatesDirectory);
  if (current.boxes.some((box) => box.path === boxPath)) return 'duplicate';
  const text = serializeAuthoring({
    version: 1,
    boxes: [...current.boxes, { path: boxPath, image: fileName, rect }],
  });
  return writeText(authoringFile(rootDir, templatesDirectory), text) ? undefined : 'write';
}

export function publishRuntime(rootDir: string, templatesDirectory: string, declared?: string, fromConfigPy?: string): boolean {
  const authoring = readAuthoringFile(rootDir, templatesDirectory);
  const text = serializeRuntime(publishBoxes(authoring));
  const target = runtimeWriteTarget(resolveBoxRuntimePlan(rootDir, declared, fromConfigPy));
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
