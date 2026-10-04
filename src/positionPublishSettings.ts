import * as path from 'path';
import * as vscode from 'vscode';
import {
  ideSetting,
  loadProjectConfig,
  normalizeRelPath,
  resolveProjectDir,
  resolveSetting,
  setIdeSetting,
} from './projectConfig';
import { isPathInsideRoot } from './saveToAssetsPure';
import { DEFAULT_POSITION_JSON, DEFAULT_POSITION_PY_DIR } from './positionPublishStore';

export type PositionPublishTargetKind = 'json' | 'python';
export type PositionPublishTargetSource = 'Personal' | 'Project' | 'Default';

export interface PositionPublishTargetSetting {
  key: 'positionJsonPath' | 'positionPythonDirectory';
  value: string;
  source: PositionPublishTargetSource;
  personalValue?: string;
  projectValue?: string;
}

interface ProjectPositionConvention {
  jsonPath?: string;
  pythonDirectory?: string;
}

const TARGET_SPECS = {
  json: { key: 'positionJsonPath' as const, field: 'jsonPath' as const, fallback: DEFAULT_POSITION_JSON },
  python: { key: 'positionPythonDirectory' as const, field: 'pythonDirectory' as const, fallback: DEFAULT_POSITION_PY_DIR },
};

function projectConvention(kind: PositionPublishTargetKind, projectRoot: string): string | undefined {
  const config = loadProjectConfig(projectRoot) as ReturnType<typeof loadProjectConfig> & {
    position?: ProjectPositionConvention;
  };
  const value = config.position?.[TARGET_SPECS[kind].field];
  return normalizeRelPath(value);
}

/**
 * Resolve Position targets through the repository-wide convention chain:
 * personal IDE preference > ok-script-toolkit.json project convention > built-in default.
 */
export function positionPublishTargetSetting(
  kind: PositionPublishTargetKind,
  folderUri: vscode.Uri,
  projectRoot?: string,
): PositionPublishTargetSetting {
  const spec = TARGET_SPECS[kind];
  const root = projectRoot || resolveProjectDir() || folderUri.fsPath;
  const personalValue = normalizeRelPath(ideSetting<string>(spec.key, folderUri));
  const projectValue = projectConvention(kind, root);
  const resolved = resolveSetting(personalValue, projectValue, spec.fallback);
  const source: PositionPublishTargetSource = resolved.layer === 'personal'
    ? 'Personal'
    : resolved.layer === 'project'
      ? 'Project'
      : 'Default';
  return {
    key: spec.key,
    value: resolved.value,
    source,
    personalValue,
    projectValue,
  };
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

/** Edit or clear the user's IDE override; project conventions remain read-only, like every other convention field. */
export async function editPositionPublishTarget(
  kind: PositionPublishTargetKind,
  folderUri: vscode.Uri,
  projectRoot: string,
): Promise<void> {
  const current = positionPublishTargetSetting(kind, folderUri, projectRoot);
  type Action = 'personal' | 'resetPersonal';
  const items: Array<vscode.QuickPickItem & { action?: Action }> = [
    {
      label: 'Set my override',
      description: `Personal preference — highest priority · current: ${current.value}`,
      action: 'personal',
    },
  ];
  if (current.personalValue) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: 'Reset my override',
      description: 'Fall back to Project convention → Default',
      action: 'resetPersonal',
    });
  }

  const action = await vscode.window.showQuickPick(items, {
    placeHolder: kind === 'json'
      ? `Configure Position JSON path · ${current.source}`
      : `Configure Position Python output directory · ${current.source}`,
  });
  if (!action?.action) return;
  if (action.action === 'resetPersonal') {
    await setIdeSetting(current.key, undefined, folderUri);
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
  await setIdeSetting(current.key, edited.trim().replace(/\\/g, '/'), folderUri);
}
