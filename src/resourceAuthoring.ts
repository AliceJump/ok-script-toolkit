import * as path from 'path';
import { CocoAnnotationData } from './cocoAnnotationData';
import { readAuthoringFile } from './boxResourceStore';
import { readPoints } from './pointResourceStore';
import { templatesDirectory } from './projectConfig';

export type ResourceKind = 'template' | 'rect' | 'point';

/** A transient projection of current annotations, never written as another source of truth. */
export interface AuthoringResource {
  name: string;
  kind: ResourceKind;
  imagePath: string;
  bbox: [number, number, number, number];
}

export function positionResources(root: string): AuthoringResource[] {
  if (!root) return [];
  const directory = templatesDirectory(root);
  const boxes = readAuthoringFile(root, directory);
  const points = readPoints(root, directory);
  return [
    ...boxes.boxes.map(box => ({ name: box.path, kind: 'rect' as const,
      imagePath: path.resolve(root, directory, box.image), bbox: box.bbox })),
    ...(points.errors.length ? [] : points.file.points.map(point => ({ name: point.path, kind: 'point' as const,
      imagePath: path.resolve(root, directory, point.image), bbox: [point.x, point.y, 0, 0] as [number, number, number, number] }))),
  ];
}

export function findAuthoringResource(root: string, kind: ResourceKind, name: string): AuthoringResource | undefined {
  if (!root) return undefined;
  if (kind !== 'template') {
    const matches = positionResources(root).filter(item => item.kind === kind && item.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const data = new CocoAnnotationData(root, templatesDirectory(root));
  data.load();
  const categories = new Map(data.data.categories.map(item => [item.id, item.name]));
  const matches = data.data.annotations.filter(item => categories.get(item.category_id) === name);
  if (matches.length !== 1) return undefined;
  const annotation = matches[0];
  const image = data.data.images.find(item => item.id === annotation.image_id);
  return image ? { name, kind, imagePath: path.resolve(data.templatesDir, image.file_name), bbox: annotation.bbox } : undefined;
}

export function positionLeaf(resources: readonly AuthoringResource[], name: string): AuthoringResource | undefined {
  const matches = resources.filter(item => item.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

export function positionSummary(resource: AuthoringResource): string {
  const [x, y, w, h] = resource.bbox;
  return resource.kind === 'point' ? `Point · (${x}, ${y})` : `Box · ${w}×${h}`;
}
