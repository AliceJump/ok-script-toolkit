/**
 * 生成枚举文件前的**类名变更校验**：把"个人覆盖把项目 import 弄坏"挡在写入之前。
 *
 * 背景（`docs/project-config.md` §3）：`labelEnum.name` 与 `labelEnum.path` 现在都有
 * "个人偏好"层，而这一项比其它设置危险 —— 它**决定写进源码的类名**，项目的代码是按
 * 名字 import 的：
 *
 * ```python
 * from src.data.feature_list import FeatureList      # 项目里有 10 处这么写
 * ```
 *
 * 于是"我在设置里把类名改成 `MyEnum`"的后果不是"我这边看着不一样"，而是
 * **整个项目 `ImportError`**。而这个动作在界面上没有任何反馈 —— 保存成功的提示
 * 照样弹出来，坏掉的是下次运行脚本的时候。
 *
 * 这里不试图阻止用户改（那是他的自由），只做一件事：**覆盖一个已存在的枚举文件、
 * 且类名会变**时，先算清楚影响面、问一句。
 *
 * **为什么只校验类名、不校验路径**：换路径时旧文件原样留着，按旧模块路径 import 的
 * 代码仍然 import 得到（只是拿不到新标签），不会报错；而改类名是**同一个文件里名字变了**，
 * 引用方当场全废。两者的后果不对称，所以只给前者加闸。
 *
 * **刻意不 import `vscode`** —— 判据全是字符串处理（与 `projectConfigPure.ts` /
 * `saveToAssetsPure.ts` 同一个理由），由 `scripts/test_label_enum_guard.js` 直接断言。
 * 扫项目文件那步是 IO，留在 `templateAssetPanel.ts`（它是编排层），本模块只提供
 * 从"一堆源码"里挑出引用方的纯函数。
 */

/** 类名非法时退回的默认名（与子仓同值）。 */
export const FALLBACK_ENUM_CLASS_NAME = 'LabelEnum';

/** Python 3 的硬关键字；match/case/type 是软关键字，仍可作类名或成员名。 */
export const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/**
 * **真正会写进源码的类名**：非法标识符或 Python 关键字退回 [FALLBACK_ENUM_CLASS_NAME]。
 *
 * 与 `TemplateAssetData.generateLabelEnum` **共用**这一个函数。各写一遍的后果是
 * 校验拿"用户填的名字"去比、而文件里写的是"兜底名字"，于是警告内容与实际不符 ——
 * 比如用户把类名填成 `2Bad`，面板会报"要从 `LabelEnum` 改名为 `2Bad`"，
 * 而实际写进去的还是 `LabelEnum`，什么都没变。**一句不成立的警告比没有警告更糟**。
 */
export function writableClassName(raw: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && !PYTHON_KEYWORDS.has(raw)
    ? raw
    : FALLBACK_ENUM_CLASS_NAME;
}

/** 覆盖已有枚举文件时的"改名影响面"。 */
export interface LabelEnumRenameImpact {
  /** 目标文件里**现有**的类名（旧名字） */
  existingClassName: string;
  /** 这次要写入的类名（新名字） */
  newClassName: string;
}

/**
 * 从 Python 源码里取第一个 `class X(...)` 的类名。
 *
 * 只看行首（允许缩进）的 `class`，避免匹配到字符串字面量或注释里的 `class ` ——
 * 生成出来的枚举文件是 `class FeatureList(str, Enum):` 顶格一行，够用。
 */
