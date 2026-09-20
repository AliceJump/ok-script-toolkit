/**
 * 项目约定文件 `ok-script-toolkit.json` 的**读盘侧**：定位项目根、读文件、缓存。
 *
 * 文件放在**被调试项目**根目录，VS Code 扩展与 JetBrains 插件共用同一份
 * （子仓对应实现见 `core/ProjectConventionConfig.kt`，逻辑一一对应）。
 * 插件**只读**它 —— 由项目作者维护，插件绝不写入。
 *
 * 解析与取值链在 `projectConfigPure.ts`（不依赖 vscode，可单测）。
 * 设计说明见仓库根的 `docs/project-config.md`。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ProjectConfig,
  charactersAvatarTemplateRegex,
  charactersLocaleFile,
  charactersMasterFile,
  charactersProjectPath,
  charactersSkillsDirectory,
  effectsFile,
  i18nEnabled,
  i18nLangDirectory,
  i18nPoDirectory,
  i18nPoDomains,
  normalizeRelPath,
  parseProjectConfig,
  templatesDirectoryOf,
  templatesOf,
} from './projectConfigPure';

export const PROJECT_CONFIG_FILE = 'ok-script-toolkit.json';

/** 模板目录的内置兜底（`ok_templates`）。子仓 `OkScriptToolkitSettings` 同值。 */
export const DEFAULT_TEMPLATES_DIRECTORY = 'ok_templates';

/**
 * 枚举引用别名的**内置兜底**。
 *
 * ⚠️ 它是取值链的最后一层，**不是** `package.json` 里 `featureAliases` 的"个人偏好"值 ——
 * 后者一旦非空（它确实非空），"个人偏好"层就永远命中、项目声明失效。
 * 所以读它必须走 `ideSetting()`（`inspect()`），不能用 `get()`。
 */
export const DEFAULT_FEATURE_ALIASES = ['fL', 'FeatureList'];

/* ---------------- i18n / characters / effects 三组的兜底 ---------------- */

/**
 * 下面这些常量是各条取值链的**最后一层**，**不是** `package.json` 里对应设置的
 * "个人偏好"值 —— 后者的 `default` 与它们同值（这是刻意的：用户没配过时行为不变），
 * 所以读个人偏好必须走 `ideSetting()`（`inspect()`），**不能用 `get()`**。
 * 用 `get()` 会让个人偏好层永远命中、项目声明永远不生效（静默）。
 */
export const DEFAULT_I18N_ENABLED = true;
export const DEFAULT_LANG_DIRECTORY = 'assets/lang';
export const DEFAULT_PO_DIRECTORY = 'i18n';
export const DEFAULT_PO_DOMAINS = ['ocr'];

/** `characters.projectPath` 的兜底是**空串**：空 = 与当前项目相同。 */
export const DEFAULT_CHARACTER_PROJECT_PATH = '';
export const DEFAULT_CHARACTER_MASTER_FILE = 'assets/data/characters.json';
export const DEFAULT_CHARACTER_SKILLS_DIRECTORY = 'assets/data/character_skills';
export const DEFAULT_CHARACTER_LOCALE_FILE = 'assets/lang/characters.json';
export const DEFAULT_AVATAR_TEMPLATE_REGEX = '^battle[_-]?icon[_-]?';

export const DEFAULT_EFFECTS_FILE = 'src/data/effects.py';

export * from './projectConfigPure';

/**
 * 解析当前工作区对应的 ok-script 项目根。
 *
 * 这是**唯一**的项目根解析实现：`taskLauncher.resolveProjectContext()` 与
 * `screenshotCapture.getProjectConfig()` 原先各自复制了一份同样的逻辑，
 * 现已改为调用这里，避免"界面与脚本看的不是同一目录"那类漂移。
 *
 * 注意 `characterPanel.resolveProjectDir()` **故意不复用** —— 它解析的是
 * "角色数据所在项目"（优先 `characterProjectPath`，自动探测 `assets/data/characters.json`），
 * 与主项目可以不是同一个。
 */
