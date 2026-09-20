import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { tr } from './localization';
import { resolveProjectDir } from './projectConfig';

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
        if (parsed.ok) {
          return {
            exe: parsed.exe,
            title: parsed.title,
            hwnd_class: parsed.hwnd_class,
            top_hwnd_class: parsed.top_hwnd_class,
            // 探针解不出来时给的是 `null`（AST 里掺了变量），这里归一成 `undefined`
            cocoFeatureJson: parsed.coco_feature_json ?? undefined,
          };
        }
        return undefined;
      } catch { /* 跳过非 JSON 行 */ }
    }
  } catch { /* Python 不可用或脚本失败 */ }
  return undefined;
}

export type CaptureOutcome =
  | { ok: true }
  | { ok: false; reason: 'noScript' | 'cancelled' | 'failed'; error?: string };

/**
 * 捕获游戏窗口到指定文件。
 *
 * 流程与标注管理面板的截图一致：优先从项目 config.py 自动读取窗口匹配信息，
 * 读取失败时回退到让用户输入窗口标题正则（取消则返回 cancelled）。
 * 只负责把图片写到 outputPath，落库/入库由调用方处理。
 */
export async function captureGameWindow(outputPath: string, methodOverride?: string): Promise<CaptureOutcome> {
  const { projectDir, pythonPath } = getProjectConfig();
  let windowConfig: WindowConfig | undefined;
  if (projectDir) {
    windowConfig = await probeWindowConfig(projectDir, pythonPath);
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

  const captureScript = path.join(path.dirname(__dirname), 'python', 'capture_game_window.py');
  if (!fs.existsSync(captureScript)) {
    return { ok: false, reason: 'noScript' };
  }

  const windowConfigJson = (exeNames || hwndClass || titleRegex)
    ? JSON.stringify({ exe: exeNames, title: titleRegex, hwnd_class: hwndClass })
    : undefined;

  return runCaptureScript(captureScript, outputPath, titleRegex, windowConfigJson, projectDir || undefined, methodOverride);
}

function runCaptureScript(
  scriptPath: string,
  outputPath: string,
  titlePattern: string | undefined,
  configJson?: string,
  projectDir?: string,
  methodOverride?: string,
): Promise<CaptureOutcome> {
  return new Promise<CaptureOutcome>((resolve) => {
    const args: string[] = [scriptPath, outputPath];
    if (configJson) {
      args.push('--config-json', configJson);
    } else if (titlePattern) {
      args.push(titlePattern);
    }
    if (projectDir) {
      args.push('--project-dir', projectDir);
    }

    const method = methodOverride
      || vscode.workspace.getConfiguration('okScriptToolkit').get<string>('captureMethod')
      || 'auto';
    args.push('--method', method);

    const { pythonPath } = getProjectConfig();
    execFile(pythonPath, args, { timeout: 30000 }, (error) => {
      if (error) {
        resolve({ ok: false, reason: 'failed', error: error.message });
        return;
      }
      if (!fs.existsSync(outputPath)) {
        resolve({ ok: false, reason: 'failed', error: tr('Screenshot failed: file not created') });
        return;
      }
      resolve({ ok: true });
    });
  });
}