export function extractClassName(source: string): string | undefined {
  const match = /^[ \t]*class[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m.exec(source);
  return match ? match[1] : undefined;
}

/**
 * 这段源码是否**按名字 import** 了 [name]。
 *
 * 覆盖 `from a.b import X`、`from a.b import (A, X)`、`from a.b import X as fL`、
 * `import a.b.X` 这几种写法 —— 判据是"同一行里既有 `import` 又有这个名字"。
 *
 * 宁可多报不可漏报：这里产出的是**给用户看的提示**，不是自动决策。误报的代价是
 * 多问一句（用户点"继续"即可），漏报的代价是项目静默 import 失败。
 * 唯一的例外是 `from a.b import *`（连名字都没写），那种确实查不出来 —— 也没法查。
 */
export function importsName(source: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `[^\n]*` 只吃同一行，所以跨行的 `class X:` 之类不会误命中
  return new RegExp(`(^|[^\\w.])import[ \\t][^\\n]*\\b${escaped}\\b`).test(source);
}

/**
 * 要不要就"类名变了"问一句。返回 `undefined` = **不必问**。
 *
 * 两种**不必问**的情形（常规操作，打扰用户就是噪音）：
 *
 * 1. **目标文件不存在** —— 全新生成，没有"旧名字"可废；
 * 2. **新旧类名相同** —— 常规的"重新生成一遍"，每次保存都会发生。
 *
 * 一种**必须问**的情形：目标文件存在、内容也会被覆盖，但新旧类名不同 —— 此时按旧类名
 * import 的代码会全部失效。这包括"文件在、却读不出类名"（`existingClassName` 为 `''`）：
 * 用户很可能把路径填到了一个**普通模块**上，覆盖它会直接删掉那个文件里的东西。
 */
export function labelEnumRenameImpact(args: {
  /** 目标文件**当前**的内容；文件不存在传 `undefined` */
  existingSource: string | undefined;
  /** 这次要写入的类名 */
  newClassName: string;
}): LabelEnumRenameImpact | undefined {
  if (args.existingSource === undefined) return undefined;
  const existingClassName = extractClassName(args.existingSource) ?? '';
  if (existingClassName === args.newClassName) return undefined;
  return { existingClassName, newClassName: args.newClassName };
}

/**
 * 从「文件相对路径 + 源码」里挑出按 [name] import 的那些路径（**全部**，已排序）。
 *
 * 返回全部而不是截断后的前几个：调用方要分别拿到"会炸多少处"（总数）和
 * "前几个是谁"（展示用），截断放在调用方做。
 *
 * @param files 已经读进来的源码（IO 由调用方做 —— 本模块不碰文件系统）
 * @param name 旧类名；空串（读不出旧名字）时**返回空数组**：
 *   那种情况下"谁引用了它"没有意义，提示文案会换成"文件内容会被覆盖"。
 */
export function referencingFiles(
  files: Array<{ path: string; source: string }>,
  name: string,
): string[] {
  if (!name) return [];
  return files.filter((f) => importsName(f.source, name)).map((f) => f.path).sort();
}

/**
 * 拼给用户看的那句话。`tr` 由调用方传入（本模块不依赖 i18n，与 `saveToAssetsPure` 同做法）。
 *
 * `referencingFiles` 是命中的**全部**文件；文案里只列前 [maxListed] 个，
 * 但**总数照实报** —— 用户要的是"会炸多少处"，不是"前 5 个是谁"。
 */
export function labelEnumRenameMessage(
  impact: LabelEnumRenameImpact,
  referencingFiles: string[],
  tr: (key: string, args?: Record<string, string | number | boolean>) => string,
  maxListed = 5,
): string {
  const target = impact.existingClassName
    ? tr('The target file currently defines class {old}.', { old: impact.existingClassName })
    : tr('The target file already exists but its class name could not be recognized.');
  const rename = impact.existingClassName
    ? tr('This save will rename it to {new}.', { new: impact.newClassName })
    : tr('This save will write class {new}.', { new: impact.newClassName });
  const refs =
    referencingFiles.length > 0
      ? tr('{count} file(s) still import {old} and will break: {files}', {
          count: referencingFiles.length,
          old: impact.existingClassName,
          files: referencingFiles.slice(0, Math.max(0, maxListed)).join(', '),
        })
      : '';
  return [target, rename, refs].filter((part) => part.length > 0).join(' ');
}
