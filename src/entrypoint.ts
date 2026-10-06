import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate as activateCore, deactivate as deactivateCore } from './extension';
import { resolveProjectDir } from './projectConfig';

const WALKTHROUGH_ID = 'okScriptToolkit.getStarted';
const PROJECT_READY_CONTEXT = 'okScriptToolkit.projectReady';

function isSupportedProject(projectDir: string): boolean {
  if (!projectDir) return false;
  try {
    if (!fs.statSync(projectDir).isDirectory()) return false;
  } catch {
    return false;
  }

  return [
    path.join(projectDir, 'config.py'),
    path.join(projectDir, 'src', 'config.py'),
  ].some((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  activateCore(context);

  const updateProjectReady = () => vscode.commands.executeCommand(
    'setContext',
    PROJECT_READY_CONTEXT,
    isSupportedProject(resolveProjectDir()),
  );

  const rootConfigWatcher = vscode.workspace.createFileSystemWatcher('**/config.py');
  const srcConfigWatcher = vscode.workspace.createFileSystemWatcher('**/src/config.py');

  context.subscriptions.push(
    vscode.commands.registerCommand('okScriptToolkit.openGettingStarted', () => {
      const walkthrough = `${context.extension.id}#${WALKTHROUGH_ID}`;
      return vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthrough);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openResourcePublisher', () => {
      return vscode.commands.executeCommand('okScriptToolkit.openTemplateAssets');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void updateProjectReady(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('okScriptToolkit.okScriptProjectPath')) {
        void updateProjectReady();
      }
    }),
    rootConfigWatcher,
    rootConfigWatcher.onDidCreate(() => { void updateProjectReady(); }),
    rootConfigWatcher.onDidDelete(() => { void updateProjectReady(); }),
    srcConfigWatcher,
    srcConfigWatcher.onDidCreate(() => { void updateProjectReady(); }),
    srcConfigWatcher.onDidDelete(() => { void updateProjectReady(); }),
  );

  void updateProjectReady();
}

export function deactivate(): void {
  deactivateCore();
}
