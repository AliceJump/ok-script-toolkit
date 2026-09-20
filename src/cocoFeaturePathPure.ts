/**
 * **运行时模板库**（`coco_annotations.json`）的路径解析。
 *
 * ⚠️ 别和素材面板自己维护的 `<模板目录>/coco_annotations.json` 搞混 —— 那是**两个文件**：
 *
 * | 文件 | 是什么 | 谁读写 |
 * |---|---|---|
 * | `assets/coco_annotations.json`（或 config.py 指定的别处） | ok 框架加载的**运行时模板库** | 本模块；`featureData` 读、`extension.ts` 监听 |
 * | `<模板目录>/coco_annotations.json` | 素材面板自己的标注工作文件 | `templateAssetData` 读写，路径由 `templates.directory` 派生 |
 *
 * ok 框架读的是前者：`ok/__init__.py` 里
 * `self.config.get('template_matching').get('coco_feature_json')`。
 *
 * 取值链（高 → 低）：
 *
 * 1. 项目约定文件 `templates.cocoAnnotations`
 * 2. 项目 `config.py` 的 `template_matching.coco_feature_json`
 * 3. 依次探测 `assets/coco_annotations.json`、`ok_tasks/assets/coco_annotations.json`
 *
 * 第 ③ 层就是**改动前的硬编码行为**，也是这里的兜底 —— 所以声明缺席时行为与今天完全一致。
 * 这不是形式主义：实测 6 个 ok 系项目**全都**声明了它，其中 **ok-infinity-nikki 声明的是
 * `assets/coco_detection.json`** —— 旧代码在它那儿一个候选都探不到，模板库直接是空的。
 *
 * 与 JetBrains 侧 `core/CocoFeaturePath.kt` 一一对应。
 */
import * as path from 'path';
import { nonEmpty } from './projectConfigPure';

/** 首选文件来自哪一层。 */
export type CocoFeatureLayer = 'convention' | 'configPy' | 'probe';

/**
 * 第 ③ 层的探测候选（相对项目根，`/` 分隔）。
 *
 * `assets/` 是 ok-script 标准位置；`ok_tasks/assets/` 是"自定义脚本"位置
 * （`saveToAssets` 的两个导出目标就是这两处）。
 */
export const PROBE_COCO_CANDIDATES = [
  'assets/coco_annotations.json',
  'ok_tasks/assets/coco_annotations.json',
];

export interface CocoFeaturePlan {
  /** 首选文件（绝对路径）。`undefined` = 没有任何声明，直接用 [probeCandidates] */
  preferred?: string;
  /** 首选不可用（或压根没声明）时按顺序探测的候选（绝对路径） */
  probeCandidates: string[];
  /** 首选来自哪一层 */
  layer: CocoFeatureLayer;
}

/** 声明值可能是相对项目根的，也可能是绝对路径 —— 两种都要认。 */
function toAbsolute(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

/**
 * 解析出候选计划（纯函数，不碰文件系统）。
 *
 * @param rootDir 项目根
 * @param declared 项目约定文件 `templates.cocoAnnotations`（相对项目根，已归一化）
 * @param fromConfigPy `config.py` 的 `template_matching.coco_feature_json`（原样，未归一化）
 */
export function resolveCocoFeaturePlan(
  rootDir: string,
  declared?: string,
  fromConfigPy?: string,
): CocoFeaturePlan {
  const probeCandidates = PROBE_COCO_CANDIDATES.map((rel) => path.join(rootDir, rel));

  const declaredPath = nonEmpty(declared);
  if (declaredPath) {
    return { preferred: toAbsolute(rootDir, declaredPath), probeCandidates, layer: 'convention' };
  }

  // `config.py` 的值是**项目自己的真话**，但它可能是 `os.path.join(...)` 拼出来的，
  // 也可能是尚未生成的文件 —— 所以原样用，不做归一化（归一化会把绝对路径的开头斜杠吃掉）。
  const fromPy = nonEmpty(fromConfigPy);
  if (fromPy) {
    return { preferred: toAbsolute(rootDir, fromPy), probeCandidates, layer: 'configPy' };
  }

  return { probeCandidates, layer: 'probe' };
}

/**
 * 实际要扫描的文件列表。
 *
 * ⚠️ **首选可用时只用首选**，不把探测候选也带上 —— 否则项目把库搬到别处之后，
 * 旧位置的库会和新库一起被加载，同一个 feature 名出现两份（先到的那份胜出，静默）。
 *
 * 首选**不可用**时退回探测候选：`config.py` 里声明的文件可能还没生成
 * （项目尚未标注过），此时"按惯例找一找"比"什么都不加载"有用得多，
 * 也正是"默认值为现值"。
 *
 * `exists` 由调用方注入，保持本模块可测（不碰真实文件系统）。
 */
export function effectiveCocoFiles(plan: CocoFeaturePlan, exists: (file: string) => boolean): string[] {
  if (plan.preferred && exists(plan.preferred)) return [plan.preferred];
  return plan.probeCandidates.filter(exists);
}
