/**
 * 发布预览（纯函数）：在真正写盘前列出「会写哪些文件、模板集合怎么变」。
 *
 * 只读、只比较名字：发布会把草稿裁切 + 装箱成新的运行时 COCO（saveToAssets 整体替换），
 * 草稿与已发布的 bbox 坐标系不同，比较坐标会把所有模板误报成「已修改」，所以这里不做。
 */
export interface PublishPreviewInput {
  template?: {
    targetLabel: string;
    enumPath?: string;
    draftNames: string[];
    publishedNames: string[];
  };
  position?: {
    format: 'json' | 'python';
    files: string[];
    rect: boolean;
    point: boolean;
  };
}

export type PreviewRowKind = 'file' | 'add' | 'keep' | 'remove';

export interface PreviewRow {
  kind: PreviewRowKind;
  label: string;
}

export interface PublishPreview {
  files: PreviewRow[];
  templates: PreviewRow[];
  counts: { add: number; keep: number; remove: number };
}

export function buildPublishPreview(input: PublishPreviewInput): PublishPreview {
  const files: PreviewRow[] = [];
  const templates: PreviewRow[] = [];
  const counts = { add: 0, keep: 0, remove: 0 };
  if (input.template) {
    const t = input.template;
    const target = t.targetLabel.replace(/[\\/]+$/, '');
    files.push({ kind: 'file', label: `${target}/coco_annotations.json` });
    files.push({ kind: 'file', label: `${target}/images/` });
    if (t.enumPath) files.push({ kind: 'file', label: t.enumPath });
    const draft = [...new Set(t.draftNames)].sort((a, b) => a.localeCompare(b));
    const published = new Set(t.publishedNames);
    const draftSet = new Set(draft);
    for (const name of draft) {
      const kind: PreviewRowKind = published.has(name) ? 'keep' : 'add';
      counts[kind] += 1;
      templates.push({ kind, label: name });
    }
    for (const name of [...published].sort((a, b) => a.localeCompare(b))) {
      if (draftSet.has(name)) continue;
      counts.remove += 1;
      templates.push({ kind: 'remove', label: name });
    }
  }
  if (input.position) {
    for (const f of input.position.files) files.push({ kind: 'file', label: f });
  }
  return { files, templates, counts };
}
