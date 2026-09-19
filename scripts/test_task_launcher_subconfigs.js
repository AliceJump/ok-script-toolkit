const fs = require('fs');
const path = require('path');
let jsdom;
try {
  jsdom = require('jsdom');
} catch {
  const jsdomRoot = process.env.OK_LANG_HINTS_JSDOM_ROOT || path.join(process.env.TEMP, 'ok-script-toolkit-jsdom');
  jsdom = require(path.join(jsdomRoot, 'node_modules', 'jsdom'));
}
const { JSDOM, VirtualConsole } = jsdom;

const root = path.resolve(__dirname, '..');
const componentRoot = path.join(root, 'media', 'taskLauncher');
let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src', 'localization.ts'), 'utf8');
const match = /const EN: WebviewStrings = \{([\s\S]*?)\n\};/.exec(source);
if (!match) throw new Error('EN dictionary not found');
const dictionary = {
  parameters: 'Parameters', collapseParameters: 'Collapse Parameters', launchSettings: 'Launch Settings',
  reset: 'Reset', configGroup: 'Group', saved: 'Auto-saved',
  commonParameters: 'Common', groupParameters: 'Groups', childTaskConfig: 'Children', otherParameters: 'Other',
  noConfigParameters: 'None', schemaFailed: 'Failed {error}', current: 'Current',
  currentValue: '{value}', enabled: 'On', disabled: 'Off', holdCtrlMulti: '', structuredJsonHint: '',
  selectedOptionsHint: '{values}', taskTitle: 'Tasks', refresh: 'Refresh', noTasks: 'No tasks',
  triggerTask: 'Trigger', oneTimeTask: 'One-time', launch: 'Launch', stop: 'Stop', running: 'Running',
  stopping: 'Stopping', taskStopped: 'Stopped',
  taskCompleted: 'Completed', taskFailed: 'Failed'
};
html = html
  .replaceAll('__CSP_NONCE__', 'test')
  .replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary))
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', `<style>${fs.readFileSync(path.join(componentRoot, 'taskLauncher.css'), 'utf8')}</style>`);
for (const [marker, file] of [
  ['__CORE_SCRIPT_URI__', 'core.js'],
  ['__FIELDS_SCRIPT_URI__', 'fields.js'],
  ['__CONFIG_PANEL_SCRIPT_URI__', 'configPanel.js'],
  ['__TASK_CARD_SCRIPT_URI__', 'taskCard.js'],
  ['__APP_SCRIPT_URI__', 'app.js'],
]) {
  html = html.replace(`<script src="${marker}"></script>`, `<script>${fs.readFileSync(path.join(componentRoot, file), 'utf8')}</script>`);
}
const sent = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { throw error; });
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  },
});
const { window } = dom;
const task = { module: 'demo', className: 'DemoTask', displayName: 'Demo Task' };
const fields = [
  { key: 'boolSwitch', default: false, value: false, displayKey: 'Boolean switch', type: { sub_configs: { True: ['inlineA'] } } },
  { key: 'inlineA', default: 'a', value: 'a', displayKey: 'Inline A', type: {} },
  { key: 'selector', default: 'one', value: 'one', displayKey: 'Selector', type: { type: 'drop_down', options: ['one', 'two'], sub_configs: { one: ['shared', 'oneOnly'], two: ['shared', 'twoOnly'] }, sub_config_labels: { one: 'Group One', two: 'Group Two' } } },
  { key: 'shared', default: 'shared', value: 'shared', displayKey: 'Shared', type: {} },
  { key: 'oneOnly', default: 'one', value: 'one', displayKey: 'One only', type: {} },
  { key: 'twoOnly', default: 'two', value: 'two', displayKey: 'Two only', type: {} },
  { key: 'titleField', default: false, value: false, displayKey: 'Title field', type: { sub_configs: { True: ['titleChild'] } } },
  { key: 'titleChild', default: 'child', value: 'child', displayKey: 'Title child', type: {} },
  { key: 'plainChild', default: 'plain', value: 'plain', displayKey: 'Plain child', type: {} },
  { key: 'groupSelector', default: 'A', value: 'A', displayKey: 'Hidden selector', type: { type: 'drop_down', options: ['A', 'B'], sub_configs: { A: ['aField'], B: ['bField'] } } },
  { key: 'aField', default: 'a', value: 'a', displayKey: 'A field', type: {} },
  { key: 'bField', default: 'b', value: 'b', displayKey: 'B field', type: {} },
  // 复现 ok-gf2「活动层」：组头字段自身的 sub_configs 子项与其 configGroups children
  // 是同一批 key。两个渲染来源重合时，子项曾被渲染两遍（喝水/吃饭各出现两次）。
  { key: 'overlapGroup', default: true, value: true, displayKey: 'Overlap group', type: { sub_configs: { True: ['overlapChildA', 'overlapChildB'] } } },
  { key: 'overlapChildA', default: '1', value: '1', displayKey: 'Overlap child A', type: {} },
  { key: 'overlapChildB', default: '2', value: '2', displayKey: 'Overlap child B', type: {} },
  // 「折叠吸收显隐」的极端形状：分组名的 sub_configs 子项里，有一个**不在** children 里。
  // 该子项原本只有 inline 这一条渲染通道；吸收规则必须把它补进 children，否则字段会消失。
  { key: 'absorbGroup', default: false, value: false, displayKey: 'Absorb group', type: { sub_configs: { True: ['absorbDeclared', 'absorbOrphan'] } } },
  { key: 'absorbDeclared', default: 'd', value: 'd', displayKey: 'Absorb declared', type: {} },
  { key: 'absorbOrphan', default: 'o', value: 'o', displayKey: 'Absorb orphan', type: {} },
];
const schema = {
  fields,
  kind: 'onetime',
  groupSelector: 'groupSelector',
  configGroups: {
    A: ['aField'],
    B: ['bField'],
    titleField: ['titleField', 'plainChild'],
    overlapGroup: ['overlapChildA', 'overlapChildB'],
    // absorbDeclared 已声明；absorbOrphan 只在 sub_configs 里，必须被吸收补进来
    absorbGroup: ['absorbDeclared'],
  },
  groupLabels: { A: 'A Group', B: 'B Group', titleField: 'Title Group', overlapGroup: 'Overlap Group', absorbGroup: 'Absorb Group' },
};
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'tasks', tasks: [task], schemas: { 'demo::DemoTask': schema } } }));

