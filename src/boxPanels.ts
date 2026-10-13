import * as vscode from 'vscode';
import { AnnotationPanel } from './annotationPanel';
import { readAuthoringFile } from './boxResourceStore';
import { AUTHORING_FILE_NAME } from './boxResourcePure';
import { TemplateAssetData } from './templateAssetData';
import { positionResources } from './resourceAuthoring';

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

/** Position previews and completion share the current authoring projection. */
export function previewRectForPath(root: string, positionPath: string): { imagePath: string; bbox: [number, number, number, number] } | undefined {
  const resource = positionResources(root).find(item => item.name === positionPath);
  return resource ? { imagePath: resource.imagePath, bbox: resource.bbox } : undefined;
}

export function posPaths(root: string): string[] {
  return [...new Set(positionResources(root).map(item => item.name))].sort((a, b) => a.localeCompare(b));
}
