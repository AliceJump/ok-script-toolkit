/** Box authoring delegates to the same COCO store as template authoring. */
import * as fs from 'fs';
import * as path from 'path';
import { CocoAnnotationData, writeAnnotationText, notifyAnnotationDataChanged } from './cocoAnnotationData';
import {
  AUTHORING_FILE_NAME, AuthoringFile, PixelBox, RuntimeFile, authoringFile, authoringFromCoco,
  boxesForImageFile, boxPathError, effectiveBoxRuntimeFile, emptyRuntimeFile, imageFileName,
  parseBoxCoco, parseRuntime, publishBoxes, publishStatus, resolveBoxRuntimePlan,
  runtimeWriteTarget, sameBoxFile, serializeRuntime, unionPixelBoxes,
} from './boxResourcePure';
import { readImageSize } from './imageHeader';

export function boxAnnotationData(root: string, directory: string): CocoAnnotationData {
  const data = new CocoAnnotationData(root, directory, AUTHORING_FILE_NAME, text => parseBoxCoco(text, name => {
    try { return readImageSize(fs.readFileSync(path.resolve(root, directory, name))); } catch { return undefined; }
  }));
  data.load();
  return data;
}

function sameStoredFile(a: string, b: string): boolean {
  try {
    if (fs.existsSync(a) && fs.existsSync(b)) return sameBoxFile(fs.realpathSync(a), fs.realpathSync(b));
  } catch { /* fall back to normalized paths */ }
  return sameBoxFile(a, b);
}

export function readAuthoringFile(root: string, directory: string): AuthoringFile {
  return authoringFromCoco(boxAnnotationData(root, directory).data);
}
export function authoringReadErrors(root: string, directory: string): string[] {
  return boxAnnotationData(root, directory).readErrors;
}
export function authoringImageSize(root: string, directory: string, name: string): { width: number; height: number } | undefined {
  return boxAnnotationData(root, directory).resolveImageSize(path.resolve(root, directory, imageFileName(name)));
}

function readRuntimeResult(root: string, declared?: string, fromConfigPy?: string): { file: RuntimeFile; errors: string[] } {
  const target = effectiveBoxRuntimeFile(resolveBoxRuntimePlan(root, declared, fromConfigPy), fs.existsSync);
  if (!target) return { file: emptyRuntimeFile(), errors: [] };
  try { return parseRuntime(fs.readFileSync(target, 'utf8')); } catch { return { file: emptyRuntimeFile(), errors: ['read'] }; }
}
export function runtimeReadErrors(root: string, declared?: string, fromConfigPy?: string): string[] {
  return readRuntimeResult(root, declared, fromConfigPy).errors;
}
export function readRuntimeFile(root: string, declared?: string, fromConfigPy?: string): RuntimeFile {
  return readRuntimeResult(root, declared, fromConfigPy).file;
}
export const boxesForImage = boxesForImageFile;

export function captureAuthoring(root: string, directory: string): { text: string | null } | null {
  try { return { text: fs.readFileSync(authoringFile(root, directory), 'utf8') }; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { text: null } : null;
  }
}
export function restoreAuthoring(root: string, directory: string, snapshot: { text: string | null }): boolean {
  const target = authoringFile(root, directory);
  try {
    if (snapshot.text === null) {
      fs.rmSync(target, { force: true });
      notifyAnnotationDataChanged(target);
    } else writeAnnotationText(target, snapshot.text);
    return true;
  } catch { return false; }
}
export function removeImageBoxes(root: string, directory: string, name: string): boolean {
  const data = boxAnnotationData(root, directory);
  if (data.readErrors.length) return false;
  if (!fs.existsSync(data.annotationFile)) return true;
  const image = path.join(data.templatesDir, imageFileName(name));
  if (!data.getSwapImageEntry(image)) return true;
  try { data.removeImageEntry(image); data.save(); return true; } catch { return false; }
}

/** The only box-specific edit rule: names form unique Python attribute paths. */
export function boxNamesError(data: CocoAnnotationData, image: string, names: readonly string[]): string | undefined {
  const ownIds = new Set(data.getAnnotationsForImage(image, true).map(ann => ann.id));
  const occupied = new Set(data.data.annotations.filter(ann => !ownIds.has(ann.id))
    .map(ann => data.getCategoryName(ann.category_id)?.trim()));
  for (const name of names) {
    const trimmed = name.trim();
    const error = boxPathError(trimmed);
    if (error) return error;
    if (occupied.has(trimmed)) return 'duplicate';
    occupied.add(trimmed);
  }
  return undefined;
}

export function addBox(root: string, directory: string, name: string, imageName: string, box: PixelBox): string | undefined {
  const data = boxAnnotationData(root, directory);
  if (data.readErrors.length) return 'parse';
  const image = path.join(data.templatesDir, imageFileName(imageName));
  if (!data.resolveImageSize(image)) return 'image';
  const annotations = data.getAnnotationsForImage(image, true).map(ann => ({
    category: ann.categoryName, x: ann.bbox[0], y: ann.bbox[1], w: ann.bbox[2], h: ann.bbox[3],
  }));
  annotations.push({ category: name.trim(), ...box });
  const error = boxNamesError(data, image, annotations.map(ann => ann.category));
  if (error) return error;
  try {
    if (!data.setAnnotationsForImage(image, annotations)) return 'rect';
    data.save();
    return undefined;
  } catch (error) { console.error('[ok-script] save box:', error); return 'write'; }
}

export function publishRuntime(root: string, directory: string, declared?: string, fromConfigPy?: string): { ok: boolean; errors: string[] } {
  const data = boxAnnotationData(root, directory);
  if (data.readErrors.length) return { ok: false, errors: data.readErrors };
  const authoring = authoringFromCoco(data.data);
  // An empty source does not replace a previously published position table.
  if (!authoring.boxes.length) return { ok: false, errors: ['empty'] };
  const target = runtimeWriteTarget(resolveBoxRuntimePlan(root, declared, fromConfigPy));
  if (sameStoredFile(data.annotationFile, target)) return { ok: false, errors: ['same'] };
  if (readRuntimeResult(root, declared, fromConfigPy).errors.length) return { ok: false, errors: ['runtimeRead'] };
  // Resolve sizes with the same header-first fallback as template export and swapping.
  authoring.images = authoring.images.map(image => ({ ...image, ...data.resolveImageSize(path.join(data.templatesDir, image.file)) }));
  const published = publishBoxes(authoring);
  if (published.errors.length) return { ok: false, errors: published.errors };
  try { writeAnnotationText(target, serializeRuntime(published.file)); return { ok: true, errors: [] }; }
  catch (error) { console.error('[ok-script] publish boxes:', error); return { ok: false, errors: ['write'] }; }
}
export function runtimeOnlyPaths(authoring: AuthoringFile, runtime: RuntimeFile): string[] {
  const live = new Set(authoring.boxes.map(box => box.path));
  return runtime.boxes.map(box => box.path).filter(name => !live.has(name));
}
export const pixelUnionFromAnnotations = unionPixelBoxes;
export { publishStatus };
export { roundPixelBbox, pixelBboxError } from './annotationGeometry';
