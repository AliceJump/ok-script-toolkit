import * as path from 'path';
import * as vscode from 'vscode';
import { isPathInsideRoot } from './saveToAssetsPure';
import { DEFAULT_POSITION_JSON, DEFAULT_POSITION_PY_DIR } from './positionPublishStore';

export type PositionPublishTargetKind = 'json' | 'python';
export type PositionPublishTargetSource = 'Project' | 'Workspace' | 'Personal' | 'Default';

export interface PositionPublishTargetSetting {
  key: 'positionJsonPath' | 'positionPythonDirectory';
  value: string;
  source: PositionPublishTargetSource;
  projectValue?: string;
  workspaceValue?: string;
  personalValue?: string;
}

const TARGET_SPECS = {
  json: { key: 'positionJsonPath' as const, fallback: DEFAULT_POSITION_JSON },
  python: { key: 'positionPythonDirectory' as const, fallback: DEFAULT_POSITION_PY_DIR },
};

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\\/g, '/') : undefined;
}

/** Resolve an explicitly configured Position target without letting package.json defaults mask its source. */
export function positionPublishTargetSetting(
  kind: PositionPublishTargetKind,
  folderUri: vscode.Uri,
): PositionPublishTargetSetting {
  const spec = TARGET_SPECS[kind];
  const inspected = vscode.workspace.getConfiguration('okScriptToolkit', folderUri).inspect<string>(spec.key);
  const projectValue = clean(inspected?.workspaceFolderValue);
  const workspaceValue = clean(inspected?.workspaceValue);
  const personalValue = clean(inspected?.globalValue);
  if (projectValue) return { ...spec, value: projectValue, source: 'Project', projectValue, workspaceValue, personalValue };
  if (workspaceValue) return { ...spec, value: workspaceValue, source: 'Workspace', projectValue, workspaceValue, personalValue };
  if (personalValue) return { ...spec, value: personalValue, source: 'Personal', projectValue, workspaceValue, personalValue };
  return { ...spec, value: spec.fallback, source: 'Default', projectValue, workspaceValue, personalValue };
}

export function positionPublishTargetInputError(
  value: string,
  projectRoot: string,
): string | undefined {
  const target = value.trim();
  if (!target) return 'Position output path is required.';
  if (path.isAbsolute(target)) return 'Position output path must be relative to the project root.';
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  if (resolvedTarget === resolvedRoot || !isPathInsideRoot(resolvedRoot, resolvedTarget)) {
    return 'Position output path must stay within the project root.';
  }
  return undefined;
}

/** Edit or clear a Project/Workspace/Personal override, then return to the caller's publish menu. */
export async function editPositionPublishTarget(
  kind: PositionPublishTargetKind,
  folderUri: vscode.Uri,
  projectRoot: string,
): Promise<void> {
  const current = positionPublishTargetSetting(kind, folderUri);
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit', folderUri);
  type Action = 'project' | 'workspace' | 'personal' | 'resetProject' | 'resetWorkspace' | 'resetPersonal';
  const items: Array<vscode.QuickPickItem & { action?: Action }> = [
    {
      label: 'Set for this project',
      description: 'Project override — highest priority',
      action: 'project',
    },
    {
      label: 'Set for this workspace',
      description: 'Used when this project has no folder-specific override',
      action: 'workspace',
    },
    {
      label: 'Set personal default',
      description: 'Used when no Project / Workspace override exists',
      action: 'personal',
    },
  ];
  if (current.projectValue || current.workspaceValue || current.personalValue) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }
  if (current.projectValue) {
    items.push({
      label: 'Reset project override',
      description: 'Fall back to Workspace → Personal → Default',
      action: 'resetProject',
    });
  }
  if (current.workspaceValue) {
    items.push({
      label: 'Reset workspace override',
      description: 'Fall back to Personal → Default when no project override exists',
      action: 'resetWorkspace',
    });
  }
  if (current.personalValue) {
    items.push({
      label: 'Reset personal default',
      description: 'Fall back to the built-in default when no project/workspace value exists',
      action: 'resetPersonal',
    });
  }

  const action = await vscode.window.showQuickPick(items, {
    placeHolder: kind === 'json' ? 'Configure Position JSON path' : 'Configure Position Python output directory',
  });
  if (!action?.action) return;
  if (action.action === 'resetProject') {
    await cfg.update(current.key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    return;
  }
  if (action.action === 'resetWorkspace') {
    await cfg.update(current.key, undefined, vscode.ConfigurationTarget.Workspace);
    return;
  }
  if (action.action === 'resetPersonal') {
    await cfg.update(current.key, undefined, vscode.ConfigurationTarget.Global);
    return;
  }

  const edited = await vscode.window.showInputBox({
    prompt: kind === 'json'
      ? 'Position JSON path (relative to project root)'
      : 'Position Python output directory (relative to project root)',
    value: current.value,
    validateInput: value => positionPublishTargetInputError(value, projectRoot),
  });
  if (edited === undefined) return;
  const normalized = edited.trim().replace(/\\/g, '/');
  const target = action.action === 'project'
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : action.action === 'workspace'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await cfg.update(current.key, normalized, target);
}
