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
  /** 枚举文件路径，相对项目根。模块路径（不带 .py）与文件路径都容忍，见 [normalizeLabelEnumFile] */
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
  i18n?: ProjectI18n;
  characters?: ProjectCharacters;
  effects?: ProjectEffects;
}

/** `i18n` 一组：gettext / 语言 JSON 的位置与开关。 */
export interface ProjectI18n {
  /** 是否读 po 数据 */
  enabled?: boolean;
  /** 语言 JSON 目录（角色名等），相对项目根 */
  langDirectory?: string;
  /** gettext .po 目录，相对项目根 */
  poDirectory?: string;
  /** 参与索引的 po domain */
  poDomains?: string[];
}

/** `characters` 一组：角色数据的位置。 */
export interface ProjectCharacters {
  /** 角色数据所在项目根。**空 = 与当前项目相同**（角色数据放在另一个仓库时才需要填） */
  projectPath?: string;
  /** 角色主数据文件，相对 [projectPath] */
  masterFile?: string;
  /** 技能 JSON 目录，相对 [projectPath] */
  skillsDirectory?: string;
  /** 角色名多语言文件，相对 [projectPath] */
  localeFile?: string;
  /** 头像模板的命名正则（把模板名关联到角色） */
  avatarTemplateRegex?: string;
}

