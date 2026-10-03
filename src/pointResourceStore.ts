import * as fs from 'fs';
import * as path from 'path';
import { CocoData, writeAnnotationText } from './cocoAnnotationData';
import { readImageSize } from './imageHeader';
import { positionPathError, PixelPoint, PositionAuthoringItem, PositionImage } from './positionResourcePure';

export const POINT_AUTHORING_FILE = 'points.json';

export interface AuthoringPoint {
  path: string;
  image: string;
  x: number;
  y: number;
}

interface PointAuthoringFile {
  images: PositionImage[];
  points: AuthoringPoint[];
}

interface LegacyPointAuthoringFile {
  version: number;
  images: PositionImage[];
  points: AuthoringPoint[];
}

export interface PointReadResult {
  file: PointAuthoringFile;
  errors: string[];
  legacy?: boolean;
}

function emptyFile(): PointAuthoringFile {
  return { images: [], points: [] };
}

function sourceFile(root: string, directory: string): string {
  return path.join(path.resolve(root, directory), POINT_AUTHORING_FILE);
}

function parseLegacy(raw: LegacyPointAuthoringFile): PointReadResult {
  if (raw.version !== 1 || !Array.isArray(raw.images) || !Array.isArray(raw.points)) {
    return { file: emptyFile(), errors: ['schema'] };
  }
  const imageNames = new Set<string>();
  const images: PositionImage[] = [];
  for (const image of raw.images) {
    if (!image || typeof image.file !== 'string' || !image.file || !Number.isFinite(image.width) || !Number.isFinite(image.height)
      || image.width <= 0 || image.height <= 0 || imageNames.has(image.file.toLowerCase())) {
      return { file: emptyFile(), errors: ['image'] };
    }
    imageNames.add(image.file.toLowerCase());
    images.push({ file: image.file, width: image.width, height: image.height });
  }
  const paths = new Set<string>();
  const points: AuthoringPoint[] = [];
  for (const point of raw.points) {
    const name = point?.path?.trim();
    if (!point || typeof name !== 'string' || positionPathError(name)
      || typeof point.image !== 'string' || !point.image
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || paths.has(name)) {
      return { file: emptyFile(), errors: ['point'] };
    }
    const image = images.find(item => item.file.toLowerCase() === point.image.toLowerCase());
    if (!image || point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height) {
      return { file: emptyFile(), errors: ['point'] };
    }
    paths.add(name);
    points.push({ path: name, image: point.image, x: point.x, y: point.y });
  }
  return { file: { images, points }, errors: [], legacy: true };
}

function parseCoco(raw: CocoData): PointReadResult {
  if (!raw || !Array.isArray(raw.images) || !Array.isArray(raw.annotations) || !Array.isArray(raw.categories)) {
    return { file: emptyFile(), errors: ['coco'] };
  }
  const imageIds = new Set<number>();
  const categoryIds = new Set<number>();
  const annotationIds = new Set<number>();
  const images: PositionImage[] = [];
  for (const image of raw.images) {
    if (!image || !Number.isInteger(image.id) || imageIds.has(image.id)
      || typeof image.file_name !== 'string' || !image.file_name
      || !Number.isFinite(image.width) || !Number.isFinite(image.height)
      || image.width <= 0 || image.height <= 0) return { file: emptyFile(), errors: ['image'] };
    imageIds.add(image.id);
    images.push({ file: image.file_name, width: image.width, height: image.height });
  }
  const names = new Map<number, string>();
  const usedNames = new Set<string>();
  for (const category of raw.categories) {
    const name = category?.name?.trim();
    if (!category || !Number.isInteger(category.id) || categoryIds.has(category.id)
      || typeof name !== 'string' || positionPathError(name) || usedNames.has(name)) {
      return { file: emptyFile(), errors: ['category'] };
    }
    categoryIds.add(category.id);
    usedNames.add(name);
    names.set(category.id, name);
  }
  const points: AuthoringPoint[] = [];
  const usedPointNames = new Set<string>();
  for (const annotation of raw.annotations) {
    if (!annotation || !Number.isInteger(annotation.id) || annotationIds.has(annotation.id)
      || !imageIds.has(annotation.image_id) || !categoryIds.has(annotation.category_id)
      || !Array.isArray(annotation.bbox) || annotation.bbox.length !== 4 || !annotation.bbox.every(Number.isFinite)) {
      return { file: emptyFile(), errors: ['annotation'] };
    }
    annotationIds.add(annotation.id);
    const [x, y, w, h] = annotation.bbox;
    if (w !== 0 || h !== 0) return { file: emptyFile(), errors: ['pointGeometry'] };
    const imageRow = raw.images.find(image => image.id === annotation.image_id)!;
    if (x < 0 || y < 0 || x > imageRow.width || y > imageRow.height) {
      return { file: emptyFile(), errors: ['pointGeometry'] };
    }
    const name = names.get(annotation.category_id)!;
    if (usedPointNames.has(name)) return { file: emptyFile(), errors: ['duplicate'] };
    usedPointNames.add(name);
    points.push({ path: name, image: imageRow.file_name, x, y });
  }
  return { file: { images, points }, errors: [] };
}

