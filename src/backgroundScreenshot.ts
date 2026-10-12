import * as path from 'path';
import * as vscode from 'vscode';
import { tr } from './localization';
import { captureGameWindow } from './screenshotCapture';
import type { TempScreenshotStore } from './tempScreenshotStore';

let captureInProgress = false;
let inboxStore: TempScreenshotStore | undefined;

/** Bind the Resources inbox store so the system-wide hotkey can land shots there. */
export function bindInboxScreenshotStore(store: TempScreenshotStore): void {
  inboxStore = store;
}

/**
 * Capture into the Resources inbox without revealing an IDE panel.
 *
 * The system-wide hotkey uses this path so pressing Ctrl+Alt+S while the game is focused
 * does not bring VS Code to the foreground before capture. Destination is the same temp
 * screenshot store that `captureToInbox` uses (lossless BMP), not the old templates-only path.
 */
export async function captureInboxScreenshotInBackground(): Promise<boolean> {
  if (captureInProgress) return false;
  captureInProgress = true;
  try {
    return await captureScreenshot();
  } catch (error) {
    void vscode.window.showErrorMessage(tr('Screenshot failed: {error}', { error: String(error) }));
    return false;
  } finally {
    captureInProgress = false;
  }
}

/** @deprecated Use {@link captureInboxScreenshotInBackground}; kept as an alias for older callers/tests. */
export async function captureTemplateScreenshotInBackground(): Promise<boolean> {
  return captureInboxScreenshotInBackground();
}

async function captureScreenshot(): Promise<boolean> {
  if (!inboxStore) {
    void vscode.window.showWarningMessage(tr('Screenshot inbox is not ready.'));
    return false;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(tr('No workspace folder open.'));
    return false;
  }

  const outputPath = inboxStore.newFilePath('bmp');
  const outcome = await captureGameWindow(outputPath);
  if (!outcome.ok) {
    if (outcome.reason === 'noScript') {
      void vscode.window.showErrorMessage(tr('Screenshot script not found. capture_game_window.py is missing from the extension.'));
    } else if (outcome.reason === 'failed') {
      void vscode.window.showErrorMessage(tr('Screenshot failed: {error}', { error: outcome.error || '' }));
    }
    return false;
  }

  inboxStore.register(outputPath);
  void vscode.window.showInformationMessage(tr('Screenshot saved to inbox: {name}', { name: path.basename(outputPath) }));
  return true;
}