export function resolveProjectDir(): string {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
  let projectDir = cfg.get<string>('okScriptProjectPath') || '';
  projectDir = projectDir.replace(/^~/, process.env.USERPROFILE || '');
  projectDir = projectDir.replace(/[\\/]+$/, '');
  if (projectDir) return projectDir;

  // 自动检测：工作区根目录本身就是 ok-script 项目
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (root && (fs.existsSync(path.join(root, 'src', 'config.py')) || fs.existsSync(path.join(root, 'config.py')))) {
    return root;
  }
  return '';
}

/** 缓存：同一文件 + 同一 mtime 就不重复读盘（访问器调用很频繁） */
let cache: { file: string; mtimeMs: number; config: ProjectConfig } | undefined;

/**
 * 读项目根的 `ok-script-toolkit.json`。
 *
 * **容错是刻意的**：这是可选的纯增量配置，文件缺席、JSON 语法错、顶层不是对象
 * 一律当成"没有约定"，绝不抛异常、绝不影响调用方。解析失败也会被缓存，
 * 免得每次访问都重试一遍坏文件。
 */
export function loadProjectConfig(projectDir?: string): ProjectConfig {
  const dir = projectDir ?? resolveProjectDir();
  if (!dir) return {};

  const file = path.join(dir, PROJECT_CONFIG_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache = undefined;
    return {};
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.config;

  let config: ProjectConfig = {};
  try {
    config = parseProjectConfig(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    config = {};
  }
  cache = { file, mtimeMs, config };
  return config;
}

/** 仅供测试：清掉缓存，避免用例之间互相污染 */
export function clearProjectConfigCache(): void {
  cache = undefined;
}

/**
 * 读**用户真正设置过**的 IDE 设置值；从没设过返回 `undefined`。
 *
 * ⚠️ **不能用 `getConfiguration().get(key)`** —— 它会把 `package.json` 里的
 * `default` 一并返回。本仓库的设置项**几乎全都带非空默认值**（`ok_templates`、
 * `assets/lang`、`src/data/effects.py`、`["fL","FeatureList"]` …），于是
 * "这一层永远命中"→ 项目约定文件里声明的值**永远不生效**，而且界面一切正常 ——
 * 这正是 `featureAliases` 已经踩过一次的静默缺陷（docs/project-config.md §3）。
 *
 * `inspect()` 能把「用户写入的值」与「默认值」分开：工作区文件夹级 / 工作区级 /
 * 全局级**三者都为 `undefined`** 才算"没设过"。就近覆盖优先，与 VS Code 自己的
 * 设置优先级一致。
 *
 * **凡是要接取值链的设置项都必须走这里。**
 */
export function ideSetting<T>(key: string): T | undefined {
  const inspected = vscode.workspace.getConfiguration('okScriptToolkit').inspect<T>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/**
 * 模板目录名（相对项目根）。
 *
 * 取值链：**个人偏好（IDE 设置）> 项目约定文件 `templates.directory` > `ok_templates`**。
 *
 * `projectDir` 传调用方自己用的那个项目根 —— 角色/模板数据可能来自另一个仓库，
 * 用错根会读到别人的约定文件。不传则用 `resolveProjectDir()`。
 */
export function templatesDirectory(projectDir?: string): string {
  return templatesDirectoryOf(
    loadProjectConfig(projectDir),
    ideSetting<string>('okTemplatesDirectory'),
    DEFAULT_TEMPLATES_DIRECTORY,
  );
}

/* ---------------- i18n / characters / effects 三组的便捷访问器 ---------------- */

/**
 * 命名约定：**带 `Setting` 后缀的是"读 IDE 设置 + 走取值链"的便捷访问器**，
 * 它们内部自己取 `ideSetting()` 与兜底；`projectConfigPure` 里那些
 * `xxxResolved(config, ideValue, fallback)` / `xxxOf(...)` 是**纯函数**，
 * 由调用方把三样东西都传进来。
 *
 * 为什么不统一名字：`projectConfig.ts` 里 `export * from './projectConfigPure'`，
 * 同名会冲突。`templatesDirectory()` 是这个约定之前留下的，保持原样不动。
 */

/** 是否启用 gettext po 数据源。 */
export function i18nEnabledSetting(): boolean {
  return i18nEnabled(loadProjectConfig(), ideSetting<boolean>('enablePoData'), DEFAULT_I18N_ENABLED);
}

/** 语言 JSON 目录（角色名等），相对项目根。 */
export function i18nLangDirectorySetting(): string {
  return i18nLangDirectory(loadProjectConfig(), ideSetting<string>('langDirectory'), DEFAULT_LANG_DIRECTORY);
}

/** gettext .po 目录，相对项目根。 */
export function i18nPoDirectorySetting(): string {
  return i18nPoDirectory(loadProjectConfig(), ideSetting<string>('poDirectory'), DEFAULT_PO_DIRECTORY);
}

/** 参与索引的 po domain。 */
export function i18nPoDomainsSetting(): string[] {
  return i18nPoDomains(loadProjectConfig(), ideSetting<string[]>('poDomains'), DEFAULT_PO_DOMAINS);
}

/** 角色数据所在项目根（空 = 与当前项目相同）。消费端自行做 `~` 展开与 `path.resolve`。 */
export function charactersProjectPathSetting(): string {
  return charactersProjectPath(
    loadProjectConfig(),
    ideSetting<string>('characterProjectPath'),
    DEFAULT_CHARACTER_PROJECT_PATH,
  );
}

/** 角色主数据文件，相对角色项目根。 */
export function charactersMasterFileSetting(): string {
  return charactersMasterFile(
    loadProjectConfig(),
    ideSetting<string>('characterMasterFile'),
    DEFAULT_CHARACTER_MASTER_FILE,
  );
}

/** 技能 JSON 目录，相对角色项目根。 */
export function charactersSkillsDirectorySetting(): string {
  return charactersSkillsDirectory(
    loadProjectConfig(),
    ideSetting<string>('characterSkillsDirectory'),
    DEFAULT_CHARACTER_SKILLS_DIRECTORY,
  );
}

/** 角色名多语言文件，相对角色项目根。 */
export function charactersLocaleFileSetting(): string {
  return charactersLocaleFile(
    loadProjectConfig(),
    ideSetting<string>('characterLocaleFile'),
    DEFAULT_CHARACTER_LOCALE_FILE,
  );
}

/** 头像模板的命名正则。 */
export function charactersAvatarTemplateRegexSetting(): string {
  return charactersAvatarTemplateRegex(
    loadProjectConfig(),
    ideSetting<string>('characterAvatarTemplateRegex'),
    DEFAULT_AVATAR_TEMPLATE_REGEX,
  );
}

/** 效果定义源文件，相对项目根。 */
export function effectsFileSetting(): string {
  return effectsFile(loadProjectConfig(), ideSetting<string>('effectsFile'), DEFAULT_EFFECTS_FILE);
}

/**
 * **运行时模板库**路径的项目约定声明（`templates.cocoAnnotations`，相对项目根，已归一化）。
 * 没声明返回 `undefined`。
 *
 * ⚠️ 它指向的是 ok 框架加载的那份 COCO（`config.py` 的
 * `template_matching.coco_feature_json`），**不是**素材面板自己的
 * `<模板目录>/coco_annotations.json`。见 `cocoFeaturePathPure.ts` 的对照表。
 *
 * 这一项**没有对应的 IDE 设置**（所以没有"个人偏好"层）—— 链是
 * `项目约定 > config.py > 依次探测两个候选`，见 `cocoFeaturePath.ts`。
 */
export function templatesCocoAnnotationsSetting(projectDir?: string): string | undefined {
  return normalizeRelPath(templatesOf(loadProjectConfig(projectDir)).cocoAnnotations);
}
