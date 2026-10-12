import * as vscode from 'vscode';
import { ConsoleViewProvider } from '../consolePanel';
import { buildRunTree, RunTreeNode, taskKeyOf } from './treeModel';
import { tr } from '../localization';

/** Map tree model nodes to VS Code TreeItems for the Run view. */
export class RunTreeDataProvider implements vscode.TreeDataProvider<RunTreeNode>, vscode.Disposable {
  static readonly viewId = 'okScriptToolkit.run';

  private readonly changeEmitter = new vscode.EventEmitter<RunTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private roots: RunTreeNode[] = [];
  private readonly byId = new Map<string, RunTreeNode>();
  private selection: RunTreeNode | undefined;
  private readonly selectionEmitter = new vscode.EventEmitter<RunTreeNode | undefined>();
  readonly onDidChangeSelection = this.selectionEmitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private treeView?: vscode.TreeView<RunTreeNode>;

  constructor(private readonly backend: ConsoleViewProvider) {
    this.subs.push(backend.onDidChangeTree(() => this.refresh()));
    this.subs.push(backend.onDidChangeExecutorState(() => this.refresh()));
  }

  attachTreeView(view: vscode.TreeView<RunTreeNode>): void {
    this.treeView = view;
    this.subs.push(view.onDidChangeSelection((e) => {
      this.selection = e.selection[0];
      this.selectionEmitter.fire(this.selection);
    }));
    this.subs.push(view.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        if (node.taskKey && node.checkbox) {
          await this.backend.setTriggerEnabledByKey(
            node.taskKey,
            state === vscode.TreeItemCheckboxState.Checked,
          );
        }
      }
    }));
  }

  refresh(): void {
    const snap = this.backend.getRunSnapshot();
    const exec = this.backend.executorState();
    this.roots = buildRunTree({
      game: snap.game,
      executor: exec,
      tasks: snap.tasks,
      schemas: snap.schemas,
      enabledTriggers: snap.enabledTriggers,
      currentTaskKey: snap.currentTaskKey,
      onetimeQueue: snap.onetimeQueue,
      globalGroups: snap.globalGroups,
      globalOverrides: snap.globalSnapshots,
      accounts: {
        available: snap.multiAccount.available,
        names: snap.accountNames,
        active: undefined,
      },
    });
    this.byId.clear();
    const walk = (nodes: RunTreeNode[]) => {
      for (const n of nodes) {
        this.byId.set(n.id, n);
        if (n.children) walk(n.children);
      }
    };
    walk(this.roots);
    this.changeEmitter.fire();
    this.updateBadge(exec);
  }

  private updateBadge(exec: { status: string; queued: number; current: string }): void {
    if (!this.treeView) return;
    const n = (exec.status === 'running' && exec.current ? 1 : 0) + exec.queued;
    this.treeView.badge = n > 0
      ? { value: n, tooltip: tr('Running / queued tasks') }
      : undefined;
  }

  getTreeItem(element: RunTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.collapsible
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.id;
    item.description = element.description;
    item.contextValue = element.contextValue;
    if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
    if (element.checkbox) {
      item.checkboxState = element.checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    if (element.kind === 'task' || element.kind === 'trigger') {
      item.command = {
        command: 'okScriptToolkit.run.openParams',
        title: tr('Open Parameters'),
        arguments: [element],
      };
    }
    return item;
  }

  getChildren(element?: RunTreeNode): RunTreeNode[] {
    if (!element) return this.roots;
    return element.children || [];
  }

  getParent(element: RunTreeNode): RunTreeNode | undefined {
    for (const root of this.roots) {
      if (root.children?.includes(element)) return root;
      for (const child of root.children || []) {
        if (child.children?.includes(element)) return child;
      }
    }
    return undefined;
  }

  getNode(id: string): RunTreeNode | undefined {
    return this.byId.get(id);
  }

  getSelection(): RunTreeNode | undefined {
    return this.selection;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.selectionEmitter.dispose();
    for (const s of this.subs) s.dispose();
  }
}
