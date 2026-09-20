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
import { ProjectConfig, parseProjectConfig } from './projectConfigPure';

export const PROJECT_CONFIG_FILE = 'ok-script-toolkit.json';

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
