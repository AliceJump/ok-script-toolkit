import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConsoleViewProvider } from '../consolePanel';
import { injectWebviewLocalization, tr } from '../localization';
import { applySharedAssets, errorPage, getNonce } from '../webviewHtml';
import type { RunTreeNode } from './treeModel';
import type { RunTreeDataProvider } from './runTree';

/** Parameters inspector: follows the Run tree selection. */
export class ParamsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'okScriptToolkit.params';

  private view?: vscode.WebviewView;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: ConsoleViewProvider,
    private readonly runTree: RunTreeDataProvider,
  ) {
    this.subs.push(runTree.onDidChangeSelection((node) => void this.showNode(node)));
    this.subs.push(backend.onDidChangeTree(() => void this.showNode(runTree.getSelection())));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media', 'params'),
        vscode.Uri.joinPath(this.extensionUri, 'media', 'console'),
        vscode.Uri.joinPath(this.extensionUri, 'media', 'shared'),
      ],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        await this.showNode(this.runTree.getSelection());
        return;
      }
      if (msg?.type === 'save' && msg.key && msg.values && typeof msg.values === 'object') {
        if (msg.target === 'global') {
          for (const [k, v] of Object.entries(msg.values as Record<string, unknown>)) {
            this.backend.setGlobalParam(String(msg.key), k, v);
          }
        } else {
          await this.backend.saveTaskParams(String(msg.key), msg.values as Record<string, unknown>);
        }
      }
    });
  }

  async openForNode(node: RunTreeNode | undefined): Promise<void> {
    await vscode.commands.executeCommand(`${ParamsViewProvider.viewType}.focus`);
    await this.showNode(node);
  }

  private async showNode(node: RunTreeNode | undefined): Promise<void> {
    const webview = this.view?.webview;
    if (!webview) return;
    if (!node || (node.kind !== 'task' && node.kind !== 'trigger' && node.kind !== 'globalGroup')) {
      void webview.postMessage({ type: 'clear' });
      return;
    }
    if (node.kind === 'globalGroup' && node.groupName) {
      const group = this.backend.getGlobalGroup(node.groupName);
      const snap = this.backend.getRunSnapshot();
      void webview.postMessage({
        type: 'params',
        target: 'global',
        key: node.groupName,
        title: group?.displayName || node.groupName,
        subtitle: node.groupName,
        statusText: tr('paramsSandboxHint'),
        fields: group?.fields || [],
        values: snap.globalSnapshots[node.groupName] || {},
      });
      return;
    }
    if (!node.taskKey) {
      void webview.postMessage({ type: 'clear' });
      return;
    }
    const task = this.backend.getTaskByKey(node.taskKey);
    const schema = this.backend.getSchema(node.taskKey);
    const config = this.backend.getTaskConfig(node.taskKey);
    void webview.postMessage({
      type: 'params',
      target: 'task',
      key: node.taskKey,
      title: task?.displayName || node.label,
      subtitle: node.taskKey,
      statusText: tr('paramsSandboxHint'),
      fields: schema?.fields || [],
      values: config?.params || {},
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'params', 'index.html');
    let html = '';
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch (e) {
      return errorPage(tr('Error'), tr('Unable to read view file: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    const resource = (folder: string, name: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', folder, name),
    ).toString(true);
    return injectWebviewLocalization(applySharedAssets(webview, this.extensionUri, html
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('params', 'params.css'))
      .split('__FIELDS_SCRIPT_URI__').join(resource('console', 'fields.js'))
      .split('__CONFIG_PANEL_SCRIPT_URI__').join(resource('console', 'configPanel.js'))
      .split('__APP_SCRIPT_URI__').join(resource('params', 'app.js')),
    ));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