const labels = [...window.document.querySelectorAll('.config-group__title')].map(node => node.textContent.trim());
const fieldRows = key => [...window.document.querySelectorAll(`.config-field[data-key="${key}"]`)];
const groupByTitle = title => [...window.document.querySelectorAll('.config-group')].find(group => group.querySelector(':scope > .config-group__header .config-group__title')?.textContent.trim() === title);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
// 统计每个 key 的渲染行数：除「共享子项」外，同一 key 不应渲染多次。
// 曾经的 bug：分组标题字段自身的内联子项（inlineRules）与其 configGroups children 是同一批 key 时，
// 两个循环各渲染一遍，导致「喝水/吃饭」等在每个分组内重复出现。
const duplicateRows = (allowed = []) => {
  const allowedSet = new Set(allowed);
  const counts = {};
  for (const row of window.document.querySelectorAll('.config-field[data-key]')) {
    const key = row.getAttribute('data-key');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([key, count]) => count > 1 && !allowedSet.has(key))
    .map(([key, count]) => `${key}x${count}`);
};

assert(fieldRows('groupSelector').length === 0, 'register_config_groups selector must be hidden');
assert(labels.includes('A Group') && labels.includes('B Group'), 'all registered groups must be rendered');
assert(labels.includes('Group One') && labels.includes('Group Two'), 'all option sub-config groups must be rendered');
assert(fieldRows('shared').length >= 2, 'shared field must appear in every option group');
assert(window.document.querySelectorAll('.config-group').length >= 5, 'expected permanent collapse groups');
assert(fieldRows('inlineA').length === 1, 'boolean sub-config child must render once');
assert(fieldRows('inlineA')[0].classList.contains('is-subconfig'), 'boolean sub-config child must be inline-styled');
assert(!fieldRows('inlineA')[0].closest('.config-group'), 'top-level boolean sub-config must not get a collapse group');
assert(fieldRows('inlineA')[0].hidden, 'false boolean switch must hide True children');
const boolSwitch = fieldRows('boolSwitch')[0].querySelector('input[type="checkbox"]');
boolSwitch.checked = true;
boolSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(!fieldRows('inlineA')[0].hidden, 'enabling a boolean switch must reveal its inline children');
assert(groupByTitle('Group One') && groupByTitle('Group Two'), 'option groups must not depend on selected value');
assert(!groupByTitle('Group One').classList.contains('open') && !groupByTitle('Group Two').classList.contains('open'), 'collapse state must default closed, independent of config values');
const selector = fieldRows('selector')[0].querySelector('select');
selector.value = '1';
selector.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(groupByTitle('Group One') && groupByTitle('Group Two'), 'changing a selector must not hide or remove any option group');
assert(fieldRows('titleField').length === 1, 'config field may act as a group title without a duplicate row');
assert(fieldRows('titleField')[0].closest('.config-group'), 'config field title must still register a collapse group');
// 折叠吸收显隐：分组名的 sub_configs 不再作为显隐规则，其子项被吸收进该组的 children。
// 因此 titleChild 现在是分组里的普通子项（不再带 is-subconfig、不再随开关 hidden）。
assert(fieldRows('titleChild').length === 1, 'absorbed inline child must render exactly once');
assert(fieldRows('titleChild')[0].closest('.config-group'), 'absorbed inline child must live inside the fold container');
assert(!fieldRows('titleChild')[0].classList.contains('is-subconfig'), 'absorbed child is a regular group child, not an inline subconfig');
assert(fieldRows('titleChild')[0].closest('.config-group') === fieldRows('titleField')[0].closest('.config-group'), 'absorbed child must live in the same group as its former switch');
assert(!fieldRows('titleChild')[0].hidden, 'absorbed child must be visible regardless of the switch value');
const titleSwitch = fieldRows('titleField')[0].querySelector('input[type="checkbox"]');
const foldBefore = fieldRows('titleChild')[0].closest('.config-group').classList.contains('open');
titleSwitch.checked = true;
titleSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
// 开关现在只是普通配置项，不再控制可见性，也不应改变折叠状态
assert(!fieldRows('titleChild')[0].hidden, 'toggling an absorbed switch must not hide its children');
assert(fieldRows('titleChild')[0].classList.contains('is-subconfig') === false, 'absorbed child must stay a regular child after toggling');
assert(fieldRows('titleChild')[0].closest('.config-group').classList.contains('open') === foldBefore, 'toggling an absorbed switch must not change fold state');
assert(fieldRows('plainChild').length === 1, 'title group regular child must render');
// shared 是 shared/oneOnly/twoOnly 中唯一被两个 option 组共用的项，允许出现多次；
// 其余每个 key 都必须只渲染一次 —— 分组标题字段的内联子项不得重复。
const syntheticDupes = duplicateRows(['shared']);
assert(!syntheticDupes.length, `fields must not be rendered twice: ${syntheticDupes.join(', ')}`);
assert(fieldRows('titleChild').length === 1, 'config-title switch child must not duplicate via inline rules');
assert(fieldRows('plainChild').length === 1, 'title group child declared in configGroups must not duplicate');
// ok-gf2 场景：组头字段的 sub_configs 子项 == 该组 configGroups children，必须各渲染一次
assert(fieldRows('overlapChildA').length === 1, 'overlap group child A must render exactly once');
assert(fieldRows('overlapChildB').length === 1, 'overlap group child B must render exactly once');
const overlapGroup = [...window.document.querySelectorAll('.config-group')].find(
  group => group.querySelector(':scope > .config-group__header .config-field[data-key="overlapGroup"]'),
);
assert(overlapGroup, 'overlap group must exist and use its field as header');
assert(overlapGroup.querySelectorAll('.config-field[data-key="overlapChildA"]').length === 1, 'overlap child A must live inside the group exactly once');

