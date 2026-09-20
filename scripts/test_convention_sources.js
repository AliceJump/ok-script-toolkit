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

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
class ThemeIcon { constructor(id) { this.id = id; } }

function t(message, args) {
  if (!args) return message;
  return String(message).replace(/\\{(\\w+)\\}/g, (all, name) => (name in args ? String(args[name]) : all));
}

function getConfiguration() {
  return {
    get(key) {
      const s = overrides.get(key) || {};
      if (s.workspaceFolder !== undefined) return s.workspaceFolder;
      if (s.workspace !== undefined) return s.workspace;
      if (s.global !== undefined) return s.global;
      return defaults.get(key);
    },
    inspect(key) {
      const s = overrides.get(key) || {};
      return {
        key,
        defaultValue: defaults.get(key),
        globalValue: s.global,
        workspaceValue: s.workspace,
        workspaceFolderValue: s.workspaceFolder,
      };
    },
    update(key, value, target) {
      writes.push({ key, value, target });
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
    overrides, defaults, writes, infoMessages, quickPicks,
    reset() {
      overrides.clear(); writes.length = 0; infoMessages.length = 0; quickPicks.length = 0;
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

  console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
