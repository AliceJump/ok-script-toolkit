/**
 * 「项目约定 vs 我的设置」溯源视图。
 *
 * 解决的副作用（`docs/project-config.md` §3）：取值链把**个人偏好**排在最高，
 * 好处是"项目文件给团队开箱默认，我改过就用我的"；代价是**一旦我手动改过，
 * 项目声明的那一项就对我永久失效** —— 我看不到团队改了什么，界面上毫无提示。
 *
 * 本模块把「每一项的生效值来自哪一层」显式呈现，并提供「恢复为项目约定」
 * 把个人覆盖清掉，回到项目声明。
 *
 * ⚠️ **来源层不在这里重新算** —— 它由取值链本身产出
 * （`projectConfigPure.resolveSetting` 返回 `{ value, layer }`）。
 * 另写一套判断去复算的话迟早与实际生效值分叉，而那种分叉的表现是
 * "界面说来源是项目约定、实际生效的却是我的设置"，属最难查的一类不一致。
 *
 * 为什么是命令 + QuickPick，而不是把提示塞进设置界面：**VS Code 的设置界面不可扩展** ——
 * `contributes.configuration` 只能给静态 `description`，没法给某一项加动态的
 * "当前来自哪一层"或按钮。所以这个能力只能落在命令上（`package.json` 已登记）。
 */
import * as vscode from 'vscode';
import { tr } from './localization';
import {
  DEFAULT_FEATURE_ALIASES,
  DEFAULT_TEMPLATES_DIRECTORY,
  ProjectConfig,
  ResolvedSetting,
  SettingLayer,
  ideSetting,
  labelEnumAliasesResolved,
  labelEnumOf,
  loadProjectConfig,
  nonEmptyStrings,
  normalizeRelPath,
  templatesDirectoryResolved,
  templatesOf,
} from './projectConfig';

/** 溯源视图里的一行。 */
export interface ConventionSourceRow {
  /** 设置键名，如 `featureAliases` */
  key: string;
  /** 完整设置 id，如 `okScriptToolkit.featureAliases` */
  settingId: string;
  /** 生效值（展示用） */
  effective: string;
  /** 生效值来自哪一层 */
  layer: SettingLayer;
  /** 项目约定文件里声明的值；没声明为 `undefined`（展示用） */
  declared?: string;
  /** 内置兜底（展示用：让用户知道"恢复"之后会回到什么） */
  builtin: string;
  /** 是否有个人覆盖 —— 只有 `true` 才提供「恢复为项目约定」 */
  overridden: boolean;
}

function row<T>(args: {
  key: string;
  resolved: ResolvedSetting<T>;
  render: (value: T) => string;
  declared?: string;
  builtin: string;
}): ConventionSourceRow {
  return {
    key: args.key,
    settingId: `okScriptToolkit.${args.key}`,
    effective: args.render(args.resolved.value),
    layer: args.resolved.layer,
    declared: args.declared,
    builtin: args.builtin,
    // 由 layer 推出，而不是再比一次值 —— 保证"能恢复"与"来源是我的设置"永远一致
    overridden: args.resolved.layer === 'personal',
  };
}

/**
 * 参与取值链的**设置清单**。
 *
 * 加一组新设置时在这里补一行 —— 溯源视图靠它保持同步。
 * 目前只收录"个人偏好层来自 IDE 设置"的键：`labelEnumFile` 的个人偏好层是
 * `globalState` 里的"上次保存"（不是 IDE 设置），语义不同，暂不纳入。
 */
export function conventionSources(): ConventionSourceRow[] {
  const config: ProjectConfig = loadProjectConfig();

  const aliases = labelEnumAliasesResolved(
    config,
    ideSetting<string[]>('featureAliases'),
    DEFAULT_FEATURE_ALIASES,
  );
  const declaredAliases = nonEmptyStrings(labelEnumOf(config).aliases);

  const templates = templatesDirectoryResolved(
    config,
    ideSetting<string>('okTemplatesDirectory'),
    DEFAULT_TEMPLATES_DIRECTORY,
  );
  const declaredTemplates = normalizeRelPath(templatesOf(config).directory);

  return [
    row({
      key: 'featureAliases',
      resolved: aliases,
      render: (value) => value.join(', '),
      declared: declaredAliases.length ? declaredAliases.join(', ') : undefined,
      builtin: DEFAULT_FEATURE_ALIASES.join(', '),
    }),
    row({
      key: 'okTemplatesDirectory',
      resolved: templates,
      render: (value) => value,
      declared: declaredTemplates,
      builtin: DEFAULT_TEMPLATES_DIRECTORY,
    }),
  ];
}

/** 层的展示名。 */
export function layerLabel(layer: SettingLayer): string {
  if (layer === 'personal') return tr('My settings');
  if (layer === 'project') return tr('Project convention');
  return tr('Built-in default');
}

/**
 * 清掉某一项的个人覆盖，回到项目约定（没有项目声明时回到内置默认）。
 *
 * 三个作用域都要清：值可能写在「工作区文件夹」「工作区」或「用户」任一级，
 * 只清一级会留下一个仍然生效的覆盖 —— 用户点了"恢复"却发现没变，是最糟的反馈。
 */
export async function clearOverride(key: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
  const inspected = cfg.inspect(key);
  if (!inspected) return;
  if (inspected.workspaceFolderValue !== undefined && vscode.workspace.workspaceFolders?.length) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  if (inspected.workspaceValue !== undefined) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
  if (inspected.globalValue !== undefined) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

interface RowItem extends vscode.QuickPickItem {
  row: ConventionSourceRow;
}

const REVERT_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('discard'),
  tooltip: tr('Revert to project convention'),
};

/** 打开溯源视图。 */
export function showConventionSources(): void {
  const qp = vscode.window.createQuickPick<RowItem>();
  qp.title = tr('Project convention vs my settings');
  qp.placeholder = tr('Effective value and where it comes from. Use the button to drop your override.');
  qp.ignoreFocusOut = true;

  const refresh = () => {
    qp.items = conventionSources().map((r) => ({
      label: r.settingId,
      description: r.effective,
      detail:
        tr('Source: {layer}', { layer: layerLabel(r.layer) }) +
        '　·　' +
        (r.declared
          ? tr('Project file: {value}', { value: r.declared })
          : tr('Project file: not declared')) +
        '　·　' +
        tr('Built-in: {value}', { value: r.builtin }),
      row: r,
      buttons: r.overridden ? [REVERT_BUTTON] : [],
    }));
  };
  refresh();

  qp.onDidTriggerItemButton(async (e) => {
    const key = e.item.row.key;
    if (!key) return;
    qp.busy = true;
    try {
      await clearOverride(key);
      // 清完覆盖后生效值会变，必须**重读一遍再刷新** —— 直接改本地状态就成了第二份真相
      refresh();
      void vscode.window.showInformationMessage(tr('Reverted {key} to the project convention.', { key }));
    } finally {
      qp.busy = false;
    }
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}
