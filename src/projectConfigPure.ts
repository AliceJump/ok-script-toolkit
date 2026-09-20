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

export interface ProjectConfig {
  labelEnum?: ProjectLabelEnum;
  executor?: {
    startupHooks?: {
      beforeConfigImport?: string[];
      afterConfigImport?: string[];
    };
  };
  templates?: { directory?: string; cocoAnnotations?: string };
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

/**
 * 枚举引用别名。`ideValue` 是调用方读到的个人偏好（IDE 设置）。
 *
 * 别名是"代码里怎么写 import"这一项目约定 —— 项目 `config.py` **从不声明它**，
 * 所以此前只能靠内置的 fL/FeatureList 硬猜；项目把枚举导入成别的名字就完全失效。
 */
export function labelEnumAliases(config: ProjectConfig, ideValue: unknown, fallback: string[]): string[] {
  const ide = nonEmptyStrings(ideValue);
  if (ide.length) return ide;
  const declared = nonEmptyStrings(labelEnumOf(config).aliases);
  if (declared.length) return declared;
  return fallback;
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
 * 枚举文件路径（相对项目根，不带 .py）。
 *
 * 取值链与全局一致：**个人偏好（上次保存）> 项目约定文件 > 无**。
 *
 * 注意这里个人偏好排最高是**刻意的**（用户明确纠正过）：项目文件是"团队开箱默认"，
 * 我手动指定过就以我的为准。代价是项目之后改声明我看不到 —— 由 UI 的
 * 「当前值来自哪一层」+「恢复为项目约定」来抵消（见 docs/project-config.md §3）。
 */
export function labelEnumPath(config: ProjectConfig, lastSaved?: unknown): string | undefined {
  return nonEmpty(lastSaved) ?? nonEmpty(labelEnumOf(config).path);
}
