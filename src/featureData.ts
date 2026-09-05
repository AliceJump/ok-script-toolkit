import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** COCO 中一个 feature 模板条目：来源原图 + 裁剪框 */
export interface FeatureTemplate {
  name: string;
  imagePath: string; // 原图绝对路径
  bbox: [number, number, number, number]; // [x, y, w, h]
  width: number;
  height: number;
}

/**
 * 访问器侧刷新的最小扫描间隔（ms）。
 * 补全/hover 会对每个模板名各调一次 entry()，不节流时每次按键产生
 * 上千次 existsSync/statSync；文件变化由 watcher 的 force 刷新保证。
 */
const ACCESSOR_SCAN_INTERVAL_MS = 300;

/** 解析 assets/coco_annotations.json（COCO 格式）为 feature -> 模板映射 */
export class FeatureData {
  private rootDir: string;
  private cache = new Map<string, FeatureTemplate>();
  private cocoMtimes = new Map<string, number>();
  private lastScanMs = 0;

  constructor(root: vscode.WorkspaceFolder | string | undefined) {
    this.rootDir = typeof root === 'string' ? root : root ? root.uri.fsPath : '';
  }

  /** 需要扫描的 coco 标注文件列表（主库 + 可选的 ok_tasks 扩展库） */
  private cocoFiles(): string[] {
    const list = [path.join(this.rootDir, 'assets', 'coco_annotations.json')];
    const okTasks = path.join(this.rootDir, 'ok_tasks', 'assets', 'coco_annotations.json');
    if (fs.existsSync(okTasks)) list.push(okTasks);
    return list;
  }

  refresh(force = false): void {
    if (!this.rootDir) return;
    const now = Date.now();
    if (!force && now - this.lastScanMs < ACCESSOR_SCAN_INTERVAL_MS) return;
    this.lastScanMs = now;
    if (force) {
      this.cache.clear();
      this.cocoMtimes.clear();
    }
    for (const cocoPath of this.cocoFiles()) {
      if (!fs.existsSync(cocoPath)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(cocoPath).mtimeMs;
      } catch {
        continue;
      }
      if (!force && this.cocoMtimes.get(cocoPath) === mtime) continue;
      this.cocoMtimes.set(cocoPath, mtime);
      try {
        const data = JSON.parse(fs.readFileSync(cocoPath, 'utf-8'));
        this.loadCoco(cocoPath, data);
      } catch {
        // 跳过坏文件
      }
    }
  }

  private loadCoco(cocoPath: string, data: any): void {
    if (!data || typeof data !== 'object') return;
    const cocoFolder = path.dirname(cocoPath);
    const imageMap = new Map<number, string>();
    for (const img of data['images'] ?? []) {
      if (img && typeof img.id === 'number' && typeof img.file_name === 'string') {
        imageMap.set(img.id, path.join(cocoFolder, img.file_name));
      }
    }
    const categoryMap = new Map<number, string>();
    for (const cat of data['categories'] ?? []) {
      if (cat && typeof cat.id === 'number' && typeof cat.name === 'string') {
        categoryMap.set(cat.id, cat.name);
      }
    }
    for (const ann of data['annotations'] ?? []) {
      const name = categoryMap.get(ann?.category_id);
      const imagePath = imageMap.get(ann?.image_id);
      if (!name || !imagePath || !Array.isArray(ann?.bbox) || ann.bbox.length < 4) continue;
      const [x, y, w, h] = ann.bbox.map((n: number) => Math.round(n));
      if (w <= 0 || h <= 0) continue;
      this.cache.set(name, {
        name,
        imagePath,
        bbox: [x, y, w, h],
        width: w,
        height: h,
      });
    }
  }

  names(): string[] {
    this.refresh();
    return [...this.cache.keys()].sort();
  }

  entry(name: string): FeatureTemplate | undefined {
    this.refresh();
    return this.cache.get(name);
  }

  /** 返回全部模板（供后台预热裁剪缓存） */
  all(): FeatureTemplate[] {
    this.refresh();
    return [...this.cache.values()];
  }

  /** 工作区根目录（供原图映射等使用） */
  get root(): string {
    return this.rootDir;
  }
}

/* ---------------- ok_templates/coco_annotations.json 反查（原图 + 标注） ---------------- */

export interface OkTemplateCocoEntry {
  imagePath: string; // ok_templates 下的原图绝对路径
  bbox: [number, number, number, number]; // [x, y, w, h] — ok_templates COCO 中的标注坐标
}

const okTplCocoIndexes = new Map<string, okTplCocoIndexData>();
const OK_TPL_COCO_TTL_MS = 30_000;

interface okTplCocoIndexData {
  builtAt: number;
  byName: Map<string, OkTemplateCocoEntry>;
}

/**
 * 读取 ok_templates/coco_annotations.json，按模板名反查原图路径 + bbox。
 * 同时扫描 ok_tasks/ok_templates/coco_annotations.json（扩展库）。
 * 结果按 TTL 缓存过期，避免标注修改后一直用旧索引。
 */
function getOkTemplateCocoIndex(rootDir: string): Map<string, OkTemplateCocoEntry> {
  const hit = okTplCocoIndexes.get(rootDir);
  if (hit && Date.now() - hit.builtAt < OK_TPL_COCO_TTL_MS) return hit.byName;
  if (hit) okTplCocoIndexes.delete(rootDir);

  const byName = new Map<string, OkTemplateCocoEntry>();
  const dirs = [
    path.join(rootDir, 'ok_templates'),
    path.join(rootDir, 'ok_tasks', 'ok_templates'),
  ];
  for (const dir of dirs) {
    const cocoPath = path.join(dir, 'coco_annotations.json');
    try {
      if (!fs.existsSync(cocoPath)) continue;
      const data = JSON.parse(fs.readFileSync(cocoPath, 'utf-8'));
      if (!data || typeof data !== 'object') continue;

      const imageMap = new Map<number, string>();
      for (const img of data['images'] ?? []) {
        if (img && typeof img.id === 'number' && typeof img.file_name === 'string') {
          imageMap.set(img.id, path.join(dir, img.file_name));
        }
      }
      const categoryMap = new Map<number, string>();
      for (const cat of data['categories'] ?? []) {
        if (cat && typeof cat.id === 'number' && typeof cat.name === 'string') {
          categoryMap.set(cat.id, cat.name);
        }
      }
      for (const ann of data['annotations'] ?? []) {
        const name = categoryMap.get(ann?.category_id);
        const imagePath = imageMap.get(ann?.image_id);
        if (!name || !imagePath || !Array.isArray(ann?.bbox) || ann.bbox.length < 4) continue;
        const [x, y, w, h] = ann.bbox.map((n: number) => Math.round(n));
        if (w <= 0 || h <= 0) continue;
        if (!byName.has(name)) {
          byName.set(name, { imagePath, bbox: [x, y, w, h] });
        }
      }
    } catch {
      // 坏文件跳过
    }
  }
  okTplCocoIndexes.set(rootDir, { builtAt: Date.now(), byName });
  return byName;
}

/**
 * 按模板名从 ok_templates/coco_annotations.json 反查原图路径和标注 bbox。
 * 返回 undefined 表示该模板在 ok_templates 中没有对应标注。
 */
export function findOkTemplateCocoEntry(
  rootDir: string,
  name: string,
): OkTemplateCocoEntry | undefined {
  if (!rootDir) return undefined;
  return getOkTemplateCocoIndex(rootDir).get(name);
}