/** `effects` 一组：效果定义源文件。 */
export interface ProjectEffects {
  /** 效果定义源文件（`EffectType` / `EFFECT_DESCRIPTIONS` 所在），相对项目根 */
  file?: string;
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
 * 相对路径归一化：统一成 `/` 分隔、去掉首尾斜杠与开头的 `./`；空（或只有斜杠）→ `undefined`。
 *
 * 为什么需要它：这个值会被**三种方式**消费 —— `path.join` 拼绝对路径、
 * `rel.startsWith(...)` 比较、以及**拼进 glob / 正则**（`extension.ts` 的文件监听）。
 * 声明文件里写 `ok_templates\` 或 `./ok_templates` 时，后两种都会失配，
 * 且失配是**静默**的（监听不触发，界面看着正常）。所以入口处统一归一化一次。
 *
 * 只剥开头的 `./`，**不碰 `../`** —— 后者是有意义的上跳，剥了就指到别处去了。
 */
export function normalizeRelPath(value: unknown): string | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  const cleaned = raw.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '');
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

/** `i18n` 一组（保证是对象）。 */
export function i18nOf(config: ProjectConfig): ProjectI18n {
  const value = config.i18n;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** `characters` 一组（保证是对象）。 */
export function charactersOf(config: ProjectConfig): ProjectCharacters {
  const value = config.characters;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** `effects` 一组（保证是对象）。 */
export function effectsOf(config: ProjectConfig): ProjectEffects {
  const value = config.effects;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * **相对路径类**字段的统一取值链：两侧都过一遍 [normalizeRelPath]。
 *
 * 为什么统一在这里归一化：这些值全部会被拼进路径，其中一部分还会被拿去
 * **做目录段匹配 / 拼进 glob / 正则**（`OkDataChangeService.dirMatches`、
 * `extension.ts` 的文件监听）。声明里写 `assets\lang` 或 `/assets/lang` 时，
 * 后两种用法**静默**失配 —— 界面一切正常，只是"改了文件不刷新"。
 *
 * ⚠️ **绝对路径类字段不要用这个**（如 `characters.projectPath`）：
 * 归一化会把 POSIX 绝对路径的开头斜杠吃掉（`/home/me/proj` → `home/me/proj`）。
 * 那类字段用 [textResolved]，由消费端自己处理 `~` 与 `path.resolve`。
 */
function relPathResolved(ideValue: unknown, declared: unknown, fallback: string): ResolvedSetting<string> {
  return resolveSetting(normalizeRelPath(ideValue), normalizeRelPath(declared), fallback);
}

/** 纯文本类字段（正则、绝对路径…）：只做"非空"判断，不做斜杠归一化。 */
function textResolved(ideValue: unknown, declared: unknown, fallback: string): ResolvedSetting<string> {
  return resolveSetting(nonEmpty(ideValue), nonEmpty(declared), fallback);
}

/** 布尔字段：非布尔一律当"没写"（手写文件里 `"enabled": "true"` 是写错了）。 */
function boolResolved(ideValue: unknown, declared: unknown, fallback: boolean): ResolvedSetting<boolean> {
  const ide = typeof ideValue === 'boolean' ? ideValue : undefined;
  const dec = typeof declared === 'boolean' ? declared : undefined;
  return resolveSetting(ide, dec, fallback);
}

/** 字符串数组字段：空数组 = "没声明"（与 `labelEnum.aliases` 同一条规则）。 */
function listResolved(ideValue: unknown, declared: unknown, fallback: string[]): ResolvedSetting<string[]> {
  const ide = nonEmptyStrings(ideValue);
  const dec = nonEmptyStrings(declared);
  return resolveSetting(ide.length ? ide : undefined, dec.length ? dec : undefined, fallback);
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
  return relPathResolved(ideValue, templatesOf(config).directory, fallback);
}

/** 只要值时的薄封装（绝大多数消费点用这个）。 */
export function templatesDirectoryOf(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return templatesDirectoryResolved(config, ideValue, fallback).value;
}

/* ---------------- i18n 一组 ---------------- */

/**
 * 是否启用 gettext po 数据源。
 *
 * 项目约定文件里叫 `i18n.enabled`，IDE 设置里叫 `enablePoData` —— **名字不同**，
 * 因为前者是"这个项目的 i18n 长什么样"（团队约定），后者是"我这台机器要不要读它"。
 */
export function i18nEnabledResolved(config: ProjectConfig, ideValue: unknown, fallback: boolean): ResolvedSetting<boolean> {
  return boolResolved(ideValue, i18nOf(config).enabled, fallback);
}
export function i18nEnabled(config: ProjectConfig, ideValue: unknown, fallback: boolean): boolean {
  return i18nEnabledResolved(config, ideValue, fallback).value;
}

/** 语言 JSON 目录（角色名等），相对项目根。 */
export function i18nLangDirectoryResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return relPathResolved(ideValue, i18nOf(config).langDirectory, fallback);
}
export function i18nLangDirectory(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return i18nLangDirectoryResolved(config, ideValue, fallback).value;
}

/** gettext .po 目录，相对项目根。 */
export function i18nPoDirectoryResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return relPathResolved(ideValue, i18nOf(config).poDirectory, fallback);
}
export function i18nPoDirectory(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return i18nPoDirectoryResolved(config, ideValue, fallback).value;
}

/**
 * 参与索引的 po domain。
 *
 * ⚠️ 空数组 = "没声明"，不是"清空" —— 否则用户没法用空值表达"回到项目约定"
 * （与 `labelEnum.aliases` 同一条规则）。
 */
export function i18nPoDomainsResolved(config: ProjectConfig, ideValue: unknown, fallback: string[]): ResolvedSetting<string[]> {
  return listResolved(ideValue, i18nOf(config).poDomains, fallback);
}
export function i18nPoDomains(config: ProjectConfig, ideValue: unknown, fallback: string[]): string[] {
  return i18nPoDomainsResolved(config, ideValue, fallback).value;
}

/* ---------------- characters 一组 ---------------- */

/**
 * 角色数据所在项目根。
 *
 * **空字符串是合法的声明值**，含义是"与当前项目相同"（角色数据放在另一个仓库时才需要填）
 * —— 所以这里不能用 [relPathResolved]（它会把空串当"没写"、还会吃掉绝对路径的开头斜杠）。
 * 消费端照旧处理 `~` 展开与 `path.resolve`。
 */
export function charactersProjectPathResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return textResolved(ideValue, charactersOf(config).projectPath, fallback);
}
export function charactersProjectPath(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return charactersProjectPathResolved(config, ideValue, fallback).value;
}

/** 角色主数据文件，相对 `characters.projectPath`。 */
export function charactersMasterFileResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return relPathResolved(ideValue, charactersOf(config).masterFile, fallback);
}
export function charactersMasterFile(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return charactersMasterFileResolved(config, ideValue, fallback).value;
}

/** 技能 JSON 目录，相对 `characters.projectPath`。 */
export function charactersSkillsDirectoryResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return relPathResolved(ideValue, charactersOf(config).skillsDirectory, fallback);
}
export function charactersSkillsDirectory(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return charactersSkillsDirectoryResolved(config, ideValue, fallback).value;
}

/** 角色名多语言文件，相对 `characters.projectPath`。 */
export function charactersLocaleFileResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return relPathResolved(ideValue, charactersOf(config).localeFile, fallback);
}
export function charactersLocaleFile(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return charactersLocaleFileResolved(config, ideValue, fallback).value;
}

/**
 * 头像模板的命名正则。
 *
 * ⚠️ 走 [textResolved] 而**不是** [relPathResolved] —— 这是正则不是路径，
 * 归一化会把 `\d` 里的反斜杠换掉、把首尾斜杠吃掉，正则就废了。
 */
export function charactersAvatarTemplateRegexResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return textResolved(ideValue, charactersOf(config).avatarTemplateRegex, fallback);
}
export function charactersAvatarTemplateRegex(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return charactersAvatarTemplateRegexResolved(config, ideValue, fallback).value;
}

/* ---------------- effects 一组 ---------------- */

/** 效果定义源文件（`EffectType` / `EFFECT_DESCRIPTIONS` 所在），相对项目根。 */
export function effectsFileResolved(config: ProjectConfig, ideValue: unknown, fallback: string): ResolvedSetting<string> {
  return relPathResolved(ideValue, effectsOf(config).file, fallback);
}
export function effectsFile(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return effectsFileResolved(config, ideValue, fallback).value;
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
 * 枚举类名，**带来源层**。
 *
 * 取值链：**个人偏好（IDE 设置）> 项目约定文件 `labelEnum.name` > 文件名推导**。
 *
 * 兜底层是"用文件名推导"（旧行为）—— **不是常量**，所以 `fallback` 由调用方传入
 * （通常是 `basename(filePath, '.py')`）。溯源面板拿不到文件路径，传 `''`，
 * 由 `render` 渲染成一句人话（与 `characters.projectPath` 的空兜底同样处理）。
 *
 * 解耦的意义：文件可以叫 `feature_labels.py`，而类叫 `FeatureList`。
 * 旧写法只有 basename 一条路，想叫 FeatureList 就必须把文件命名成 FeatureList.py。
 *
 * ⚠️ 这个字段比其它设置危险：它**决定写进源码的类名**，而项目的代码是按名字 import 的
 * （`from src.data.feature_list import FeatureList`）。个人覆盖改错就是全项目 `ImportError`。
 * 所以消费端在**覆盖已有文件**前会先做一次类名变更校验（`labelEnumGuard.ts`），
 * 把"静默弄坏项目"变成"先问一句"。
 */
export function labelEnumNameResolved(
  config: ProjectConfig,
  ideValue: unknown,
  fallback: string,
): ResolvedSetting<string> {
  return resolveSetting(nonEmpty(ideValue), nonEmpty(labelEnumOf(config).name), fallback);
}

/** 只要值时的薄封装。返回 `''` 表示"没有名字可用"（调用方应退回文件名）。 */
export function labelEnumName(config: ProjectConfig, ideValue: unknown, fallback: string): string {
  return labelEnumNameResolved(config, ideValue, fallback).value;
}

/**
 * 枚举文件的**文件路径**（相对项目根，带 `.py`）。**带来源层**。
 *
 * ⚠️ 这里必须做一次「模块路径 → 文件路径」的转换，别直接返回声明值。
 * `labelEnum.path` 与项目 `config.py` 的 `label_enum_relative_path` 一样是**模块路径**
 * （`src/data/FeatureList`，**不带 .py**）—— 已核实 ok 框架的
 * `_normalize_label_enum_relative_path()`（`ok/ui/qt/tasks/TemplateTab.py`）会把用户
 * 输入的 `.py` 主动剥掉，以点分模块路径存盘。而消费端（生成枚举文件、拼绝对路径）
 * 需要的是**文件路径**：拿模块路径直接去写，会产出一个叫 `FeatureList`、
 * **没有扩展名**的文件 —— Python 根本 import 不到，等于把项目弄坏。
 *
 * 取值链：**个人偏好（IDE 设置）> 项目约定文件 `labelEnum.path` > 无（空串）**。
 *
 * 注意这里个人偏好排最高是**刻意的**（用户明确纠正过）：项目文件是"团队开箱默认"，
 * 我手动指定过就以我的为准。代价是项目之后改声明我看不到 —— 由 UI 的
 * 「当前值来自哪一层」+「恢复为项目约定」来抵消（见 docs/project-config.md §3）。
 *
 * 空串 = "没有指定，这次不生成枚举"。注意空串同时也是"没设置过"的归一化结果，
 * 所以用户在设置里清空它就等于"回到项目约定" —— 与 `labelEnum.aliases` 同一条规则
 * （空值表达"回到项目约定"，而不是"钉死为空"）。
 */
export function labelEnumPathResolved(config: ProjectConfig, ideValue: unknown): ResolvedSetting<string> {
  return resolveSetting(
    normalizeLabelEnumFile(ideValue),
    normalizeLabelEnumFile(labelEnumOf(config).path),
    '',
  );
}

/** 只要值时的薄封装。`''` = 没指定（调用方应跳过生成）。 */
export function labelEnumPath(config: ProjectConfig, ideValue: unknown): string {
  return labelEnumPathResolved(config, ideValue).value;
}

/**
 * 枚举路径的归一化：**模块路径与文件路径都容忍**。
 *
 * 项目约定文件里写的是模块路径（`src/data/FeatureList`，不带 `.py` —— 与 `config.py` 的
 * `label_enum_relative_path` 同形），而 IDE 设置那个输入框要的是文件路径（带 `.py`）。
 * 两种写法指同一个文件，没必要让用户记住"哪个框该写哪种" —— 有 `.py` 就用，没有就补。
 *
 * 旧实现只给"项目声明"补后缀、把"上次保存"原样返回，于是从输入框里填模块路径会生成一个
 * **没有扩展名**的文件。统一在这里补，消费点不用各自判断。
 */
export function normalizeLabelEnumFile(value: unknown): string | undefined {
  const rel = normalizeRelPath(value);
  if (!rel) return undefined;
  return rel.toLowerCase().endsWith('.py') ? rel : `${rel}.py`;
}

/** 用户输入的枚举路径为什么不能按工作区相对路径使用。 */
export type LabelEnumPathInputError = 'absolute' | 'traversal';

/**
 * 校验**输入框里的原始值**，必须在 [normalizeRelPath] 剥掉开头斜杠之前调用。
 *
 * 空值合法（表示跳过生成）；非空值必须是工作区相对路径。Windows 盘符、UNC/POSIX
 * 绝对路径，以及任意 `..` 段都拒绝。后者即使当前组合恰好没有越界也不保留：路径在日后
 * 被移动或前缀变化时可能越过工作区，而且枚举文件没有使用上跳段的合理需求。
 */
export function labelEnumPathInputError(value: unknown): LabelEnumPathInputError | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  if (/^(?:[\\/]|[A-Za-z]:)/.test(raw)) return 'absolute';
  if (raw.replace(/\\/g, '/').split('/').includes('..')) return 'traversal';
  return undefined;
}
