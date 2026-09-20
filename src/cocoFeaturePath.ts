/**
 * `config.py` 的 `template_matching.coco_feature_json` 的**读盘侧**（探测 + 缓存）。
 *
 * 纯逻辑在 `cocoFeaturePathPure.ts`，这里只负责"什么时候去问、问到之后放哪"。
 *
 * **为什么必须缓存**：这个值来自一次 Python 子进程调用（百毫秒级），而消费点
 * （`FeatureData.cocoFiles()`、`extension.ts` 的文件监听 glob）是**同步**的、
 * 而且每次刷新都会问一遍 —— 不可能在那里去 await 一个进程。
 * 所以探针在**激活时**与 **`config.py` 变化时**各跑一次，结果缓存在这里。
 *
 * **没探到之前一律按"没声明"处理**（退回探测两个候选 = 改动前的行为）——
 * 于是最坏情况只是"没拿到新行为"，不会坏掉；这也是它能安全地做成"纯增量"的原因。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CocoFeaturePlan,
  effectiveCocoFiles,
  resolveCocoFeaturePlan,
} from './cocoFeaturePathPure';
import { templatesCocoAnnotationsSetting } from './projectConfig';
import { getProjectConfig, probeWindowConfig } from './screenshotCapture';

/** 探到的值 + 它是为哪个项目根探的（换项目后必须重探，否则会套用上一个项目的路径）。 */
let probed: { rootDir: string; value?: string } | undefined;
/** 并发去重：激活与配置变更可能同时触发，别拉起两个 Python 进程。 */
let inFlight: Promise<void> | undefined;

/**
 * 重新探测一次。**失败静默** —— 这是纯增量信息，探不到就退回改动前的行为，
 * 不该给用户报错。
 */
export function refreshCocoFeaturePath(rootDir?: string): Promise<void> {
  if (inFlight) return inFlight;
  const dir = rootDir ?? getProjectConfig().projectDir;
  inFlight = (async () => {
    try {
      const { pythonPath } = getProjectConfig();
      const config = dir ? await probeWindowConfig(dir, pythonPath) : undefined;
      probed = { rootDir: dir, value: config?.cocoFeatureJson };
    } catch {
      probed = { rootDir: dir };
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

/** 仅供测试：清掉缓存。 */
export function clearCocoFeaturePathCache(): void {
  probed = undefined;
  inFlight = undefined;
}

/**
 * 同步取"探到的声明值"。
 *
 * 只对**同一个项目根**有效 —— 工作区切换后还没重探时返回 `undefined`（按没声明处理），
 * 否则会把上一个项目的库路径套到新项目上。
 */
export function probedCocoFeatureJson(rootDir: string): string | undefined {
  if (!rootDir || !probed || probed.rootDir !== rootDir) return undefined;
  return probed.value;
}

/**
 * 运行时模板库的候选计划（同步）。
 *
 * 取值链：**项目约定文件 `templates.cocoAnnotations` > `config.py` 的
 * `template_matching.coco_feature_json` > 依次探测两个候选（改动前的行为）**。
 */
export function cocoFeaturePlan(rootDir: string): CocoFeaturePlan {
  if (!rootDir) return resolveCocoFeaturePlan(rootDir);
  return resolveCocoFeaturePlan(
    rootDir,
    templatesCocoAnnotationsSetting(rootDir),
    probedCocoFeatureJson(rootDir),
  );
}

/** 运行时模板库实际要扫描的文件（同步，已按存在性过滤）。 */
export function cocoFeatureFiles(rootDir: string): string[] {
  if (!rootDir) return [];
  return effectiveCocoFiles(cocoFeaturePlan(rootDir), (file) => fs.existsSync(file));
}

/**
 * 运行时模板库的**所有**候选相对路径（相对项目根、`/` 分隔），含首选与探测候选。
 *
 * 两个消费点都用它：
 * - 文件监听 glob —— **不按存在性过滤**，监听要覆盖"文件还没创建"的情况，
 *   否则第一次生成库时不会触发刷新；
 * - 变更归属判定（`extension.ts` 的 `getAffectedSources`）—— 同样要覆盖尚未存在的那条。
 *
 * 与 [cocoFeatureFiles] 的区别就是"存不存在"这件事。
 */
export function cocoFeatureRelPaths(rootDir: string): string[] {
  if (!rootDir) return [];
  const plan = cocoFeaturePlan(rootDir);
  const all = plan.preferred ? [plan.preferred, ...plan.probeCandidates] : plan.probeCandidates;
  return [...new Set(all)]
    .map((abs) => path.relative(rootDir, abs).replace(/\\/g, '/'))
    .filter((rel) => rel.length > 0 && !rel.startsWith('..'));
}
