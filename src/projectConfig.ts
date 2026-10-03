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
  ResolvedSetting,
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
  labelEnumName,
  labelEnumNameResolved,
  labelEnumPath,
  labelEnumPathInputError,
  labelEnumPathResolved,
  normalizeLabelEnumFile,
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
export const DEFAULT_FEATURE_ALIASES = ['fL', 'FeatureList', 'Labels'];

/**
 * 枚举文件路径的兜底：**空串 = 没指定**（这次不生成枚举）。
 *
 * 与 `DEFAULT_CHARACTER_PROJECT_PATH` 一样，空串是有含义的值、不是"缺省忘了填" ——
 * 所以溯源面板必须把它渲染成一句人话（直接展示空串在 QuickPick 里是一段空白，看着像坏了）。
 */
export const DEFAULT_LABEL_ENUM_PATH = '';

/**
 * 枚举类名的兜底：**空串 = 没有可用的名字**，调用方退回"用文件名推导"。
 *
 * 兜底层不是一个常量而是**从文件路径算出来的**，所以这里只能放占位空串；
 * 真正求值在 `labelEnumNameSetting(filePath)` 里。
 */
export const DEFAULT_LABEL_ENUM_NAME = '';

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
 * 传入 `scope`（工作区文件夹的 URI）时，`inspect()` 只返回该文件夹作用域内的值；
 * 不传则退回到无作用域的全局 inspect。**枚举路径/类名**等"我的偏好"项应始终传 scope，
 * 以避免 A 项目的值串到 B 项目。
 *
 * **凡是要接取值链的设置项都必须走这里。**
 */
export function ideSetting<T>(key: string, scope?: vscode.Uri): T | undefined {
  const cfg = scope
    ? vscode.workspace.getConfiguration('okScriptToolkit', scope)
    : vscode.workspace.getConfiguration('okScriptToolkit');
  const inspected = cfg.inspect<T>(key);
  // 有 scope 时优先工作区文件夹级值，但 User/Workspace 级的值仍然有效
  // （用户可能在 User settings 里统一设了 labelEnumPath，不应被忽略）
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/**
 * 获取当前第一个工作区文件夹的 URI（如果有的话）。
 *
 * 多数场景只关心"有没有打开的工作区文件夹"；若有多个，取第一个（与旧行为一致）。
 */
export function currentWorkspaceFolderUri(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * 写**个人偏好**（IDE 设置）。与 [ideSetting] 成对：那边读用户真正设过的值，这边写。
 *
 * 作用域固定为**工作区文件夹级** —— 这一项是"我的枚举路径 / 我的类名"，
 * 天然属于当前项目。**不允许在没有工作区文件夹时写入全局设置**：
 * 旧实现的 `ConfigurationTarget.Global` 回退会让 A 项目的值串到 B 项目
 * （旧 `globalState` 方案同理：A 项目填过 `src/data/feature_list.py` 之后，
 * 在 B 项目导出时默认值还是它，一回车就按 B 的根拼出一个**不存在**的路径，
 * 而生成函数里有 `mkdirSync(recursive: true)` —— 静默在项目里造出错误的目录树）。
 *
 * 工作区文件夹级写入顺带解决了可见性：那个值从此在设置界面能看到、
 * 在溯源面板能溯源、也能一键恢复（`globalState` 三者皆无）。
 *
 * `value` 传空串/空白 → 写 `undefined`（**真的删掉这一项**，而不是留一条空条目）。
 * 空值在这条链里表示"回到项目约定"（与 `labelEnum.aliases` 同一条规则）。
 *
 * **没有工作区文件夹时直接返回，不做任何写入** —— 防止跨项目污染。
 */
export async function setIdeSetting(
  key: string,
  value: string | undefined,
  folderUri?: vscode.Uri,
): Promise<void> {
  const uri = folderUri ?? currentWorkspaceFolderUri();
  if (!uri) return; // 无工作区文件夹 → 不写入任何设置
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit', uri);
  const trimmed = value?.trim();
  await cfg.update(key, trimmed ? trimmed : undefined, vscode.ConfigurationTarget.WorkspaceFolder);
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
 * 枚举文件的**文件路径**（相对项目根，带 `.py`）。`''` = 没指定（跳过生成）。
 *
 * 取值链：**IDE 设置 `labelEnumPath` > 项目约定 `labelEnum.path` > 空**。
 * 设置项与项目字段**同名**（不像 `enablePoData` ↔ `i18n.enabled` 那样分名）——
 * 因为两者语义相同（"这个项目的枚举文件在哪"），分名反而要用户多记一个词。
 *
 * 传入 `scope`（工作区文件夹 URI）时，IDE 设置的读取会限定在该文件夹作用域内，
 * 防止 A 项目的值串到 B 项目。
 */
export function labelEnumPathSetting(scope?: vscode.Uri, projectDir?: string): string {
  return labelEnumPath(loadProjectConfig(projectDir), ideSetting<string>('labelEnumPath', scope));
}

/**
 * 把**用户当场输入**的枚举路径归一化成文件路径（相对项目根，带 `.py`）。空输入返回 `''`。
 *
 * ⚠️ **消费输入框的结果之前必须过这一道**，不能直接拿去 `path.join`。
 * `labelEnumPathSetting()` 读出来的值已经在取值链里归一化过了，但输入框里的是**裸输入**：
 * 用户填 `src/data/feature_list`（模块路径，与 `config.py` 的
 * `label_enum_relative_path` 同形）时，直接拼绝对路径会写出一个叫 `feature_list`、
 * **没有扩展名**的文件 —— Python 根本 import 不到，等于把项目弄坏。
 * 归一化只在"下次读设置"时才生效，所以"这一次"的保存是坏的：典型的"看起来能用、
 * 只是生成的文件名不对"。这里补上，消费点不用各自判断。
 */
export function normalizeLabelEnumPathInput(value: string): string {
  const error = labelEnumPathInputError(value);
  if (error) throw new RangeError(`Invalid workspace-relative enum path: ${error}`);
  return normalizeLabelEnumFile(value) ?? '';
}

/**
 * 枚举**类名**（带来源层）。`filePath` 是**即将写入**的文件路径。
 *
 * 兜底层是"用文件名推导"，必须拿到文件路径才能求值，所以这里和
 * [labelEnumPathSetting] 不同、要额外收一个参数。
 *
 * `projectDir` 传调用方自己用的那个项目根（模板数据可能来自另一个仓库，
 * 用错根会读到别人的约定文件）。不传则用 `resolveProjectDir()`。
 *
 * 传入 `scope`（工作区文件夹 URI）时，IDE 设置的读取会限定在该文件夹作用域内。
 */
export function labelEnumNameSetting(filePath: string, projectDir?: string, scope?: vscode.Uri): ResolvedSetting<string> {
  return labelEnumNameResolved(
    loadProjectConfig(projectDir),
    ideSetting<string>('labelEnumName', scope),
    path.basename(filePath, '.py'),
  );
}

/** 只要类名时的薄封装（绝大多数消费点用这个）。 */
export function labelEnumClassName(filePath: string, projectDir?: string, scope?: vscode.Uri): string {
  return labelEnumNameSetting(filePath, projectDir, scope).value;
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
