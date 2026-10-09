import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { tr } from './localization';
import { resolveProjectDir, templatesDirectory } from './projectConfig';
import { captureGameWindow } from './screenshotCapture';

/**
 * Capture directly into the template authoring directory without revealing an IDE panel.
 *
 * The system-wide hotkey uses this path so pressing Ctrl+Alt+S while the game is focused
 * does not bring VS Code to the foreground before capture. The actual window capture still
 * goes through the same captureGameWindow implementation used by the normal asset panel.
 */
export async function captureTemplateScreenshotInBackground(): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(tr('No workspace folder open.'));
    return false;
  }

  const projectRoot = resolveProjectDir() || folder.uri.fsPath;
  const outputDir = path.join(projectRoot, templatesDirectory(projectRoot));
  fs.mkdirSync(outputDir, { recursive: true });

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const outputPath = path.join(outputDir, `screenshot_${ts}.png`);

  const outcome = await captureGameWindow(outputPath);
  if (!outcome.ok) {
    if (outcome.reason === 'noScript') {
      void vscode.window.showErrorMessage(tr('Screenshot script not found. capture_game_window.py is missing from the extension.'));
    } else if (outcome.reason === 'failed') {
      void vscode.window.showErrorMessage(tr('Screenshot failed: {error}', { error: outcome.error || '' }));
    }
    return false;
  }

  void vscode.window.showInformationMessage(tr('Screenshot saved: {name}', { name: path.basename(outputPath) }));
  return true;
}