// 「折叠吸收显隐」：仅存在于 sub_configs、未在 children 里的子项，必须被吸收进分组而不是消失。
const absorbGroup = [...window.document.querySelectorAll('.config-group')].find(
  group => group.querySelector(':scope > .config-group__header .config-field[data-key="absorbGroup"]'),
);
assert(absorbGroup, 'absorb group must exist and use its field as header');
assert(fieldRows('absorbOrphan').length === 1, 'orphan inline child must survive absorption (must not vanish)');
assert(absorbGroup.querySelectorAll('.config-field[data-key="absorbOrphan"]').length === 1, 'absorbed orphan child must live inside the fold container');
assert(fieldRows('absorbDeclared').length === 1, 'absorb group declared child must render exactly once');
assert(!fieldRows('absorbOrphan')[0].hidden, 'absorbed child must be visible even though the switch is false');
assert(!fieldRows('absorbDeclared')[0].hidden, 'declared child must be visible even though the switch is false');
// 开关状态变化不得影响折叠组内子项的可见性（显隐已被折叠吸收）
const absorbSwitch = fieldRows('absorbGroup')[0].querySelector('input[type="checkbox"]');
absorbSwitch.checked = true;
absorbSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(!fieldRows('absorbOrphan')[0].hidden && !fieldRows('absorbDeclared')[0].hidden, 'toggling an absorbed switch must not change child visibility');
assert(fieldRows('absorbOrphan').length === 1, 'absorbed child must not duplicate after toggling');