function parse(text: string): PointReadResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { file: emptyFile(), errors: ['json'] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file: emptyFile(), errors: ['root'] };
  const record = raw as Record<string, unknown>;
  if ('version' in record && 'points' in record) return parseLegacy(raw as LegacyPointAuthoringFile);
  return parseCoco(raw as CocoData);
}

function toCoco(file: PointAuthoringFile): CocoData {
  const usedImages = new Set(file.points.map(point => point.image.toLowerCase()));
  const images = file.images
    .filter(image => usedImages.has(image.file.toLowerCase()))
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((image, index) => ({ id: index + 1, file_name: image.file, width: image.width, height: image.height }));
  const names = [...new Set(file.points.map(point => point.path))].sort((a, b) => a.localeCompare(b));
  const categories = names.map((name, index) => ({ id: index + 1, name, supercategory: name.split('.')[0] || 'point' }));
  const imageIds = new Map(images.map(image => [image.file_name.toLowerCase(), image.id]));
  const categoryIds = new Map(categories.map(category => [category.name, category.id]));
  const annotations = [...file.points]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((point, index) => ({
      id: index + 1,
      image_id: imageIds.get(point.image.toLowerCase())!,
      category_id: categoryIds.get(point.path)!,
      bbox: [Math.round(point.x), Math.round(point.y), 0, 0] as [number, number, number, number],
      area: 0,
      iscrowd: 0,
    }));
  return { images, annotations, categories };
}

export function readPoints(root: string, directory: string): PointReadResult {
  try { return parse(fs.readFileSync(sourceFile(root, directory), 'utf8')); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { file: emptyFile(), errors: [] }
      : { file: emptyFile(), errors: ['read'] };
  }
}

export function pointsForImage(root: string, directory: string, imageName: string): AuthoringPoint[] {
  const result = readPoints(root, directory);
  if (result.errors.length) return [];
  return result.file.points.filter(point => point.image.toLowerCase() === imageName.toLowerCase());
}

export function pointPathOccupancy(root: string, directory: string): Record<string, string> {
  const result = readPoints(root, directory);
  if (result.errors.length) return {};
  return Object.fromEntries(result.file.points.map(point => [point.path, point.image]));
}

export function savePointsForImage(
  root: string,
  directory: string,
  imagePath: string,
  points: readonly { path: string; x: number; y: number }[],
): string | undefined {
  const current = readPoints(root, directory);
  if (current.errors.length) return 'parse';
  const imageName = path.basename(imagePath);
  let size;
  try { size = readImageSize(fs.readFileSync(imagePath)); } catch { return 'image'; }
  if (!size || size.width <= 0 || size.height <= 0) return 'image';

  const own = new Set(current.file.points.filter(point => point.image.toLowerCase() === imageName.toLowerCase()).map(point => point.path));
  const occupied = new Set(current.file.points.filter(point => !own.has(point.path)).map(point => point.path));
  for (const point of points) {
    const name = point.path.trim();
    if (positionPathError(name)) return 'path';
    if (occupied.has(name)) return 'duplicate';
    occupied.add(name);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) return 'geometry';
  }

  current.file.points = current.file.points.filter(point => point.image.toLowerCase() !== imageName.toLowerCase());
  current.file.points.push(...points.map(point => ({ path: point.path.trim(), image: imageName, x: Math.round(point.x), y: Math.round(point.y) })));
  const image = current.file.images.find(item => item.file.toLowerCase() === imageName.toLowerCase());
  if (image) { image.width = size.width; image.height = size.height; }
  else current.file.images.push({ file: imageName, width: size.width, height: size.height });

  try {
    writeAnnotationText(sourceFile(root, directory), JSON.stringify(toCoco(current.file), null, 2) + '\n');
    return undefined;
  } catch {
    return 'write';
  }
}

export function pointAuthoringPositions(root: string, directory: string): { items: PositionAuthoringItem[]; images: PositionImage[]; errors: string[] } {
  const result = readPoints(root, directory);
  if (result.errors.length) return { items: [], images: [], errors: result.errors };
  return {
    images: result.file.images,
    items: result.file.points.map(point => ({
      path: point.path,
      image: point.image,
      kind: 'point',
      point: { x: point.x, y: point.y } as PixelPoint,
    })),
    errors: [],
  };
}
