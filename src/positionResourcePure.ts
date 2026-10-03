/** Unified point/rect position resource projection and export helpers. */

export type PositionKind = 'rect' | 'point';
export type NormalizedPoint = [number, number];
export type NormalizedRect = [number, number, number, number];
export type NormalizedCoordinates = NormalizedPoint | NormalizedRect;

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelRect extends PixelPoint {
  w: number;
  h: number;
}

export interface PositionImage {
  file: string;
  width: number;
  height: number;
}

export interface PositionAuthoringItem {
  path: string;
  image: string;
  kind: PositionKind;
  point?: PixelPoint;
  rect?: PixelRect;
}

export interface RuntimePosition {
  path: string;
  coordinates: NormalizedCoordinates;
}

export interface RuntimePositionFile {
  version: 2;
  positions: RuntimePosition[];
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMALS = 6;

export function positionPathError(value: string): 'empty' | 'segment' | 'shallow' | undefined {
  const path = value.trim();
  if (!path) return 'empty';
  const parts = path.split('.');
  if (parts.length < 2) return 'shallow';
  if (parts.some(part => !SEGMENT.test(part))) return 'segment';
  return undefined;
}

function round(value: number): number {
  return Number(value.toFixed(DECIMALS));
}

export function pixelPointToNormalized(point: PixelPoint, width: number, height: number): NormalizedPoint | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return undefined;
  return [round(point.x / width), round(point.y / height)];
}

export function pixelRectToNormalized(rect: PixelRect, width: number, height: number): NormalizedRect | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return undefined;
  if (rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) {
    return undefined;
  }
  return [
    round(rect.x / width),
    round(rect.y / height),
    round((rect.x + rect.w) / width),
    round((rect.y + rect.h) / height),
  ];
}

export function publishPositions(
  items: readonly PositionAuthoringItem[],
  images: readonly PositionImage[],
): { file: RuntimePositionFile; errors: string[] } {
  const positions: RuntimePosition[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const imageByName = new Map(images.map(image => [image.file.toLowerCase(), image]));

  for (const item of items) {
    const path = item.path.trim();
    const pathError = positionPathError(path);
    if (pathError) { errors.push(`${pathError}:${path}`); continue; }
    if (seen.has(path)) { errors.push(`duplicate:${path}`); continue; }
    seen.add(path);

    const image = imageByName.get(item.image.toLowerCase());
    if (!image) { errors.push(`image:${path}`); continue; }

    let coordinates: NormalizedCoordinates | undefined;
    if (item.kind === 'point') {
      coordinates = item.point ? pixelPointToNormalized(item.point, image.width, image.height) : undefined;
    } else {
      coordinates = item.rect ? pixelRectToNormalized(item.rect, image.width, image.height) : undefined;
    }
    if (!coordinates) { errors.push(`geometry:${path}`); continue; }
    positions.push({ path, coordinates });
  }

  positions.sort((a, b) => a.path.localeCompare(b.path));
  return { file: { version: 2, positions }, errors };
}

export function serializePositionJson(file: RuntimePositionFile): string {
  return JSON.stringify({
    version: 2,
    positions: [...file.positions].sort((a, b) => a.path.localeCompare(b.path)),
  }, null, 2) + '\n';
}

interface PositionTreeNode {
  children: Map<string, PositionTreeNode>;
  coordinates?: NormalizedCoordinates;
}

function buildTree(positions: readonly RuntimePosition[]): PositionTreeNode {
  const root: PositionTreeNode = { children: new Map() };
  for (const position of positions) {
    let node = root;
    for (const part of position.path.split('.')) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.coordinates = position.coordinates;
  }
  return root;
}

function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('') || 'Position';
}

function pyNumber(value: number): string {
  if (Number.isInteger(value)) return value.toFixed(1);
  return String(value);
}

function classNameForPath(parts: string[]): string {
  if (parts.length === 1 && parts[0] === 'screen') return 'ScreenPosition';
  return parts.map(pascalCase).join('') + 'Position';
}

function emitClass(node: PositionTreeNode, parts: string[], out: string[], emitted: Set<string>): string {
  const className = classNameForPath(parts);
  if (emitted.has(className)) return className;

  for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (child.children.size) emitClass(child, [...parts, name], out, emitted);
  }

  emitted.add(className);
  out.push(`class ${className}:`);
  let bodyCount = 0;
  for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!child.coordinates) continue;
    out.push(`    ${name} = ScreenRatio(${child.coordinates.map(pyNumber).join(', ')})`);
    bodyCount++;
  }
  out.push('');
  out.push('    def __init__(self, parent):');
  out.push('        self._parent = parent');
  bodyCount++;
  if (!bodyCount) out.push('        pass');
  out.push('');
  out.push('');
  return className;
}

export function serializePositionMapPython(file: RuntimePositionFile): string {
  const tree = buildTree(file.positions);
  const out: string[] = [
    '# Generated by ok-script-toolkit. Do not edit manually.',
    'from .ScreenRatio import ScreenRatio',
    '',
    '',
  ];
  const emitted = new Set<string>();
  const top = [...tree.children.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, child] of top) emitClass(child, [name], out, emitted);

  out.push('class PositionMap:');
  out.push('    def __init__(self, parent):');
  if (!top.length) {
    out.push('        pass');
  } else {
    for (const [name] of top) {
      out.push(`        self.${name} = ${classNameForPath([name])}(parent)`);
    }
  }
  out.push('');
  return out.join('\n');
}

export function serializeScreenRatioPython(): string {
  return `# Generated by ok-script-toolkit. Do not edit manually.\nfrom typing import TYPE_CHECKING, Iterator\n\nif TYPE_CHECKING:\n    from ok import Box\n\n\nclass ScreenRatio:\n    \"\"\"A normalized screen point (x, y) or rectangle (left, top, right, bottom).\"\"\"\n\n    def __init__(self, *coordinates: float):\n        if len(coordinates) not in (2, 4):\n            raise ValueError(\"ScreenRatio requires either 2 point coordinates or 4 rect coordinates\")\n        self.coordinates = tuple(coordinates)\n        self.name: str | None = None\n\n    def __set_name__(self, owner: type, field_name: str):\n        self.name = f\"{owner.__name__}.{field_name}\"\n\n    def __get__(self, instance, owner):\n        if instance is None:\n            return self\n        return BoundScreenRatio(self, instance._parent)\n\n    def __iter__(self) -> Iterator[float]:\n        return iter(self.coordinates)\n\n    @property\n    def is_rect(self) -> bool:\n        return len(self.coordinates) == 4\n\n    def _to_box(self, parent) -> \"Box\":\n        if not self.is_rect:\n            raise ValueError(\"Only a rect ScreenRatio can be converted to a Box\")\n        return parent.box_of_screen(*self.coordinates, name=self.name or \"ScreenRatio\", hcenter=True)\n\n\nclass BoundScreenRatio:\n    def __init__(self, ratio: ScreenRatio, parent):\n        self.ratio = ratio\n        self.parent = parent\n\n    def __iter__(self) -> Iterator[float]:\n        return iter(self.ratio)\n\n    def to_box(self) -> \"Box\":\n        return self.ratio._to_box(self.parent)\n`;
}
