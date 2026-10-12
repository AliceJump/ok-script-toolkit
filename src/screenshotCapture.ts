import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { tr } from './localization';
import { resolveProjectDir } from './projectConfig';
import { ScreenshotWorker } from './screenshotWorker';

let captureWorker: ScreenshotWorker | undefined;
let captureWorkerKey = '';

export function disposeCaptureWorker(): void {
  captureWorker?.dispose();
  captureWorker = undefined;
}

let captureLogger: (message: string) => void = () => {};

export function setCaptureLogger(logger: (message: string) => void): void {
  captureLogger = logger;
}

/** 窗口配置（从项目 config.py 的 windows 子字典提取） */
export interface WindowConfig {
  exe?: string[];
  title?: string;
  hwnd_class?: string;
  top_hwnd_class?: string;
  /**
   * `config.py` 的 `template_matching.coco_feature_json` —— **运行时模板库**路径
   * （ok 框架自己也是读这一项）。相对项目根或绝对路径，原样返回、不做归一化。
   * 见 `cocoFeaturePathPure.ts` 的说明：它和素材面板的 `<模板目录>/coco_annotations.json`
   * 是两个不同的文件。
   */
  cocoFeatureJson?: string;
  /** Project template tab's enum module path, without a required .py suffix. */
  labelEnumRelativePath?: string;
}

/** probe_window_config.py 返回结构 */
interface ProbeWindowConfigResult {
  ok: boolean;
  error?: string;
  config_path?: string;
  exe?: string[];
  title?: string;
  hwnd_class?: string;
  top_hwnd_class?: string;
  coco_feature_json?: string | null;
  label_enum_relative_path?: string | null;
}

function windowConfigFromProbe(parsed: ProbeWindowConfigResult | undefined): WindowConfig | undefined {
  if (!parsed?.ok) return undefined;
  return {
    exe: parsed.exe, title: parsed.title, hwnd_class: parsed.hwnd_class, top_hwnd_class: parsed.top_hwnd_class,
    cocoFeatureJson: parsed.coco_feature_json ?? undefined,
    labelEnumRelativePath: parsed.label_enum_relative_path ?? undefined,
  };
}

function getCaptureWorker(pythonPath: string, scriptPath: string, projectDir = ''): ScreenshotWorker {
  const key = JSON.stringify([pythonPath, scriptPath, projectDir]);
  if (!captureWorker || captureWorkerKey !== key) {
    disposeCaptureWorker();
    captureWorkerKey = key;
    captureWorker = new ScreenshotWorker(pythonPath, scriptPath, projectDir, captureLogger);
  }
  return captureWorker;
}

/** 读取 okScriptToolkit 扩展配置中的项目路径和 Python 解释器 */
export function getProjectConfig(): { projectDir: string; pythonPath: string } {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
  // 项目根解析统一走 projectConfig.resolveProjectDir()：这里原先复制了一份与
  // taskLauncher.resolveProjectContext() 相同的逻辑，两处容易漂移。
  const projectDir = resolveProjectDir();
  const python = cfg.get<string>('okScriptPython') || '';
  let pythonPath = python;
  if (!pythonPath) {
    const venvPy = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
    pythonPath = fs.existsSync(venvPy) ? venvPy : 'python';
  }
  return { projectDir, pythonPath };
}

/** 读取项目 config.py 的窗口匹配配置（通过 Python AST 解析，不导入模块）。 */
export async function probeWindowConfig(projectDir: string, pythonPath: string): Promise<WindowConfig | undefined> {
  const scriptPath = path.join(path.dirname(__dirname), 'python', 'probe_window_config.py');
  if (!fs.existsSync(scriptPath)) return undefined;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(pythonPath, [scriptPath, projectDir], {
        timeout: 10000,
        encoding: 'utf-8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve(stdout || '');
      });
    });
    // 取最后一行 JSON
    const lines = result.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as ProbeWindowConfigResult;
        return windowConfigFromProbe(parsed);
      } catch { /* 跳过非 JSON 行 */ }
    }
  } catch { /* Python 不可用或脚本失败 */ }
  return undefined;
}

export type CaptureOutcome =
  | { ok: true }
  | { ok: false; reason: 'noScript' | 'cancelled' | 'failed'; error?: string };

