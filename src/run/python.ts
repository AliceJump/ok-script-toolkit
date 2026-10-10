import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { selectedProjectLocale, tr } from '../localization';
import { i18nPoDirectorySetting, resolveProjectDir } from '../projectConfig';
import {
  AccountStoreData,
  GlobalConfigGroup,
  MultiAccountInfo,
  SchemaProbeResult,
  TaskInfo,
  TaskListResult,
  TaskSchema,
} from './types';

/** 扩展根目录下 python/ 脚本的绝对路径 */
export function pythonScript(extensionUri: vscode.Uri, name: string): string {
  return path.join(extensionUri.fsPath, 'python', name);
}

/** All three Python entry points use the same VS Code sandbox for one project. */
export function runDirForProject(projectDir: string): string {
  return path.join(projectDir, '.vscode', 'ok-script-toolkit');
}

/** 解析 Python 子进程 stdout 中最后一个 JSON 行（前面的输出可能是日志） */
export function parseJsonFromStdout(stdout: string): any {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* 跳过非 JSON 行 */ }
  }
  return null;
}

/** JSON-compatible config values use deep value equality; primitives retain strict comparison. */
export function configValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!configValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && configValuesEqual(leftRecord[key], rightRecord[key]));
}

interface PythonResult {
  stdout: string;
  stderr: string;
}

