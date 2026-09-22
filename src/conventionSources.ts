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
  DEFAULT_AVATAR_TEMPLATE_REGEX,
  DEFAULT_CHARACTER_LOCALE_FILE,
  DEFAULT_CHARACTER_MASTER_FILE,
  DEFAULT_CHARACTER_PROJECT_PATH,
  DEFAULT_CHARACTER_SKILLS_DIRECTORY,
  DEFAULT_EFFECTS_FILE,
  DEFAULT_FEATURE_ALIASES,
  DEFAULT_I18N_ENABLED,
  DEFAULT_LABEL_ENUM_NAME,
  DEFAULT_LABEL_ENUM_PATH,
  DEFAULT_LANG_DIRECTORY,
  DEFAULT_PO_DIRECTORY,
  DEFAULT_PO_DOMAINS,
  DEFAULT_TEMPLATES_DIRECTORY,
  ProjectConfig,
  ResolvedSetting,
  SettingLayer,
  charactersAvatarTemplateRegexResolved,
  charactersLocaleFileResolved,
  charactersMasterFileResolved,
  charactersProjectPathResolved,
  charactersSkillsDirectoryResolved,
  currentWorkspaceFolderUri,
  effectsFileResolved,
  i18nEnabledResolved,
  i18nLangDirectoryResolved,
  i18nPoDirectoryResolved,
  i18nPoDomainsResolved,
  ideSetting,
  labelEnumAliasesResolved,
  labelEnumNameResolved,
  labelEnumPathResolved,
  loadProjectConfig,
  templatesDirectoryResolved,
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
 * 造一行。`resolve` 由调用方传进来（绑好 config），三样展示值都从**同一条链**取。
 *
 * `declared`（项目文件里到底写了什么）**不是另读一遍配置对象得来的**，而是
 * 把个人偏好置空、**再跑一次同一条链**：命中的是 `builtin` 层就说明项目没声明。
 * 这样展示出来的值与生效值走的是同一套归一化与类型判断，不会出现
 * "面板显示 `assets\lang`、实际按 `assets/lang` 匹配"那种错位 —— 手写文件里
 * 多一个反斜杠就会踩到，而且两边看起来都"正常"。
 *
 * 传入 `scope`（工作区文件夹 URI）时，`ideSetting` 的读取会限定在该文件夹作用域内，
 * 防止 A 项目的值串到 B 项目（枚举路径/类名需要此行为）。
 */
function rowOf<T>(args: {
  key: string;
  resolve: (ideValue: unknown, fallback: T) => ResolvedSetting<T>;
  fallback: T;
  render: (value: T) => string;
  scope?: vscode.Uri;
}): ConventionSourceRow {
  const probe = args.resolve(undefined, args.fallback);
  return row({
    key: args.key,
    resolved: args.resolve(ideSetting(args.key, args.scope), args.fallback),
    render: args.render,
    declared: probe.layer === 'builtin' ? undefined : args.render(probe.value),
    builtin: args.render(args.fallback),
  });
}

const joinList = (value: string[]): string => value.join(', ');
const asText = (value: string): string => value;
const asBool = (value: boolean): string => String(value);

/**
 * 参与取值链的**设置清单**。
 *
 * 加一组新设置时在这里补一行 —— 溯源视图靠它保持同步，测试会拿这些键名
 * 逐个去 `package.json` 里核对（拼错键名不报错，只会让「恢复」静默失效）。
 *
 * 只收录"个人偏好层来自 IDE 设置"的键。`labelEnumPath` / `labelEnumName` 现在也在
 * 其中 —— 它们的个人偏好层以前是 `globalState` 里的"上次保存"（不是 IDE 设置、
 * 界面上看不见、跨项目串味），已升级成正式设置，所以纳入。
 *
 * 键名是 IDE 设置名，不是项目约定文件里的字段名 —— 两者**刻意允许不同名**
 * （`enablePoData` ↔ `i18n.enabled`：前者是"我这台机器要不要读它"，
 * 后者是"这个项目的 i18n 长什么样"）。面板按设置名成行，用户能直接去设置界面找。
 * `labelEnumPath` / `labelEnumName` 是**同名**的一对：两边语义相同，分名反而要用户多记一个词。
 */
