/** Box authoring delegates to the same COCO store as template authoring. */
import * as fs from 'fs';
import * as path from 'path';
import { CocoAnnotationData, writeAnnotationText, notifyAnnotationDataChanged } from './cocoAnnotationData';
import {
  AUTHORING_FILE_NAME,
  AuthoringFile,
  PixelBox,
  authoringFile,
  authoringFromCoco,
  boxesForImageFile,
  boxPathError,
  imageFileName,
  unionPixelBoxes,
} from './boxResourcePure';

function loadBoxAnnotationData(root: string, directory: string): CocoAnnotationData {
  const data = new CocoAnnotationData(root, directory, AUTHORING_FILE_NAME);
  data.load();
  return data;
}

function loadEditableBoxAnnotationData(root: string, directory: string): {
  data: CocoAnnotationData;
  recoveredInvalid: boolean;
} {
  const data = loadBoxAnnotationData(root, directory);
  const recoveredInvalid = data.readErrors.length > 0 && !data.readErrors.includes('read');
  if (recoveredInvalid) data.readErrors = [];
  return { data, recoveredInvalid };
}

export function boxAnnotationData(root: string, directory: string): CocoAnnotationData {
  return loadBoxAnnotationData(root, directory);
}

export function readAuthoringFile(root: string, directory: string): AuthoringFile {
  return authoringFromCoco(boxAnnotationData(root, directory).data);
}

export function authoringReadErrors(root: string, directory: string): string[] {
  return boxAnnotationData(root, directory).readErrors;
}

export function authoringImageSize(
  root: string,
  directory: string,
  name: string,
): { width: number; height: number } | undefined {
  return boxAnnotationData(root, directory).resolveImageSize(
    path.resolve(root, directory, imageFileName(name)),
  );
}

export const boxesForImage = boxesForImageFile;

export function captureAuthoring(root: string, directory: string): { text: string | null } | null {
  try {
    return { text: fs.readFileSync(authoringFile(root, directory), 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { text: null } : null;
  }
}

export function restoreAuthoring(
  root: string,
  directory: string,
  snapshot: { text: string | null },
): boolean {
  const target = authoringFile(root, directory);
  try {
    if (snapshot.text === null) {
      fs.rmSync(target, { force: true });
      notifyAnnotationDataChanged(target);
    } else {
      writeAnnotationText(target, snapshot.text);
    }
    return true;
  } catch {
    return false;
  }
}

export function removeImageBoxes(root: string, directory: string, name: string): boolean {
  const loaded = loadEditableBoxAnnotationData(root, directory);
  const data = loaded.data;
  if (data.readErrors.length) return false;
  if (!fs.existsSync(data.annotationFile)) return true;
  try {
    if (loaded.recoveredInvalid) {
      data.save();
      return true;
    }
    const image = path.join(data.templatesDir, imageFileName(name));
    if (!data.getSwapImageEntry(image)) return true;
    data.removeImageEntry(image);
    data.save();
    return true;
  } catch {
    return false;
  }
}

/** The only rect-specific edit rule: names form unique Python attribute paths within rect authoring. */
export function boxNamesError(
  data: CocoAnnotationData,
  image: string,
  names: readonly string[],
): string | undefined {
  const ownIds = new Set(data.getAnnotationsForImage(image, true).map((ann) => ann.id));
  const occupied = new Set(
    data.data.annotations
      .filter((ann) => !ownIds.has(ann.id))
      .map((ann) => data.getCategoryName(ann.category_id)?.trim()),
  );
  for (const name of names) {
    const trimmed = name.trim();
    const error = boxPathError(trimmed);
    if (error) return error;
    if (occupied.has(trimmed)) return 'duplicate';
    occupied.add(trimmed);
  }
  return undefined;
}

export function addBox(
  root: string,
  directory: string,
  name: string,
  imageName: string,
  box: PixelBox,
): string | undefined {
  const data = loadEditableBoxAnnotationData(root, directory).data;
  if (data.readErrors.length) return 'parse';
  const image = path.join(data.templatesDir, imageFileName(imageName));
  if (!data.resolveImageSize(image)) return 'image';
  const annotations = data.getAnnotationsForImage(image, true).map((ann) => ({
    category: ann.categoryName,
    x: ann.bbox[0],
    y: ann.bbox[1],
    w: ann.bbox[2],
    h: ann.bbox[3],
  }));
  annotations.push({ category: name.trim(), ...box });
  const error = boxNamesError(data, image, annotations.map((ann) => ann.category));
  if (error) return error;
  try {
    if (!data.setAnnotationsForImage(image, annotations)) return 'rect';
    data.save();
    return undefined;
  } catch (error) {
    console.error('[ok-script] save box:', error);
    return 'write';
  }
}

export const pixelUnionFromAnnotations = unionPixelBoxes;
export { roundPixelBbox, pixelBboxError } from './annotationGeometry';
