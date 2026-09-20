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
import { ProjectConfig, parseProjectConfig, templatesDirectoryOf } from './projectConfigPure';

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