/** 面板显示或执行器就绪时后台预热；失败只写日志，不影响任务或弹出输入框。 */
export async function prewarmScreenshotCapture(expectedProjectDir?: string, expectedPythonPath?: string): Promise<void> {
  try {
    const { projectDir, pythonPath } = getProjectConfig();
    if (!projectDir || !fs.existsSync(projectDir)
      || (expectedProjectDir !== undefined && expectedProjectDir !== projectDir)
      || (expectedPythonPath !== undefined && expectedPythonPath !== pythonPath)) return;
    const script = path.join(path.dirname(__dirname), 'python', 'capture_game_window.py');
    if (!fs.existsSync(script)) return;
    const method = vscode.workspace.getConfiguration('okScriptToolkit').get<string>('captureMethod') || 'auto';
    const started = Date.now();
    const frameReady = await getCaptureWorker(pythonPath, script, projectDir).prewarm(method);
    captureLogger(`[capture] warmup_ms=${Date.now() - started} frame_ready=${frameReady}`);
  } catch (error) {
    captureLogger(`[capture] warmup failed: ${String(error)}`);
  }
}

/**
 * 捕获游戏窗口到指定文件。
 *
 * 流程与标注管理面板的截图一致：优先从项目 config.py 自动读取窗口匹配信息，
 * 读取失败时回退到让用户输入窗口标题正则（取消则返回 cancelled）。
 * 只负责把图片写到 outputPath，落库/入库由调用方处理。
 */
export async function captureGameWindow(outputPath: string, methodOverride?: string): Promise<CaptureOutcome> {
  const started = Date.now();
  const { projectDir, pythonPath } = getProjectConfig();
  const captureScript = path.join(path.dirname(__dirname), 'python', 'capture_game_window.py');
  if (!fs.existsSync(captureScript)) return { ok: false, reason: 'noScript' };
  let windowConfig: WindowConfig | undefined;
  if (projectDir) {
    try {
      windowConfig = windowConfigFromProbe(await getCaptureWorker(pythonPath, captureScript, projectDir).probe() as ProbeWindowConfigResult);
    } catch (error) {
      captureLogger(`[capture] probe failed: ${String(error)}`);
      return { ok: false, reason: 'failed', error: String(error) };
    }
    captureLogger(`[capture] probe_ms=${Date.now() - started}`);
  }

  let titleRegex: string | undefined;
  let exeNames: string[] | undefined;
  let hwndClass: string | undefined;

  if (windowConfig && (windowConfig.exe || windowConfig.title || windowConfig.hwnd_class)) {
    exeNames = windowConfig.exe;
    titleRegex = windowConfig.title;
    hwndClass = windowConfig.hwnd_class;
    const desc = [
      exeNames ? `exe: ${exeNames.join(', ')}` : '',
      titleRegex ? `title: ${titleRegex}` : '',
      hwndClass ? `class: ${hwndClass}` : '',
    ].filter(Boolean).join(' | ');
    void vscode.window.showInformationMessage(tr('Auto-detected window config: {config}', { config: desc }));
  } else {
    titleRegex = await vscode.window.showInputBox({
      prompt: tr('Enter game window title pattern (regex), or leave empty for all windows'),
      placeHolder: tr('screenshotWindowPlaceholder'),
    });
    if (titleRegex === undefined) return { ok: false, reason: 'cancelled' };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const windowConfigJson = (exeNames || hwndClass || titleRegex)
    ? JSON.stringify({ exe: exeNames, title: titleRegex, hwnd_class: hwndClass })
    : undefined;

  return runCaptureScript(captureScript, outputPath, titleRegex, windowConfigJson, pythonPath, projectDir || undefined, methodOverride);
}

function runCaptureScript(
  scriptPath: string,
  outputPath: string,
  titlePattern: string | undefined,
  configJson?: string,
  pythonPath = 'python',
  projectDir?: string,
  methodOverride?: string,
): Promise<CaptureOutcome> {
  const method = methodOverride
    || vscode.workspace.getConfiguration('okScriptToolkit').get<string>('captureMethod')
    || 'auto';
  const worker = getCaptureWorker(pythonPath, scriptPath, projectDir);
  const started = Date.now();
  const windowConfig = configJson ? JSON.parse(configJson) : { title: titlePattern };
  return worker.capture(outputPath, windowConfig, method).then((): CaptureOutcome => {
    captureLogger(`[capture] request_ms=${Date.now() - started}`);
    if (!fs.existsSync(outputPath)) {
      return { ok: false, reason: 'failed', error: tr('Screenshot failed: file not created') };
    }
    return { ok: true };
  }, (error: Error): CaptureOutcome => {
    captureLogger(`[capture] ${error.message}`);
    return { ok: false, reason: 'failed', error: error.message };
  });
}
