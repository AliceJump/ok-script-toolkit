export type AnnotationMergeMode = 'template' | 'rect' | 'point';

export interface MergeAnnotation {
  id: number;
  category: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationConflictKind = 'modify-modify' | 'delete-modify' | 'add-add';

export interface AnnotationConflict {
  key: string;
  kind: AnnotationConflictKind;
  fields: Array<'category' | 'x' | 'y' | 'w' | 'h'>;
  base?: MergeAnnotation;
  local?: MergeAnnotation;
  external?: MergeAnnotation;
  mergedIndex?: number;
}

export interface AnnotationMergeResult {
  merged: MergeAnnotation[];
  conflicts: AnnotationConflict[];
}

const FIELDS: Array<'category' | 'x' | 'y' | 'w' | 'h'> = ['category', 'x', 'y', 'w', 'h'];

function cloneAnnotation(value: MergeAnnotation | undefined): MergeAnnotation | undefined {
  return value ? { ...value } : undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b;
}

function sameAnnotation(a: MergeAnnotation | undefined, b: MergeAnnotation | undefined): boolean {
  if (!a || !b) return a === b;
  return FIELDS.every(field => sameValue(a[field], b[field]));
}

function categoryKey(value: MergeAnnotation): string {
  return value.category.trim();
}

function geometryEqual(a: MergeAnnotation, b: MergeAnnotation): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function findMatch(
  base: MergeAnnotation,
  candidates: readonly MergeAnnotation[],
  used: Set<number>,
  mode: AnnotationMergeMode,
): number {
  const available = (predicate: (candidate: MergeAnnotation) => boolean): number => {
    for (let index = 0; index < candidates.length; index++) {
      if (!used.has(index) && predicate(candidates[index])) return index;
    }
    return -1;
  };

  if (mode === 'template') {
    const byId = available(candidate => candidate.id === base.id);
    if (byId >= 0) return byId;
  }

  const key = categoryKey(base);
  const byCategory = available(candidate => categoryKey(candidate) === key);
  if (byCategory >= 0) return byCategory;

  if (mode === 'template') {
    const byGeometry = available(candidate => geometryEqual(candidate, base));
    if (byGeometry >= 0) return byGeometry;
  }

  return -1;
}

function mergeExisting(
  key: string,
  base: MergeAnnotation,
  local: MergeAnnotation | undefined,
  external: MergeAnnotation | undefined,
): { annotation?: MergeAnnotation; conflict?: AnnotationConflict } {
  if (!local && !external) return {};
  if (!local) {
    if (sameAnnotation(base, external)) return {};
    return {
      conflict: {
        key,
        kind: 'delete-modify',
        fields: FIELDS.filter(field => external && !sameValue(base[field], external[field])),
        base: cloneAnnotation(base),
        external: cloneAnnotation(external),
      },
    };
  }
  if (!external) {
    if (sameAnnotation(base, local)) return {};
    return {
      annotation: cloneAnnotation(local),
      conflict: {
        key,
        kind: 'delete-modify',
        fields: FIELDS.filter(field => !sameValue(base[field], local[field])),
        base: cloneAnnotation(base),
        local: cloneAnnotation(local),
      },
    };
  }

  if (sameAnnotation(local, external)) return { annotation: cloneAnnotation(local) };
  if (sameAnnotation(base, local)) return { annotation: cloneAnnotation(external) };
  if (sameAnnotation(base, external)) return { annotation: cloneAnnotation(local) };

  const merged: MergeAnnotation = { ...local };
  const conflicts: AnnotationConflict['fields'] = [];
  for (const field of FIELDS) {
    const baseValue = base[field];
    const localValue = local[field];
    const externalValue = external[field];
    if (sameValue(localValue, externalValue)) merged[field] = localValue as never;
    else if (sameValue(localValue, baseValue)) merged[field] = externalValue as never;
    else if (sameValue(externalValue, baseValue)) merged[field] = localValue as never;
    else conflicts.push(field);
  }

  return conflicts.length
    ? {
      annotation: merged,
      conflict: {
        key,
        kind: 'modify-modify',
        fields: conflicts,
        base: cloneAnnotation(base),
        local: cloneAnnotation(local),
        external: cloneAnnotation(external),
      },
    }
    : { annotation: merged };
}

function additionMatch(
  value: MergeAnnotation,
  candidates: readonly MergeAnnotation[],
  used: Set<number>,
  mode: AnnotationMergeMode,
): number {
  for (let index = 0; index < candidates.length; index++) {
    if (used.has(index)) continue;
    const candidate = candidates[index];
    if (categoryKey(candidate) === categoryKey(value)) return index;
  }
  if (mode === 'template') {
    for (let index = 0; index < candidates.length; index++) {
      if (used.has(index)) continue;
      const candidate = candidates[index];
      if (candidate.id === value.id || geometryEqual(candidate, value)) return index;
    }
  }
  return -1;
}

/**
 * Locate the exact merge-owned slot represented by one conflict.
 * The merge phase records this identity before branch-local ids can collide.
 */
export function findAnnotationConflictItemIndex(
  _mode: AnnotationMergeMode,
  annotations: readonly MergeAnnotation[],
  conflict: AnnotationConflict,
): number {
  const index = conflict.mergedIndex;
  return index !== undefined && index >= 0 && index < annotations.length ? index : -1;
}

/**
 * Three-way merge for one image and one annotation mode.
 *
 * `base` is the last canonical snapshot shown by the editor, `local` is the
 * current in-editor state, and `external` is the newest valid on-disk state.
 * Non-overlapping edits are merged automatically. True collisions are returned
 * separately and the merged list deliberately prefers the local candidate for
 * conflicting fields so callers can keep editing without losing either side.
 */
export function mergeAnnotations(
  mode: AnnotationMergeMode,
  base: readonly MergeAnnotation[],
  local: readonly MergeAnnotation[],
  external: readonly MergeAnnotation[],
): AnnotationMergeResult {
  const merged: MergeAnnotation[] = [];
  const conflicts: AnnotationConflict[] = [];
  const usedLocal = new Set<number>();
  const usedExternal = new Set<number>();

  for (const baseItem of base) {
    const localIndex = findMatch(baseItem, local, usedLocal, mode);
    const externalIndex = findMatch(baseItem, external, usedExternal, mode);
    if (localIndex >= 0) usedLocal.add(localIndex);
    if (externalIndex >= 0) usedExternal.add(externalIndex);
    const localItem = localIndex >= 0 ? local[localIndex] : undefined;
    const externalItem = externalIndex >= 0 ? external[externalIndex] : undefined;
    const result = mergeExisting(
      mode === 'template' ? `template:${baseItem.id}:${baseItem.category}` : `${mode}:${categoryKey(baseItem)}`,
      baseItem,
      localItem,
      externalItem,
    );
    let mergedIndex: number | undefined;
    if (result.annotation) {
      merged.push(result.annotation);
      mergedIndex = merged.length - 1;
    }
    if (result.conflict) conflicts.push({ ...result.conflict, mergedIndex });
  }

  for (let localIndex = 0; localIndex < local.length; localIndex++) {
    if (usedLocal.has(localIndex)) continue;
    const localItem = local[localIndex];
    const externalIndex = additionMatch(localItem, external, usedExternal, mode);
    if (externalIndex < 0) {
      merged.push({ ...localItem });
      continue;
    }
    usedExternal.add(externalIndex);
    const externalItem = external[externalIndex];
    if (sameAnnotation(localItem, externalItem)) {
      merged.push({ ...localItem });
      continue;
    }
    merged.push({ ...localItem });
    conflicts.push({
      key: mode === 'template'
        ? `template:new:${localIndex}:${categoryKey(localItem)}`
        : `${mode}:${categoryKey(localItem)}`,
      kind: 'add-add',
      fields: FIELDS.filter(field => !sameValue(localItem[field], externalItem[field])),
      local: cloneAnnotation(localItem),
      external: cloneAnnotation(externalItem),
      mergedIndex: merged.length - 1,
    });
  }

  for (let externalIndex = 0; externalIndex < external.length; externalIndex++) {
    if (!usedExternal.has(externalIndex)) merged.push({ ...external[externalIndex] });
  }

  conflicts.sort((a, b) => (b.mergedIndex ?? -1) - (a.mergedIndex ?? -1));
  return { merged, conflicts };
}
