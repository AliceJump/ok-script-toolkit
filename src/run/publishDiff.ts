/**
 * Draft (authoring / ok_templates) vs published (runtime COCO / features) comparison.
 * Pure: no vscode. Used for status dots and "N unpublished" badges.
 */
export type PublishStatus = 'draft-only' | 'modified' | 'published' | 'orphan-published';

export interface PublishItem {
  name: string;
  /** Draft bbox or size fingerprint when available */
  draftFingerprint?: string;
  publishedFingerprint?: string;
}

export interface PublishDiff {
  name: string;
  status: PublishStatus;
}

export function fingerprintBox(box: { bbox?: number[]; width?: number; height?: number }): string {
  if (box.bbox && box.bbox.length >= 4) {
    return box.bbox.map((n) => Math.round(Number(n))).join(',');
  }
  return `${Math.round(Number(box.width) || 0)}x${Math.round(Number(box.height) || 0)}`;
}

/** Compare draft names/fingerprints to published ones. */
export function diffPublishSets(draft: PublishItem[], published: PublishItem[]): PublishDiff[] {
  const pub = new Map(published.map((p) => [p.name, p]));
  const seen = new Set<string>();
  const out: PublishDiff[] = [];
  for (const d of draft) {
    seen.add(d.name);
    const p = pub.get(d.name);
    if (!p) {
      out.push({ name: d.name, status: 'draft-only' });
      continue;
    }
    if (
      d.draftFingerprint != null
      && p.publishedFingerprint != null
      && d.draftFingerprint !== p.publishedFingerprint
    ) {
      out.push({ name: d.name, status: 'modified' });
    } else {
      out.push({ name: d.name, status: 'published' });
    }
  }
  for (const p of published) {
    if (seen.has(p.name)) continue;
    out.push({ name: p.name, status: 'orphan-published' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function countUnpublished(diffs: PublishDiff[]): number {
  return diffs.filter((d) => d.status === 'draft-only' || d.status === 'modified').length;
}
