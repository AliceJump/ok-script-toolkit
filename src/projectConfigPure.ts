/**
 * 项目约定文件里「纯数据」的那部分：解析、校验、取值链。
 *
 * **刻意不 import `vscode`** —— 本仓库的既有约定是"不依赖 IDE 的逻辑抽成纯对象配单测"
 * （见 ProjectDirResolution / TaskConfigMerge / TaskParamWhitelist 等）。
 * 读盘与工作区解析留在 `projectConfig.ts`，这里只做可以脱离 IDE 断言的事。
 *
 * 取值链统一为（高 → 低）：
 *   个人偏好（调用方传入的 IDE 设置值）> 项目约定文件 > 调用方给的兜底
 */

export interface ProjectLabelEnum {
  /** 枚举文件路径，相对项目根，不带 .py */
  path?: string;
  /** 枚举类名。缺席时调用方退回 path 的 basename */
  name?: string;
  /** 代码里引用该枚举的别名，如 fL */
  aliases?: string[];
}

export interface ProjectTemplates {
  /** 模板目录（png 切图 + coco_annotations.json），相对项目根 */
  directory?: string;
  /** COCO 标注文件路径，相对项目根 */
  cocoAnnotations?: string;
}

export interface ProjectConfig {
  labelEnum?: ProjectLabelEnum;
  executor?: {
    startupHooks?: {
      beforeConfigImport?: string[];
      afterConfigImport?: string[];
    };
  };
  templates?: ProjectTemplates;
  i18n?: {
    enabled?: boolean;
    langDirectory?: string;
    poDirectory?: string;
    poDomains?: string[];
  };
  characters?: {
    projectPath?: string;
    masterFile?: string;
    skillsDirectory?: string;
    localeFile?: string;
    avatarTemplateRegex?: string;
  };
  effects?: { file?: string };
}

/** 非空字符串取值：声明文件里写了空串等同于没写。 */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 非空字符串数组：过滤掉非字符串与空串；全空则返回空数组（表示"没声明"）。 */
export function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => nonEmpty(item) !== undefined).map((item) => item.trim());
}

/**
 * 相对路径归一化：统一成 `/` 分隔、去掉首尾斜杠；空（或只有斜杠）→ `undefined`。
 *
 * 为什么需要它：这个值会被**三种方式**消费 —— `path.join` 拼绝对路径、
 * `rel.startsWith(...)` 比较、以及**拼进 glob / 正则**（`extension.ts` 的文件监听）。
 * 声明文件里写 `ok_templates\` 或 `./ok_templates` 时，后两种都会失配，
 * 且失配是**静默**的（监听不触发，界面看着正常）。所以入口处统一归一化一次。
 */
export function normalizeRelPath(value: unknown): string | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 取值链命中的那一层。 */
export type SettingLayer = 'personal' | 'project' | 'builtin';

export interface ResolvedSetting<T> {
  value: T;
  layer: SettingLayer;
}

/**
 * 通用取值链：**个人偏好 > 项目约定文件 > 内置默认**，并**同时给出命中的层**。
 *
 * ⚠️ **"来源层"必须由这条链自己产出，不要在别处另写一套判断去复算。**
 * 复算出来的层与实际生效值迟早会分叉 —— 而分叉的表现是"界面说来源是项目约定、
 * 实际生效的却是我的设置"，属于最难查的那类不一致。
 * 溯源界面（`conventionSources`）直接消费这里的 `layer`，所以它永远和生效值一致。
 *
 * 调用方负责把"没设置过"归一成 `undefined`（见 `projectConfig.ideSetting()` ——
 * 本仓库设置项几乎都带非空默认值，`get()` 拿到的值不能直接当"用户设过"）。
 */
export function resolveSetting<T>(
  ideValue: T | undefined,
  declared: T | undefined,
  fallback: T,
): ResolvedSetting<T> {
  if (ideValue !== undefined) return { value: ideValue, layer: 'personal' };
  if (declared !== undefined) return { value: declared, layer: 'project' };
  return { value: fallback, layer: 'builtin' };
}

/**
 * 把任意 JSON 值规整成 ProjectConfig。
 *
 * 顶层不是对象 → 空配置。**不做逐字段深校验**：声明文件是手写的，各访问器
 * 自己按需 `nonEmpty` / 类型判断即可；这里只保证"拿到的一定是对象"。
 */
export function parseProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as ProjectConfig;
}