/** 异步运行 Python，避免耗时探针阻塞 VS Code 扩展宿主。 */
export function runPython(
  pythonPath: string,
  args: string[],
  projectDir: string,
  timeout: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<PythonResult> {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extraEnv };
  return new Promise((resolve, reject) => {
    cp.execFile(pythonPath, args, {
      cwd: projectDir,
      env,
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        // 项目脚本约定：失败时往 stdout 末尾打印 {"ok": false, "error": "..."}；
        // 优先回传结构化错误，其次 stderr，最后才是通用命令失败信息。
        const parsed = parseJsonFromStdout(stdout || '');
        const message = (parsed && typeof parsed.error === 'string' && parsed.error)
          || stderr?.trim()
          || error.message;
        reject(new Error(message));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * 用 Python 子进程 + AST 安全解析 ok-script 项目的 src/config.py，
 * 提取 onetime_tasks / trigger_tasks 注册表，不导入任何模块。
 */
export async function parseConfigTasks(extensionUri: vscode.Uri, projectDir: string, pythonPath: string): Promise<TaskListResult> {
  try {
    const result = await runPython(
      pythonPath,
      [pythonScript(extensionUri, 'parse_config_tasks.py'), projectDir],
      projectDir,
      15000,
    );
    const parsed = parseJsonFromStdout(result.stdout || '');
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || tr('Failed to parse task list') };
    }
    const configModule = parsed.config_module || 'src.config';
    const tasks: TaskInfo[] = [
      ...(parsed.onetime || []).map((t: any) => ({ ...t, kind: 'onetime' })),
      ...(parsed.trigger || []).map((t: any) => ({ ...t, kind: 'trigger' })),
    ].map((t: any) => ({
      module: t.module,
      className: t['class'] || t.class,
      displayName: t.name || t['class'] || t.module,
      kind: t.kind === 'trigger' ? 'trigger' : 'onetime',
    }));
    return { ok: true, tasks, configModule };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 常驻执行器命令行：单一进程连接游戏并轮询全部已启用的触发任务。
 *
 * 与旧 run_task.py 的差异见 python/run_executor.py 顶部说明——旧路径走
 * `ok.run_task(config, task=<单个任务>)`，框架会把 executor.trigger_tasks 收窄成
 * 单个任务并 disable 其余触发任务，因此无法多触发任务串连轮询。
 */
export function buildExecutorCommand(extensionUri: vscode.Uri, configModule: string): string[] {
  return [
    pythonScript(extensionUri, 'run_executor.py'),
    '--config-module', configModule,
  ];
}

/**
 * 用 Python 子进程 + 全量 import 采集项目所有任务的配置 schema —— spawn
 * python/probe_task_schemas.py。复用 ok-script 的 OK(config) + TaskManager
 * 初始化来实例化任务，拿到经过继承链合并的真实 default_config / config_type /
 * config_description / 已保存 config。逐任务 try/except 容错，坏任务标记 broken。
 */
export async function probeTaskSchemas(
  extensionUri: vscode.Uri,
  projectDir: string,
  pythonPath: string,
  locale: string,
  poDirectory: string,
): Promise<SchemaProbeResult> {
  try {
    const result = await runPython(
      pythonPath,
      [pythonScript(extensionUri, 'probe_task_schemas.py'), projectDir, locale, poDirectory],
      projectDir,
      120000,
      { OK_TOOLKIT_RUN_DIR: runDirForProject(projectDir) },
    );
    const parsed = parseJsonFromStdout(result.stdout || '');
    if (!parsed || !parsed.ok) {
      return { ok: false, error: parsed?.error || tr('Failed to collect task schema') };
    }
    return {
      ok: true,
      schemas: parsed.schemas,
      total: parsed.total,
      globalConfigGroups: parsed.globalConfigGroups || [],
      multiAccount: parsed.multiAccount || { available: false },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 解析 ok-script 项目路径与 Python 解释器（工具箱与任务启动器共用）。
 * 配置未填写时，自动检测当前工作区根目录（若含 src/config.py 则视为 ok-script 项目）。
 */
export function resolveProjectContext(): { projectDir: string; pythonPath: string; fromConfig: boolean } {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
  // 项目根解析统一走 projectConfig.resolveProjectDir()。这里原先是本文件与
  // screenshotCapture.ts 各复制一份同样的逻辑，两处容易漂移成"界面与脚本看的不是
  // 同一目录"。fromConfig 表示"来自显式设置"而不是自动探测到的。
  const projectDir = resolveProjectDir();
  const fromConfig = (cfg.get<string>('okScriptProjectPath') || '').trim().length > 0;

  const python = cfg.get<string>('okScriptPython') || '';
  let pythonPath = python;
  if (!pythonPath) {
    const venvPy = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
    pythonPath = fs.existsSync(venvPy) ? venvPy : 'python';
  }
  return { projectDir, pythonPath, fromConfig };
}

/** 强制结束执行器进程的超时（秒）：收到 stop 后仍未退出则 taskkill 兜底 */
export const FORCE_KILL_DELAY_MS = 12000;

/** 参数覆盖推送防抖（毫秒）：表单自动保存很频繁，合并后再推给执行器 */
export const PARAMS_PUSH_DEBOUNCE_MS = 400;

/** 已由 Python/framework logger 写出的时间戳不要重复添加。 */
export const OUTPUT_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d+)?(?:\s|$)/;

export function padNumber(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * VS Code 普通 OutputChannel 不会替 append/appendLine 内容生成时间戳。
 * 执行器里的框架日志通常已经带时间；插件自己的状态行 / toolkit 行则没有。
 * 这里只给缺失时间戳的非空行补本地时间，保持 Python 原始日志不变且避免双时间戳。
 */
export function formatConsoleOutputLine(line: string, now = new Date()): string {
  if (!line || OUTPUT_TIMESTAMP_RE.test(line)) return line;
  const timestamp = [
    now.getFullYear(), '-', padNumber(now.getMonth() + 1), '-', padNumber(now.getDate()), ' ',
    padNumber(now.getHours()), ':', padNumber(now.getMinutes()), ':', padNumber(now.getSeconds()), ',',
    padNumber(now.getMilliseconds(), 3),
  ].join('');
  return `${timestamp} ${line}`;
}

/**
 * 侧边栏「ok-script 控制台」视图 —— 任务启动器 + 游戏工具箱的统一宿主。
 *
 * 布局（media/console/）：顶部全局状态条（游戏连接 + 执行器），下方「任务 / 游戏」
 * 两个分段。原侧边栏工具箱视图（okScriptToolkit.toolbox）已并入这里。
 *
 * 进程模型：整个项目只维持 **一个常驻执行器进程**（python/run_executor.py）——
 * 它连接一次游戏，然后按 ok-script 框架原生的 TaskExecutor 循环轮询所有已启用的
 * 触发任务；一次性任务以入队方式交给同一个执行器跑一次。
 * 因此本类不再有「当前任务 / 单进程」语义，改为维护执行器会话与启用集合。
 */
