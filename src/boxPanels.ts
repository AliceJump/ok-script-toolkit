import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationPanel } from './annotationPanel';
import { readAuthoringFile } from './boxResourceStore';
import { AUTHORING_FILE_NAME, PixelBox } from './boxResourcePure';
import { templatesDirectory } from './projectConfig';
import { readImageSize } from './pngCrop';
import { TemplateAssetData } from './templateAssetData';
import { readPoints } from './pointResourceStore';

/** Cross-image rect path occupancy used by the unified annotation editor. */
export function boxPathOccupancy(authoring: ReturnType<typeof readAuthoringFile>): Record<string, string> {
  const occupied: Record<string, string> = {};
  for (const box of authoring.boxes) occupied[box.path] = box.image;
  return occupied;
}

/** Same editor/controller as template annotations; only the source file and name rule differ. */
export function openBoxEditor(
  extensionUri: vscode.Uri,
  data: TemplateAssetData,
  imagePath: string,
  thumbDir = '',
): void {
  const boxes = data.fileName === AUTHORING_FILE_NAME
    ? data
    : new TemplateAssetData(data.root, AUTHORING_FILE_NAME);
  AnnotationPanel.show(
    extensionUri,
    boxes,
    thumbDir || boxes.templatesDir,
    imagePath,
    boxes.listImages(),
    () => {},
    true,
  );
}

/**
 * Position preview source comes directly from current authoring data. There is no separately
 * indexed legacy box runtime file anymore. Rects use their exact bbox; points use a tiny marker
 * box so existing hover rendering can still highlight their location.
 */
export function previewRectForPath(
  root: string,
  positionPath: string,
): { imagePath: string; bbox: [number, number, number, number] } | undefined {
  const directory = templatesDirectory(root);
  const authoring = readAuthoringFile(root, directory);
  const rect = authoring.boxes.find((box) => box.path === positionPath);
  if (rect) {
    const imagePath = path.join(root, directory, rect.image);
    if (!fs.existsSync(imagePath)) return undefined;
    const size = readImageSize(fs.readFileSync(imagePath));
    if (!size) return undefined;
    const pixel: PixelBox = {
      x: rect.bbox[0],
      y: rect.bbox[1],
      w: rect.bbox[2],
      h: rect.bbox[3],
    };
    if (pixel.w <= 0 || pixel.h <= 0) return undefined;
    return { imagePath, bbox: [pixel.x, pixel.y, pixel.w, pixel.h] };
  }

  const points = readPoints(root, directory);
  if (points.errors.length) return undefined;
  const point = points.file.points.find((item) => item.path === positionPath);
  if (!point) return undefined;
  const imagePath = path.join(root, directory, point.image);
  if (!fs.existsSync(imagePath)) return undefined;
  const size = readImageSize(fs.readFileSync(imagePath));
  if (!size) return undefined;
  const marker = 10;
  const left = Math.max(0, Math.min(size.width - 1, Math.round(point.x - marker / 2)));
  const top = Math.max(0, Math.min(size.height - 1, Math.round(point.y - marker / 2)));
  const width = Math.max(1, Math.min(marker, size.width - left));
  const height = Math.max(1, Math.min(marker, size.height - top));
  return { imagePath, bbox: [left, top, width, height] };
}

/** Completion/hover indexes the current rect + point authoring namespace directly. */
export function posPaths(root: string): string[] {
  const directory = templatesDirectory(root);
  const rects = readAuthoringFile(root, directory).boxes.map((box) => box.path);
  const pointResult = readPoints(root, directory);
  const points = pointResult.errors.length ? [] : pointResult.file.points.map((point) => point.path);
  return [...new Set([...rects, ...points])].sort((a, b) => a.localeCompare(b));
}