export function conventionSources(): ConventionSourceRow[] {
  const config: ProjectConfig = loadProjectConfig();
  const folderUri = currentWorkspaceFolderUri();
  const resolve = <T>(fn: (c: ProjectConfig, ide: unknown, fallback: T) => ResolvedSetting<T>) =>
    (ideValue: unknown, fallback: T) => fn(config, ideValue, fallback);

  return [
    rowOf({
      key: 'featureAliases',
      resolve: resolve(labelEnumAliasesResolved),
      fallback: DEFAULT_FEATURE_ALIASES,
      render: joinList,
    }),
    // 枚举路径 / 类名的兜底层**不是常量**：
    //   - 路径的兜底是"没指定"（空串），消费端据此跳过生成；
    //   - 类名的兜底是"用文件名推导"，要拿到文件路径才能求值 —— 面板拿不到，
    //     所以链上用空串占位、由 `render` 说清"这一层到底会做什么"。
    // 两者都必须渲染成一句人话：QuickPick 里一段空白看着像坏了
    // （与 `characterProjectPath` 的空兜底同样处理）。
    //
    // ⚠️ 枚举路径/类名必须绑定当前工作区文件夹 URI，防止 A 项目的值串到 B 项目。
    rowOf({
      key: 'labelEnumPath',
      resolve: (ideValue) => labelEnumPathResolved(config, ideValue),
      fallback: DEFAULT_LABEL_ENUM_PATH,
      render: (value) => value || tr('Not set — ask on save'),
      scope: folderUri,
    }),
    rowOf({
      key: 'labelEnumName',
      resolve: (ideValue) => labelEnumNameResolved(config, ideValue, DEFAULT_LABEL_ENUM_NAME),
      fallback: DEFAULT_LABEL_ENUM_NAME,
      render: (value) => value || tr('Derived from the file name'),
      scope: folderUri,
    }),
    rowOf({
      key: 'okTemplatesDirectory',
      resolve: resolve(templatesDirectoryResolved),
      fallback: DEFAULT_TEMPLATES_DIRECTORY,
      render: asText,
    }),
    rowOf({
      key: 'enablePoData',
      resolve: resolve(i18nEnabledResolved),
      fallback: DEFAULT_I18N_ENABLED,
      render: asBool,
    }),
    rowOf({
      key: 'langDirectory',
      resolve: resolve(i18nLangDirectoryResolved),
      fallback: DEFAULT_LANG_DIRECTORY,
      render: asText,
    }),
    rowOf({
      key: 'poDirectory',
      resolve: resolve(i18nPoDirectoryResolved),
      fallback: DEFAULT_PO_DIRECTORY,
      render: asText,
    }),
    rowOf({
      key: 'poDomains',
      resolve: resolve(i18nPoDomainsResolved),
      fallback: DEFAULT_PO_DOMAINS,
      render: joinList,
    }),
    rowOf({
      key: 'characterProjectPath',
      resolve: resolve(charactersProjectPathResolved),
      fallback: DEFAULT_CHARACTER_PROJECT_PATH,
      // 兜底是**空串**（含义：与当前项目相同）。空值在面板上会显示成一个空白，
      // 看着像坏了，所以这里渲染成一句人话。
      render: (value) => value || tr('Same as the current project'),
    }),
    rowOf({
      key: 'characterMasterFile',
      resolve: resolve(charactersMasterFileResolved),
      fallback: DEFAULT_CHARACTER_MASTER_FILE,
      render: asText,
    }),
    rowOf({
      key: 'characterSkillsDirectory',
      resolve: resolve(charactersSkillsDirectoryResolved),
      fallback: DEFAULT_CHARACTER_SKILLS_DIRECTORY,
      render: asText,
    }),
    rowOf({
      key: 'characterLocaleFile',
      resolve: resolve(charactersLocaleFileResolved),
      fallback: DEFAULT_CHARACTER_LOCALE_FILE,
      render: asText,
    }),
    rowOf({
      key: 'characterAvatarTemplateRegex',
      resolve: resolve(charactersAvatarTemplateRegexResolved),
      fallback: DEFAULT_AVATAR_TEMPLATE_REGEX,
      render: asText,
    }),
    rowOf({
      key: 'effectsFile',
      resolve: resolve(effectsFileResolved),
      fallback: DEFAULT_EFFECTS_FILE,
      render: asText,
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
 *
 * 工作区文件夹级的读写**必须使用当前工作区文件夹的 URI** 作为资源作用域，
 * 以确保 `inspect()` 返回的是当前文件夹的覆盖值，`update()` 也写入正确的文件夹。
 */
export async function clearOverride(key: string): Promise<void> {
  const folderUri = currentWorkspaceFolderUri();
  const cfg = folderUri
    ? vscode.workspace.getConfiguration('okScriptToolkit', folderUri)
    : vscode.workspace.getConfiguration('okScriptToolkit');
  const inspected = cfg.inspect(key);
  if (!inspected) return;
  if (inspected.workspaceFolderValue !== undefined && folderUri) {
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