const realSchemaFile = process.argv[2];
let realSummary = null;
if (realSchemaFile) {
  const probe = JSON.parse(fs.readFileSync(realSchemaFile, 'utf8'));
  const dailyEntry = Object.entries(probe.schemas).find(([key]) => key.endsWith('DailyTask::DailyTask'));
  if (!dailyEntry) throw new Error('DailyTask schema not found');
  const [dailyKey, dailySchema] = dailyEntry;
  const dailyTask = { module: dailyKey.split('::')[0], className: 'DailyTask', displayName: dailySchema.displayName || 'DailyTask' };
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'tasks', tasks: [dailyTask], schemas: { [dailyKey]: dailySchema } } }));
  const dailyLabels = [...window.document.querySelectorAll('.config-group')].map(group => {
    const header = group.querySelector(':scope > .config-group__header');
    return header?.querySelector('.config-group__title')?.textContent.trim()
      || header?.querySelector('.config-field > label')?.childNodes[0]?.textContent.trim()
      || '';
  }).filter(Boolean);
  const expectedGroups = Object.keys(dailySchema.configGroups || {}).filter(key => key !== '配置选择');
  const boolSubConfigLabels = new Set();
  for (const field of dailySchema.fields) {
    if (typeof field.default !== 'boolean' && typeof field.value !== 'boolean') continue;
    for (const choice of Object.keys(field.type?.sub_configs || {})) boolSubConfigLabels.add(String(choice));
  }
  assert(window.document.querySelectorAll('.config-field[data-key="配置选择"]').length === 0, 'real register_config_groups selector must be hidden');
  const missingGroups = expectedGroups.filter(group => !dailyLabels.includes(dailySchema.groupLabels?.[group] || group));
  if (missingGroups.length) console.log('REAL_DEBUG', JSON.stringify({ dailyLabels, missingGroups }));
  assert(!missingGroups.length, 'all real registered groups must be rendered together');
  assert(!dailyLabels.some(label => boolSubConfigLabels.has(label)), 'boolean True/False sub_configs must not become collapse groups');

  // 真实项目回归：只有「被多个 configGroups 共用的 key」允许出现多次。
  // 分组标题字段自身的 sub_configs 子项若同时是它 configGroups 的 children，
  // 必须只渲染一次（ok-gf2 的「活动层 -> 喝水/吃饭」重复渲染即此类）。
  const childGroupCount = {};
  for (const children of Object.values(dailySchema.configGroups || {})) {
    if (!Array.isArray(children)) continue;
    for (const child of children) childGroupCount[child] = (childGroupCount[child] || 0) + 1;
  }
  const sharedKeys = Object.entries(childGroupCount).filter(([, n]) => n > 1).map(([key]) => key);
  const realDupes = duplicateRows(sharedKeys);
  if (realDupes.length) console.log('REAL_DUP_DEBUG', JSON.stringify({ realDupes, sharedKeys }));
  assert(!realDupes.length, `real schema fields must not be rendered twice: ${realDupes.join(', ')}`);

  // 逐一断言：每个 configGroups 子项都恰好渲染一次（除非被多个分组共用）。
  for (const [group, children] of Object.entries(dailySchema.configGroups || {})) {
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (sharedKeys.includes(child)) continue;
      const rows = window.document.querySelectorAll(`.config-field[data-key="${child}"]`);
      assert(rows.length <= 1, `group "${group}" child "${child}" must render exactly once, got ${rows.length}`);
    }
  }

  realSummary = { dailyGroups: dailyLabels.length, expectedGroups: expectedGroups.length, sharedKeys };
}

console.log(JSON.stringify({ groups: labels, sharedCopies: fieldRows('shared').length, hiddenSelector: fieldRows('groupSelector').length, realSummary, sent }));