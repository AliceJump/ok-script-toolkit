import * as vscode from 'vscode';
import { activate as activateCore, deactivate as deactivateCore } from './extension';
import { resolveProjectDir } from './projectConfig';

const WALKTHROUGH_ID = 'okScriptToolkit.getStarted';
const PROJECT_READY_CONTEXT = 'okScriptToolkit.projectReady';

export function activate(context: vscode.ExtensionContext): void {
  activateCore(context);

  const updateProjectReady = () => vscode.commands.executeCommand(
    'setContext',
    PROJECT_READY_CONTEXT,
    resolveProjectDir().length > 0,
  );

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
  );

  void updateProjectReady();
}

export function deactivate(): void {
  deactivateCore();
}
