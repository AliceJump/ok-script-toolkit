import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate as activateCore, deactivate as deactivateCore } from './extension';
import { GlobalScreenshotHotkey } from './globalScreenshotHotkey';
import { resolveProjectDir } from './projectConfig';
import { getProjectConfig } from './screenshotCapture';

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

  const globalScreenshotHotkey = new GlobalScreenshotHotkey(
    context.extensionPath,
    () => getProjectConfig().pythonPath,
    () => { void vscode.commands.executeCommand('okScriptToolkit.screenshotToTemplate'); },
  );

  const updateProjectReady = () => vscode.commands.executeCommand(
    'setContext',
    PROJECT_READY_CONTEXT,
    isSupportedProject(resolveProjectDir()),
  );

  let configWatcherDisposables: vscode.Disposable[] = [];

  const disposeConfigWatchers = () => {
    for (const disposable of configWatcherDisposables) disposable.dispose();
    configWatcherDisposables = [];
  };

  const addConfigWatcher = (pattern: string | vscode.RelativePattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    configWatcherDisposables.push(
      watcher,
      watcher.onDidCreate(() => { void updateProjectReady(); }),
      watcher.onDidDelete(() => { void updateProjectReady(); }),
    );
  };

  const bindConfigWatchers = () => {
    disposeConfigWatchers();

    // Workspace globs keep automatic project detection responsive.
    addConfigWatcher('**/config.py');
    addConfigWatcher('**/src/config.py');

    // A configured project may live outside the open workspace. String globs only
    // watch workspace folders, so bind additional RelativePatterns to that directory.
    const configuredPath = vscode.workspace
      .getConfiguration('okScriptToolkit')
      .get<string>('okScriptProjectPath')
      ?.trim();
    if (configuredPath) {
      const configuredProjectDir = resolveProjectDir();
      if (configuredProjectDir) {
        addConfigWatcher(new vscode.RelativePattern(configuredProjectDir, 'config.py'));
        addConfigWatcher(new vscode.RelativePattern(configuredProjectDir, 'src/config.py'));
      }
    }
  };

  bindConfigWatchers();

  context.subscriptions.push(
    vscode.commands.registerCommand('okScriptToolkit.openGettingStarted', () => {
      const walkthrough = `${context.extension.id}#${WALKTHROUGH_ID}`;
      return vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthrough);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openResourcePublisher', () => {
      return vscode.commands.executeCommand('okScriptToolkit.openTemplateAssets');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      bindConfigWatchers();
      void updateProjectReady();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const projectPathChanged = event.affectsConfiguration('okScriptToolkit.okScriptProjectPath');
      if (projectPathChanged) {
        bindConfigWatchers();
        void updateProjectReady();
      }
      if (projectPathChanged || event.affectsConfiguration('okScriptToolkit.okScriptPython')) {
        globalScreenshotHotkey.restart();
      }
    }),
    new vscode.Disposable(disposeConfigWatchers),
    globalScreenshotHotkey,
  );

  void updateProjectReady();
}

export function deactivate(): void {
  deactivateCore();
}
