#!/usr/bin/env node
/**
 * 「项目约定 vs 我的设置」溯源视图测试（`src/conventionSources.ts`）。
 *
 * 背景（`docs/project-config.md` §3）：取值链把**个人偏好**排最高，好处是
 * "项目文件给团队开箱默认、我改过就用我的"；代价是**一旦我手动改过，项目声明的
 * 那一项就对我永久失效** —— 界面上毫无提示。这个视图就是那个缓冲：显式告诉
 * 用户"当前值来自哪一层"，并允许一键回到项目约定。
 *
 * 这里必须用 vscode 桩：`conventionSources()` 的"个人偏好"层来自 IDE 设置，
 * 天然要读 `workspace.getConfiguration(...).inspect()`。桩故意把
 * 「用户写入的值」与「package.json 的 default」分开存放 —— 这正是被测逻辑
 * 赖以工作的前提（`get()` 会把 default 一并返回，从而永远遮蔽项目声明）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

// ── vscode 桩 ────────────────────────────────────────────────────────
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-vscode-stub-'));
const VSCODE_STUB = path.join(stubDir, 'vscode.js');
fs.writeFileSync(
  VSCODE_STUB,
  `'use strict';
// 只提供被测代码真正用到的那一小块 API。
const writes = [];            // 记录 update() 调用，用来断言"只清了有值的层级"
const overrides = new Map();  // key -> { global, workspace, workspaceFolder }（= 用户真正写过的值）
const defaults = new Map();   // key -> package.json 里的 default（**不是**用户设置）
const infoMessages = [];
// 记录 getConfiguration 的调用参数，用于断言资源作用域行为
const getConfigCalls = [];

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
class ThemeIcon { constructor(id) { this.id = id; } }

function t(message, args) {
  if (!args) return message;
  return String(message).replace(/\\{(\\w+)\\}/g, (all, name) => (name in args ? String(args[name]) : all));
}

// 资源作用域感知的 getConfiguration 桩
// scope 为 { uri: { fsPath: '...' } } 时，inspect() 仍然返回所有层级，
// 但 get() 只返回该文件夹作用域内的值（模拟 VS Code 的真实行为）
function getConfiguration(section, scope) {
  getConfigCalls.push({ section, scope });
  return {
    get(key) {
      const s = overrides.get(key) || {};
      // 有 scope 时只返回该文件夹作用域的值（模拟 VS Code 的资源作用域行为）
      if (scope) {
        return s.workspaceFolder;
      }
      if (s.workspaceFolder !== undefined) return s.workspaceFolder;
      if (s.workspace !== undefined) return s.workspace;
      if (s.global !== undefined) return s.global;
      return defaults.get(key);
    },
    inspect(key) {
      const s = overrides.get(key) || {};
      // 无论是否有 scope，inspect() 都返回所有层级的值
      // 这是 VS Code 的真实行为：inspect 总是返回完整的层级信息
      return {
        key,
        defaultValue: defaults.get(key),
        globalValue: s.global,
        workspaceValue: s.workspace,
        workspaceFolderValue: s.workspaceFolder,
      };
    },
    update(key, value, target) {
      writes.push({ key, value, target, scope });
      const s = overrides.get(key) || {};
      const field =
        target === ConfigurationTarget.Global ? 'global'
        : target === ConfigurationTarget.Workspace ? 'workspace'
        : 'workspaceFolder';
      if (value === undefined) delete s[field];
      else s[field] = value;
      overrides.set(key, s);
      return Promise.resolve();
    },
  };
}

// QuickPick 桩：把 onDidTriggerItemButton 的回调存下来，由测试主动触发。
const quickPicks = [];
function createQuickPick() {
  const qp = {
    title: '', placeholder: '', ignoreFocusOut: false, busy: false, items: [],
    _buttonHandler: null, _hideHandler: null, shown: false, disposed: false,
    onDidTriggerItemButton(cb) { qp._buttonHandler = cb; },
    onDidHide(cb) { qp._hideHandler = cb; },
    show() { qp.shown = true; },
    dispose() { qp.disposed = true; },
  };
  quickPicks.push(qp);
  return qp;
}

module.exports = {
  ConfigurationTarget,
  ThemeIcon,
  l10n: { t },
  workspace: { getConfiguration, workspaceFolders: undefined },
  window: {
    createQuickPick,
    showInformationMessage(message) { infoMessages.push(message); return Promise.resolve(undefined); },
  },
  // 仅供测试使用的控制面
  __test: {
    overrides, defaults, writes, infoMessages, quickPicks, getConfigCalls,
    reset() {
      overrides.clear(); writes.length = 0; infoMessages.length = 0; quickPicks.length = 0; getConfigCalls.length = 0;
    },
    setOverride(key, level, value) {
      const s = overrides.get(key) || {};
      s[level] = value;
      overrides.set(key, s);
    },
  },
};
`,
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return VSCODE_STUB;
  return origResolve.call(this, request, ...rest);
};

const root = path.resolve(__dirname, '..');
const vscode = require(VSCODE_STUB);
const conv = require(path.join(root, 'out', 'conventionSources.js'));
const projectConfig = require(path.join(root, 'out', 'projectConfig.js'));

// package.json 里的 default：被测逻辑必须**无视**它们（否则项目声明永远不生效）
const pkg = require(path.join(root, 'package.json'));
const PKG_DEFAULTS = {};
for (const [fullKey, spec] of Object.entries(pkg.contributes.configuration.properties)) {
  PKG_DEFAULTS[fullKey.replace(/^okScriptToolkit\./, '')] = spec.default;
}
for (const [key, value] of Object.entries(PKG_DEFAULTS)) vscode.__test.defaults.set(key, value);

// 临时项目根
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-conv-proj-'));
vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectDir } }];
vscode.__test.defaults.set('okScriptProjectPath', projectDir);

function writeConvention(config) {
  const file = path.join(projectDir, 'ok-script-toolkit.json');
  if (config === undefined) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, JSON.stringify(config));
    // mtime 精度可能不够 → 显式推进，保证缓存一定失效
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
  }
  projectConfig.clearProjectConfigCache();
}

function rowOf(rows, key) {
  const found = rows.find((r) => r.key === key);
  assert(found, `溯源视图里没有 ${key} 这一行`);
  return found;
}

async function main() {
  // ── 1. 三层的来源标注 ──────────────────────────────────────────────
  console.log('来源层由取值链产出');
  {
    vscode.__test.reset();
    writeConvention({
      templates: { directory: 'proj_tpl' },
      labelEnum: { aliases: ['PL'] },
    });

    const rows = conv.conventionSources();
    const tpl = rowOf(rows, 'okTemplatesDirectory');
    const aliases = rowOf(rows, 'featureAliases');

    check(tpl.effective === 'proj_tpl' && tpl.layer === 'project', '项目声明生效且标注为「项目约定」');
    check(tpl.declared === 'proj_tpl', 'declared 展示项目文件里写的值');
    check(tpl.overridden === false, '没有个人覆盖时不提供「恢复」');
    check(
      tpl.effective !== PKG_DEFAULTS.okTemplatesDirectory,
      '**项目声明压过了 package.json 的 default** —— 这正是 get() 会搞砸的地方',
    );
    check(aliases.effective === 'PL' && aliases.layer === 'project', '别名同样按项目声明取值');

    // 个人覆盖：只改 templates，别名那一行必须不动
    vscode.__test.setOverride('okTemplatesDirectory', 'global', 'mine_tpl');
    const rows2 = conv.conventionSources();
    const tpl2 = rowOf(rows2, 'okTemplatesDirectory');
    const aliases2 = rowOf(rows2, 'featureAliases');
    check(tpl2.effective === 'mine_tpl' && tpl2.layer === 'personal', '个人偏好压过项目声明，且标注为「我的设置」');
    check(tpl2.declared === 'proj_tpl', '**被覆盖时仍然展示项目文件里的值** —— 否则用户永远看不到团队改了什么');
    check(tpl2.overridden === true, '有个人覆盖时才提供「恢复」');
    check(aliases2.layer === 'project', '只覆盖了一项时，其它行不受影响');

    // 项目文件缺席 → 内置兜底
    writeConvention(undefined);
    vscode.__test.reset();
    const rows3 = conv.conventionSources();
    const tpl3 = rowOf(rows3, 'okTemplatesDirectory');
    check(tpl3.effective === PKG_DEFAULTS.okTemplatesDirectory && tpl3.layer === 'builtin', '项目文件缺席时回到内置兜底');
    check(tpl3.declared === undefined, '没声明时 declared 为空（界面显示「未声明」）');
    check(tpl3.builtin === PKG_DEFAULTS.okTemplatesDirectory, 'builtin 展示"恢复之后会回到什么"');
    check(tpl3.overridden === false, '内置层不算个人覆盖');
  }

  // ── 2. overridden 必须由 layer 推出 ────────────────────────────────
  //
  // 若改成"再比一次值"来推断，就会出现「来源写着我的设置、却没有恢复按钮」
  // （或反之）这类自相矛盾的界面。这条不变量是刻意钉住的。
  console.log('\noverridden 与 layer 永远一致');
  {
    writeConvention({ templates: { directory: 'proj_tpl' } });
    const cases = [
      ['都没设', () => {}],
      ['全局覆盖', () => vscode.__test.setOverride('okTemplatesDirectory', 'global', 'g')],
      ['工作区覆盖', () => vscode.__test.setOverride('okTemplatesDirectory', 'workspace', 'w')],
      ['文件夹覆盖', () => vscode.__test.setOverride('okTemplatesDirectory', 'workspaceFolder', 'f')],
    ];
    for (const [name, setup] of cases) {
      vscode.__test.reset();
      setup();
      const rows = conv.conventionSources();
      check(
        rows.every((r) => r.overridden === (r.layer === 'personal')),
        `${name}：每一行的 overridden 都等于「layer 是我的设置」`,
      );
    }
  }

  // ── 3. 「恢复为项目约定」 ───────────────────────────────────────────
  //
  // 无差别地往三级都写 undefined，会在设置文件里留下空条目；
  // 而只清一级则会留下仍然生效的覆盖 —— 用户点了"恢复"却发现没变，是最糟的反馈。
  console.log('\n恢复：只清有值的层级，然后重读');
  {
    const TARGETS = vscode.ConfigurationTarget;

    // 3a. 只有全局级有覆盖 → 只能对全局级写一次
    writeConvention({ templates: { directory: 'proj_tpl' } });
    vscode.__test.reset();
    vscode.__test.setOverride('okTemplatesDirectory', 'global', 'mine_tpl');
    conv.showConventionSources();
    let qp = vscode.__test.quickPicks.at(-1);
    check(!!qp, '打开了 QuickPick');
    check(qp.items.length === conv.conventionSources().length, '每一条参与取值链的设置占一行');
    let item = qp.items.find((i) => i.row.key === 'okTemplatesDirectory');
    check(item.buttons.length === 1, '有个人覆盖的那一行带「恢复」按钮');
    check(
      qp.items.find((i) => i.row.key === 'featureAliases').buttons.length === 0,
      '没有个人覆盖的行不带按钮（避免用户以为能"恢复"到不存在的东西）',
    );
    check(item.row.layer === 'personal' && item.row.declared === 'proj_tpl', '恢复前：来源是我的设置、项目声明可见');

    await qp._buttonHandler({ item });
    const clears = vscode.__test.writes.filter((w) => w.value === undefined);
    check(clears.length === 1, `只对真正有值的层级写了一次 undefined（实际 ${clears.length} 次）`);
    check(clears[0].key === 'okTemplatesDirectory', '清的是点按钮那一项的键');
    check(clears[0].target === TARGETS.Global, '清的是覆盖实际所在的那一级');
    check(
      !vscode.__test.writes.some((w) => w.target === TARGETS.Workspace || w.target === TARGETS.WorkspaceFolder),
      '**没有往没有值的层级写空条目** —— 那会在设置文件里留下垃圾',
    );

    item = qp.items.find((i) => i.row.key === 'okTemplatesDirectory');
    check(item.row.layer === 'project', '恢复后：来源变成「项目约定」（重读出来的，不是本地改状态）');
    check(item.row.effective === 'proj_tpl', '恢复后：生效值回到项目声明');
    check(item.buttons.length === 0, '恢复后按钮消失');
    check(
      vscode.__test.infoMessages.some((m) => m.includes('okTemplatesDirectory')),
      '提示消息里带上了键名（用户得知道刚才动的是哪一项）',
    );

    // 3b. 两级同时有覆盖 → 两级都要清（只清一级会留下仍然生效的覆盖）
    writeConvention({ templates: { directory: 'proj_tpl' } });
    vscode.__test.reset();
    vscode.__test.setOverride('okTemplatesDirectory', 'global', 'g');
    vscode.__test.setOverride('okTemplatesDirectory', 'workspace', 'w');
    conv.showConventionSources();
    qp = vscode.__test.quickPicks.at(-1);
    item = qp.items.find((i) => i.row.key === 'okTemplatesDirectory');
    check(item.row.effective === 'w', '就近覆盖优先：工作区级压过全局级');
    await qp._buttonHandler({ item });
    const cleared = vscode.__test.writes.filter((w) => w.value === undefined).map((w) => w.target).sort();
    check(
      JSON.stringify(cleared) === JSON.stringify([TARGETS.Global, TARGETS.Workspace].sort()),
      '**两级都有值时两级都清** —— 否则就近的那一级仍会生效，用户以为恢复失败了',
    );
    check(
      qp.items.find((i) => i.row.key === 'okTemplatesDirectory').row.layer === 'project',
      '清完两级后回到项目约定',
    );

    // 3c. 没有任何覆盖 → 不写任何东西
    vscode.__test.reset();
    conv.showConventionSources();
    qp = vscode.__test.quickPicks.at(-1);
    item = qp.items.find((i) => i.row.key === 'okTemplatesDirectory');
    await qp._buttonHandler({ item });
    check(vscode.__test.writes.length === 0, '本来就没有覆盖时不写设置（幂等）');
  }

  // ── 5. 后来接入的三组（i18n / characters / effects）────────────────
  //
  // 这三组此前是硬编码常量，接进取值链后每一行都多了一个"项目声明"的来源。
  // 面板是用户唯一能看见来源的地方，所以这里按**用户看到的字符串**断言，
  // 而不只是断言纯对象（纯对象那层在 test_project_config.js 里已经钉过）。
  console.log('\n新接入的三组在登记表里可溯源');
  {
    writeConvention({
      i18n: { enabled: false, langDirectory: './lang', poDirectory: 'i18n', poDomains: ['ocr', 'ui'] },
      characters: {
        projectPath: '/home/me/other_proj',
        avatarTemplateRegex: '^icon\\d+/',
        masterFile: 'data/chars.json',
      },
      effects: { file: 'src/data/effect_defs.py' },
    });
    vscode.__test.reset();
    const rows = conv.conventionSources();

    const NEW_KEYS = [
      'enablePoData',
      'langDirectory',
      'poDirectory',
      'poDomains',
      'characterProjectPath',
      'characterMasterFile',
      'characterSkillsDirectory',
      'characterLocaleFile',
      'characterAvatarTemplateRegex',
      'effectsFile',
    ];
    check(
      NEW_KEYS.every((key) => rows.some((r) => r.key === key)),
      `登记表收录了全部 ${NEW_KEYS.length} 个新键 —— 漏一行就等于那一项无法溯源、也无法一键恢复`,
    );

    check(rowOf(rows, 'enablePoData').effective === 'false', '布尔项展示的是项目声明里的 false');
    check(rowOf(rows, 'enablePoData').layer === 'project', '布尔项同样标注为「项目约定」');
    check(
      rowOf(rows, 'langDirectory').effective === 'lang' && rowOf(rows, 'langDirectory').declared === 'lang',
      '**归一化对生效值与声明值一致生效** —— 声明写 `./lang`，两边都展示 `lang`，不会出现"面板显示一个样、实际匹配另一个样"',
    );
    check(rowOf(rows, 'poDomains').effective === 'ocr, ui', '列表项用逗号连接展示');
    check(
      rowOf(rows, 'characterProjectPath').effective === '/home/me/other_proj',
      '**绝对路径在面板上原样展示** —— 被归一化会显示成 home/me/other_proj，用户会以为声明写错了',
    );
    check(
      rowOf(rows, 'characterAvatarTemplateRegex').effective === '^icon\\d+/',
      '**正则在面板上原样展示** —— 归一化会显示成 ^icon/d+，用户照抄回去就把自己的正则改坏了',
    );
    check(rowOf(rows, 'effectsFile').effective === 'src/data/effect_defs.py', 'effects 组也接了链');
    check(
      rowOf(rows, 'characterSkillsDirectory').layer === 'builtin',
      '项目文件里没声明的那几项仍然标注为「内置默认」（不能整组都报成项目约定）',
    );

    // 个人覆盖：只动一项，其余行不受影响；被覆盖时项目声明仍然可见
    vscode.__test.setOverride('poDirectory', 'global', 'my_po');
    const rows2 = conv.conventionSources();
    const po2 = rowOf(rows2, 'poDirectory');
    check(po2.effective === 'my_po' && po2.layer === 'personal', '新分组同样受个人偏好优先');
    check(po2.declared === 'i18n', '被覆盖时仍然展示项目声明 —— 否则用户看不到团队改了什么');
    check(rowOf(rows2, 'langDirectory').layer === 'project', '只覆盖一项时同组其它行不受影响');

    // 项目文件缺席：`characterProjectPath` 的兜底是**空串**，面板必须给一句人话
    writeConvention(undefined);
    vscode.__test.reset();
    const bare = rowOf(conv.conventionSources(), 'characterProjectPath');
    check(bare.layer === 'builtin', '项目文件缺席时回到内置兜底');
    check(
      bare.effective.length > 0,
      '**空兜底也要渲染成可读文案** —— 直接展示空串在 QuickPick 里是一段空白，看着像坏了',
    );
    check(bare.effective === 'Same as the current project', '空兜底的文案是「与当前项目相同」');
  }

  // ── 5.5 labelEnum.path / labelEnum.name 也进了登记表 ────────────────
  //
  // 这两项此前**没有**个人偏好层（`path` 的"上次保存"藏在 `globalState` 里，
  // 界面上看不见、还跨项目串味；`name` 完全没有）。升级成正式 IDE 设置之后，
  // 它们必须和其它设置一样可溯源、可恢复 —— 否则用户改过类名之后
  // **看不到团队声明、也回不去**，而这一项改错会让整个项目 import 失败。
  console.log('\n枚举路径与类名也可溯源');
  {
    writeConvention({ labelEnum: { path: 'src/data/feature_list', name: 'FeatureList' } });
    vscode.__test.reset();
    const rows = conv.conventionSources();
    const pathRow = rowOf(rows, 'labelEnumPath');
    const nameRow = rowOf(rows, 'labelEnumName');

    check(pathRow.effective === 'src/data/feature_list.py', '路径行展示的是**文件路径**（模块路径已补 .py）');
    check(pathRow.layer === 'project' && pathRow.declared === 'src/data/feature_list.py', '声明值与生效值走同一套归一化');
    check(nameRow.effective === 'FeatureList' && nameRow.layer === 'project', '类名行按项目声明取值');

    // 个人覆盖（必须写到 workspaceFolder 级别，因为枚举路径/类名带 scope 读取）
    vscode.__test.setOverride('labelEnumPath', 'workspaceFolder', 'mine/x.py');
    vscode.__test.setOverride('labelEnumName', 'workspaceFolder', 'MyEnum');
    const rows2 = conv.conventionSources();
    const path2 = rowOf(rows2, 'labelEnumPath');
    const name2 = rowOf(rows2, 'labelEnumName');
    check(path2.effective === 'mine/x.py' && path2.layer === 'personal', '路径的个人偏好压过项目声明');
    check(name2.effective === 'MyEnum' && name2.layer === 'personal', '类名的个人偏好压过项目声明');
    check(path2.declared === 'src/data/feature_list.py', '被覆盖时仍然展示项目声明 —— 用户得知道团队要的是哪个文件');
    check(name2.declared === 'FeatureList', '类名同理 —— 这一项被覆盖后尤其危险，必须能看见原值');
    check(path2.overridden === true && name2.overridden === true, '两项都提供「恢复为项目约定」');

    // 空字符串覆盖 = "没设置"，不是"钉死为空"
    vscode.__test.setOverride('labelEnumPath', 'workspaceFolder', '   ');
    const path3 = rowOf(conv.conventionSources(), 'labelEnumPath');
    check(path3.layer === 'project', '个人偏好写成空白 = 回到项目约定（与 aliases 的空数组同一条规则）');

    // 都没声明 → 兜底层要能读懂
    writeConvention(undefined);
    vscode.__test.reset();
    const bare = conv.conventionSources();
    const barePath = rowOf(bare, 'labelEnumPath');
    const bareName = rowOf(bare, 'labelEnumName');
    check(barePath.layer === 'builtin' && barePath.declared === undefined, '都没声明时路径行报「内置默认」');
    check(
      barePath.effective === 'Not set — ask on save',
      '**空兜底要渲染成一句人话** —— 直接展示空串在 QuickPick 里是一段空白，看着像坏了',
    );
    check(
      bareName.effective === 'Derived from the file name',
      '类名的兜底是"用文件名推导"（**不是常量**，面板拿不到文件路径）—— 文案要说清这一层会做什么',
    );
  }

  // ── 6. 登记表与 package.json 一致 ──────────────────────────────────
  //
  // 溯源视图的 settingId 是自己拼的（`okScriptToolkit.${key}`）。
  // 拼错键名不会报错，只会让"恢复"静默失效（update 一个不存在的键），
  // 所以这里对着 package.json 逐个核对。
  console.log('\n登记表与 package.json 一致');
  {
    writeConvention({ templates: { directory: 'proj_tpl' } });
    vscode.__test.reset();
    const rows = conv.conventionSources();
    check(rows.length >= 2, '登记表非空');
    for (const r of rows) {
      check(
        Object.prototype.hasOwnProperty.call(PKG_DEFAULTS, r.key),
        `${r.settingId} 在 package.json 的 contributes.configuration 里存在`,
      );
      check(r.settingId === `okScriptToolkit.${r.key}`, `${r.key} 的 settingId 拼接正确`);
      check(typeof r.builtin === 'string' && r.builtin.length > 0, `${r.key} 有可展示的内置兜底文案`);
      check(typeof r.effective === 'string' && r.effective.length > 0, `${r.key} 有可展示的生效值`);
    }
    const keys = rows.map((r) => r.key);
    check(new Set(keys).size === keys.length, '登记表里没有重复键');
  }

  // ── 6.5 登记表必须覆盖每一个「有个人偏好层」的设置 ────────────────
  //
  // 上面那组是"登记表里的键都合法"，这一组是**反方向**：`projectConfig.ts` 里每一个
  // 传给 `ideSetting('x')` 的键，都必须在登记表里出现。
  //
  // 漏一行的后果：那一项**有**个人偏好层、能被用户覆盖，却**无法溯源、也无法一键恢复**
  // —— 用户改了之后再也看不到团队声明、也回不去。这正是溯源面板存在的理由（§3）。
  //
  // 反向不成立（登记表可以有 ideSetting 之外的键）：`featureAliases` 另有一套
  // "上次保存"机制（`globalState`），它的个人偏好不走 `ideSetting` 的字面量调用。
  console.log('\n登记表覆盖所有走 ideSetting 的设置');
  {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');

    // 只看**字面量**调用：登记表内部是用登记表里的 key 动态调 `ideSetting(args.key)`，
    // 那是"消费方"，不是"声明方"。
    const ideSettingKeys = new Set(
      [...readSrc('src/projectConfig.ts').matchAll(/ideSetting<[^>]*>\(\s*'([^']+)'\s*\)/g)]
        .map((m) => m[1]),
    );
    const registryKeys = new Set(
      [...readSrc('src/conventionSources.ts').matchAll(/^\s*key:\s*'([^']+)',/gm)].map((m) => m[1]),
    );

    check(
      ideSettingKeys.size >= 5,
      `扫到了 ${ideSettingKeys.size} 个 ideSetting 字面量键 —— **不能让扫描静默扫空**，` +
        '空集包含于任何集合，断言会恒真',
    );
    check(registryKeys.size >= 5, `扫到了 ${registryKeys.size} 个登记表键 —— 同上`);

    const missing = [...ideSettingKeys].filter((k) => !registryKeys.has(k));
    check(
      missing.length === 0,
      missing.length === 0
        ? `每个走 ideSetting 的设置都在登记表里（${ideSettingKeys.size} 个）`
        : `**这些设置没有登记表行**：${missing.join(', ')} —— 它们的个人偏好层无法溯源、也无法恢复`,
    );

    // 对照：把登记表里的**一个 ideSetting 键**抽掉，上面那条断言必须变红。
    // 刻意挑一个 `ideSettingKeys` 里的键 —— 挑 `featureAliases`（不在那个集合里）会让对照恒真。
    const victim = [...ideSettingKeys][0];
    check(registryKeys.has(victim), `前置：${victim} 确实在登记表里（否则对照没意义）`);
    const afterDrop = new Set([...registryKeys].filter((x) => x !== victim));
    const dropped = [...ideSettingKeys].filter((k) => !afterDrop.has(k));
    check(
      dropped.includes(victim) && dropped.length === missing.length + 1,
      `对照：抽掉登记表里的 ${victim} 后**正好多漏一个** —— 证明上面那条断言确实在约束"覆盖"这件事`,
    );
  }

  // ── 7. 破坏性对照 ──────────────────────────────────────────────────
  //
  // 就地改造编译产物再求值。若对照跑出来的结果与期望相同，说明对应断言没在约束任何东西。
  console.log('\n破坏性对照');
  {
    const source = fs.readFileSync(path.join(root, 'out', 'conventionSources.js'), 'utf-8');
    const outRequire = Module.createRequire(path.join(root, 'out', 'conventionSources.js'));

    function evalSandbox(code) {
      const sandbox = { exports: {} };
      new Function('module', 'exports', 'require', code)(sandbox, sandbox.exports, outRequire);
      return sandbox.exports;
    }

    writeConvention({ templates: { directory: 'proj_tpl' } });

    // 对照一：overridden 恒为 false（= 界面永远不给恢复按钮）
    const noFlag = source.replace(
      "overridden: args.resolved.layer === 'personal',",
      'overridden: false,',
    );
    check(noFlag !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
    vscode.__test.reset();
    vscode.__test.setOverride('okTemplatesDirectory', 'global', 'mine_tpl');
    const noFlagRows = evalSandbox(noFlag).conventionSources();
    check(
      rowOf(noFlagRows, 'okTemplatesDirectory').overridden === false,
      '对照一：拿掉「由 layer 推出」后，有覆盖也不再提供恢复 —— 与第 1/3 组的期望相反',
    );

    // 对照二：来源层恒为 personal（= 界面永远说"值来自我的设置"）
    const alwaysPersonal = source.replace('layer: args.resolved.layer,', "layer: 'personal',");
    check(alwaysPersonal !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
    vscode.__test.reset();
    const alwaysRows = evalSandbox(alwaysPersonal).conventionSources();
    check(
      rowOf(alwaysRows, 'okTemplatesDirectory').layer === 'personal',
      '对照二：来源层被写死后，项目声明的值也被报成「我的设置」—— 这正是"界面与实际生效值分叉"的样子',
    );

    // 对照三：declared 不再由"同一条链再跑一遍"产出（= 声明值不再随链归一化）
    //
    // 第 1 组断言"被覆盖时仍然展示项目文件里的值"、第 5 组断言"声明写 ./lang、
    // 面板也展示 lang"。若 declared 改成别的来源（比如直接读配置对象、不做归一化），
    // 这些断言就会失效，且表现是"面板展示的值与实际生效的值不一致"
    // —— 用户照面板去改项目文件，反而改坏。
    const noProbe = source.replace(
      'declared: probe.layer === \'builtin\' ? undefined : args.render(probe.value),',
      'declared: undefined,',
    );
    check(noProbe !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
    writeConvention({ i18n: { langDirectory: './lang' }, templates: { directory: 'proj_tpl' } });
    vscode.__test.reset();
    const noProbeRows = evalSandbox(noProbe).conventionSources();
    check(
      rowOf(noProbeRows, 'langDirectory').declared === undefined,
      '对照三：拿掉"同一条链再跑一遍"的 declared 探测后，项目声明的值整片消失 —— 与第 5 组的期望相反',
    );
    check(
      rowOf(noProbeRows, 'okTemplatesDirectory').declared === undefined,
      '对照三：同一杠杆也让模板目录那行失去声明值 —— 证明第 1 组的 declared 断言确实在约束它',
    );
  }

  // ── 8. 枚举路径/类名的工作区文件夹作用域 ────────────────────────────
  //
  // CodeRabbit review 要求：labelEnumPath / labelEnumName 的读写必须绑定当前工作区文件夹 URI，
  // 防止 A 项目的值串到 B 项目。
  console.log('\n枚举路径/类名的工作区文件夹作用域');
  {
    writeConvention({ labelEnum: { path: 'src/data/feature_list', name: 'FeatureList' } });
    vscode.__test.reset();

    const rows = conv.conventionSources();
    const pathRow = rowOf(rows, 'labelEnumPath');
    const nameRow = rowOf(rows, 'labelEnumName');

    // 断言：枚举路径/类名的 inspect 调用带了 scope 参数（工作区文件夹 URI）
    const enumConfigCalls = vscode.__test.getConfigCalls.filter(
      (c) => c.section === 'okScriptToolkit' && c.scope,
    );
    check(
      enumConfigCalls.length >= 2,
      `getConfiguration 被调用了 ${enumConfigCalls.length} 次带 scope 参数 —— 枚举路径/类名必须绑定工作区文件夹`,
    );

    // 断言：scope 的 fsPath 与当前工作区文件夹一致
    const scopePaths = enumConfigCalls.map((c) => c.scope?.fsPath).filter(Boolean);
    check(
      scopePaths.every((p) => p === projectDir),
      `所有带 scope 的 getConfiguration 调用都使用了当前工作区文件夹 URI（${projectDir}）`,
    );

    // 断言：枚举路径/类名仍然能正确读取值
    check(pathRow.effective === 'src/data/feature_list.py', '带 scope 时路径仍能正确读取');
    check(nameRow.effective === 'FeatureList', '带 scope 时类名仍能正确读取');

    // 断言：写入时也带 scope
    vscode.__test.reset();
    conv.clearOverride('labelEnumPath');
    const pathWrites = vscode.__test.writes.filter((w) => w.key === 'labelEnumPath');
    check(
      pathWrites.every((w) => w.scope !== undefined),
      'clearOverride 对 labelEnumPath 的写入带了 scope 参数',
    );
    check(
      pathWrites.every((w) => w.scope?.fsPath === projectDir),
      `clearOverride 对 labelEnumPath 的写入使用了当前工作区文件夹 URI（${projectDir}）`,
    );
  }

  // ── 9. setIdeSetting 不再写入全局设置 ──────────────────────────────
  //
  // CodeRabbit review 要求：setIdeSetting 不应在没有工作区文件夹时写入全局设置。
  // 这里通过检查 writes 记录来验证。
  console.log('\nsetIdeSetting 不再写入全局设置');
  {
    vscode.__test.reset();

    // 模拟没有工作区文件夹的场景
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = undefined;

    // 尝试调用 setIdeSetting（需要直接调用编译产物）
    const projectConfig = require(path.join(root, 'out', 'projectConfig.js'));

    // setIdeSetting 应该在没有工作区文件夹时直接返回，不做任何写入
    await projectConfig.setIdeSetting('labelEnumPath', 'test/path.py');
    const globalWrites = vscode.__test.writes.filter(
      (w) => w.key === 'labelEnumPath' && w.target === vscode.ConfigurationTarget.Global,
    );
    check(
      globalWrites.length === 0,
      '没有工作区文件夹时 setIdeSetting 不写入全局设置',
    );

    // 恢复工作区文件夹
    vscode.workspace.workspaceFolders = origFolders;
  }

  // ── 10. clearOverride 使用工作区文件夹作用域 ────────────────────────
  //
  // CodeRabbit review 要求：clearOverride 在读取与清除 WorkspaceFolder 覆盖时
  // 必须使用当前工作区文件夹的 URI。
  console.log('\nclearOverride 使用工作区文件夹作用域');
  {
    writeConvention({ templates: { directory: 'proj_tpl' } });
    vscode.__test.reset();

    // 设置一个覆盖
    vscode.__test.setOverride('labelEnumPath', 'workspaceFolder', 'override/path.py');

    // 清除覆盖
    await conv.clearOverride('labelEnumPath');

    // 断言：clearOverride 对 labelEnumPath 的读写都带了 scope
    const labelEnumWrites = vscode.__test.writes.filter((w) => w.key === 'labelEnumPath');
    check(
      labelEnumWrites.length > 0,
      'clearOverride 对 labelEnumPath 执行了写入',
    );
    check(
      labelEnumWrites.every((w) => w.scope !== undefined),
      'clearOverride 对 labelEnumPath 的所有写入都带了 scope 参数',
    );

    // 断言：写入使用了 WorkspaceFolder 目标
    check(
      labelEnumWrites.some((w) => w.target === vscode.ConfigurationTarget.WorkspaceFolder),
      'clearOverride 清除了 WorkspaceFolder 级别的覆盖',
    );
  }

  console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
