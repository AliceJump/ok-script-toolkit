/** Box authoring helpers. Runtime publication is handled exclusively by the unified position resource. */
import * as path from 'path';
import { CocoData, parseCocoData } from './cocoAnnotationData';
import { pixelBboxError, roundPixelBbox } from './annotationGeometry';
export { pixelBboxError, roundPixelBbox } from './annotationGeometry';

export const AUTHORING_FILE_NAME = 'boxes.json';

/** Authoring-only pixel bbox, identical to template COCO bbox semantics. */
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

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Segment grammar sent to the webview. Rect and point resources intentionally use the same
 * Python-attribute path shape; namespace collisions are reported by unified position publish.
 */
export const BOX_PATH_SEGMENT_SOURCE = SEGMENT.source;

/** Authoring source path. It follows templates.directory and is always COCO. */
export function authoringFile(rootDir: string, templatesDirectory: string): string {
  return path.resolve(rootDir, templatesDirectory, AUTHORING_FILE_NAME);
}

/** Valid paths contain at least two Python-identifier segments. */
export function boxPathError(value: string): 'empty' | 'segment' | 'shallow' | undefined {
  const pathValue = value.trim();
  if (!pathValue) return 'empty';
  const segments = pathValue.split('.');
  if (segments.length < 2) return 'shallow';
  if (segments.some((segment) => !SEGMENT.test(segment))) return 'segment';
  return undefined;
}

export function imageFileName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
}

function sameImage(a: string, b: string): boolean {
  return imageFileName(a).toLowerCase() === imageFileName(b).toLowerCase();
}

export function boxesForImageFile(file: AuthoringFile, fileName: string): AuthoringBox[] {
  return file.boxes.filter((box) => sameImage(box.image, fileName));
}

/** Smallest pixel-space bounding box containing every input box. */
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

/** Rect authoring uses the current COCO schema only. */
export function parseBoxCoco(text: string) {
  return parseCocoData(text);
}

/** Read-only authoring projection used by resource preview and unified position publish. */
export function authoringFromCoco(data: CocoData): AuthoringFile {
  const images = data.images.map((image) => ({
    file: image.file_name,
    width: image.width,
    height: image.height,
  }));
  const imageById = new Map(data.images.map((image) => [image.id, image]));
  const categoryById = new Map(data.categories.map((category) => [category.id, category]));
  const boxes = data.annotations.map((annotation) => ({
    path: categoryById.get(annotation.category_id)!.name.trim(),
    image: imageById.get(annotation.image_id)!.file_name,
    bbox: annotation.bbox,
  }));
  return { images, boxes };
}