/** `labelEnum` 一组（保证是对象）。 */
export function labelEnumOf(config: ProjectConfig): ProjectLabelEnum {
  const value = config.labelEnum;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** `templates` 一组（保证是对象）。 */
export function templatesOf(config: ProjectConfig): ProjectTemplates {
  const value = config.templates;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 模板目录名（相对项目根），已归一化。**带来源层**。
 *
 * 取值链：**个人偏好（IDE 设置）> 项目约定文件 `templates.directory` > 内置默认**。
 *
 * ⚠️ `ideValue` 必须传"用户真正设置过的值"，不能传带默认值的读取结果 ——
 * `package.json` 里 `okTemplatesDirectory` 的 `default` 就是 `ok_templates`，
 * `get()` 永远拿得到值 → 这一层永远命中 → **项目声明的目录名永远不生效**。
 * 调用方用 `projectConfig.ideSetting()`（内部走 `inspect()`）。
 *
 * 历史：这个设置此前是**死设置** —— VS Code 侧把 `ok_templates` 写成常量、
 * **没有任何代码读它**，而子仓会读（10 处）。属反向不对等（docs §8.1）。
 */
export function templatesDirectoryResolved(
  config: ProjectConfig,
  ideValue: unknown,
  fallback: string,
): ResolvedSetting<string> {
  return resolveSetting(
    normalizeRelPath(ideValue),
    normalizeRelPath(templatesOf(config).directory),
    fallback,
  );
}

/** 只要值时的薄封装（绝大多数消费点用这个）。 */
export function templatesDirectoryOf(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return templatesDirectoryResolved(config, ideValue, fallback).value;
}

/**
 * 枚举引用别名。`ideValue` 是调用方读到的个人偏好（IDE 设置）。
 *
 * ⚠️ **`ideValue` 必须传"用户真正设置过的值"，不能传"带默认值的读取结果"。**
 * `package.json` 里 `featureAliases` 的 `default` 就是 `['fL','FeatureList']`，
 * 直接 `get()` 永远拿得到值 → 这一层永远命中 → **项目声明的 aliases 永远不生效**
 * （即"接了等于没接"）。调用方要用 `inspect()` 只看用户真正写入的那几档 ——
 * 见 `providers.featureAliases()`。子仓 `SettingsState` 有同一个陷阱，那边靠
 * "默认值留空"来区分。
 *
 * 别名是"代码里怎么写 import"这一项目约定 —— 项目 `config.py` **从不声明它**，
 * 所以此前只能靠内置的 fL/FeatureList 硬猜；项目把枚举导入成别的名字就完全失效。
 */
export function labelEnumAliases(config: ProjectConfig, ideValue: unknown, fallback: string[]): string[] {
  return labelEnumAliasesResolved(config, ideValue, fallback).value;
}

/** 与 [labelEnumAliases] 同一条链，但**同时给出命中的层**（溯源界面用）。 */
export function labelEnumAliasesResolved(
  config: ProjectConfig,
  ideValue: unknown,
  fallback: string[],
): ResolvedSetting<string[]> {
  // 空数组 = "没设置"，不是"清空" —— 否则用户没法用空值表达"回到项目约定"
  const ide = nonEmptyStrings(ideValue);
  const declared = nonEmptyStrings(labelEnumOf(config).aliases);
  return resolveSetting(
    ide.length ? ide : undefined,
    declared.length ? declared : undefined,
    fallback,
  );
}

/**
 * 枚举类名。`filePath` 用来在没声明时退回文件名 —— 即旧行为。
 *
 * 解耦的意义：文件可以叫 `feature_labels.py`，而类叫 `FeatureList`。
 * 旧写法只有 basename 一条路，想叫 FeatureList 就必须把文件命名成 FeatureList.py。
 */
export function labelEnumName(
  config: ProjectConfig,
  filePath: string,
  basename: (p: string, ext?: string) => string,
): string {
  return nonEmpty(labelEnumOf(config).name) ?? basename(filePath, '.py');
}

/**
 * 枚举文件的**文件路径**（相对项目根，带 `.py`）。
 *
 * ⚠️ 这里必须做一次「模块路径 → 文件路径」的转换，别直接返回声明值。
 * `labelEnum.path` 与项目 `config.py` 的 `label_enum_relative_path` 一样是**模块路径**
 * （`src/data/FeatureList`，**不带 .py**）—— 已核实 ok 框架的
 * `_normalize_label_enum_relative_path()`（`ok/ui/qt/tasks/TemplateTab.py`）会把用户
 * 输入的 `.py` 主动剥掉，以点分模块路径存盘。而消费端（生成枚举文件、拼绝对路径）
 * 需要的是**文件路径**：拿模块路径直接去写，会产出一个叫 `FeatureList`、
 * **没有扩展名**的文件 —— Python 根本 import 不到，等于把项目弄坏。
 *
 * 取值链与全局一致：**个人偏好（上次保存）> 项目约定文件 > 无**。
 *
 * 注意这里个人偏好排最高是**刻意的**（用户明确纠正过）：项目文件是"团队开箱默认"，
 * 我手动指定过就以我的为准。代价是项目之后改声明我看不到 —— 由 UI 的
 * 「当前值来自哪一层」+「恢复为项目约定」来抵消（见 docs/project-config.md §3）。
 *
 * 上次保存的值**已经是文件路径**（输入框就要求带 .py），原样返回、不再补后缀。
 */
export function labelEnumFile(config: ProjectConfig, lastSaved?: unknown): string | undefined {
  const saved = nonEmpty(lastSaved);
  if (saved) return saved;
  const declared = nonEmpty(labelEnumOf(config).path);
  if (!declared) return undefined;
  return declared.toLowerCase().endsWith('.py') ? declared : `${declared}.py`;
}
