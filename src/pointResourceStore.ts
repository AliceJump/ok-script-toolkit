import * as fs from 'fs';
import * as path from 'path';
import { writeAnnotationText } from './cocoAnnotationData';
import { readImageSize } from './imageHeader';
import { positionPathError, PixelPoint, PositionAuthoringItem, PositionImage } from './positionResourcePure';

export const POINT_AUTHORING_FILE = 'points.json';
const VERSION = 1;

export interface AuthoringPoint {
  path: string;
  image: string;
  x: number;
  y: number;
}

interface PointAuthoringFile {
  version: number;
  images: PositionImage[];
  points: AuthoringPoint[];
}

export interface PointReadResult {
  file: PointAuthoringFile;
  errors: string[];
}

function emptyFile(): PointAuthoringFile {
  return { version: VERSION, images: [], points: [] };
}

function sourceFile(root: string, directory: string): string {
  return path.join(path.resolve(root, directory), POINT_AUTHORING_FILE);
}

function parse(text: string): PointReadResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { file: emptyFile(), errors: ['json'] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file: emptyFile(), errors: ['root'] };
  const record = raw as Partial<PointAuthoringFile>;
  if (record.version !== VERSION || !Array.isArray(record.images) || !Array.isArray(record.points)) {
    return { file: emptyFile(), errors: ['schema'] };
  }
  const errors: string[] = [];
  const images: PositionImage[] = [];
  const imageNames = new Set<string>();
  for (const image of record.images) {
    if (!image || typeof image.file !== 'string' || !image.file || !Number.isFinite(image.width) || !Number.isFinite(image.height)
      || image.width <= 0 || image.height <= 0 || imageNames.has(image.file.toLowerCase())) {
      errors.push('image');
      continue;
    }
    imageNames.add(image.file.toLowerCase());
    images.push({ file: image.file, width: image.width, height: image.height });
  }
  const points: AuthoringPoint[] = [];
  const paths = new Set<string>();
  for (const point of record.points) {
    if (!point || typeof point.path !== 'string' || positionPathError(point.path)
      || typeof point.image !== 'string' || !point.image
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || paths.has(point.path.trim())) {
      errors.push('point');
      continue;
    }
    paths.add(point.path.trim());
    points.push({ path: point.path.trim(), image: point.image, x: point.x, y: point.y });
  }
  return errors.length ? { file: emptyFile(), errors } : { file: { version: VERSION, images, points }, errors: [] };
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
  current.file.points.push(...points.map(point => ({ path: point.path.trim(), image: imageName, x: point.x, y: point.y })));
  current.file.points.sort((a, b) => a.path.localeCompare(b.path));
  const image = current.file.images.find(item => item.file.toLowerCase() === imageName.toLowerCase());
  if (image) { image.width = size.width; image.height = size.height; }
  else current.file.images.push({ file: imageName, width: size.width, height: size.height });
  const used = new Set(current.file.points.map(point => point.image.toLowerCase()));
  current.file.images = current.file.images.filter(item => used.has(item.file.toLowerCase()));
  current.file.images.sort((a, b) => a.file.localeCompare(b.file));

  try {
    writeAnnotationText(sourceFile(root, directory), JSON.stringify(current.file, null, 2) + '\n');
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
