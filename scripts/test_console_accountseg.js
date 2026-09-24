const fs = require('fs');
const os = require('os');
const path = require('path');
let jsdom;
try {
  jsdom = require('jsdom');
} catch {
  const jsdomRoot = process.env.OK_LANG_HINTS_JSDOM_ROOT || path.join(os.tmpdir(), 'ok-script-toolkit-jsdom');
  jsdom = require(path.join(jsdomRoot, 'node_modules', 'jsdom'));
}
const { JSDOM, VirtualConsole } = jsdom;

const root = path.resolve(__dirname, '..');
const componentRoot = path.join(root, 'media', 'console');
let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');

const dictionary = {
  consoleTitle: 'Console', consoleTabTasks: 'Tasks', consoleTabGame: 'Game', consoleTabConfig: 'Config',
  consoleTabAccounts: 'Accounts', consoleHint: '', takeoverBanner: '', refresh: 'R', noTasks: 'None',
  noConfigParameters: 'None', projectStoreTag: 'store', syncDefaultBtn: 'Sync', resetDefaultBtn: 'Reset',
  itemsCount: '{count} item(s)', ungrouped: 'Ungrouped', searchTasks: 'Search', launch: 'Launch',
  oneTimeTask: 'One-time', triggerTask: 'Trigger', taskCount: '{count}', enableTrigger: 'Enable',
  startExecutor: 'Start', accountNotAvailable: 'N/A', accountStoreUnavailable: 'N/A',
  accountNoEditor: 'N/A', accountStoreSeeOutput: '', accountLoading: 'loading...',
  accountStoreTitle: 'Store', saveBtn: 'Save', openDataBtn: 'Open', accountListLabel: 'List',
  accountListHint: '', overrideTitle: 'Overrides', accountLabel: 'Account', taskLabel: 'Task',
  targetLabel: 'Target', globalGroupLabel: 'Global', mapContentTitle: 'Map', mapContentHint: '',
  clearOverrideBtn: 'Clear', overrideHint: '', parameters: 'Parameters',
};
html = html
  .replaceAll('__CSP_NONCE__', 'test')
  .replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary))
  .replace('<link rel="stylesheet" href="__SHARED_TOKENS_URI__">',
    `<style>${fs.readFileSync(path.join(root, 'media', 'shared', 'tokens.css'), 'utf8')}</style>`)
  .replace('<link rel="stylesheet" href="__SHARED_CONTROLS_URI__">',
    `<style>${fs.readFileSync(path.join(root, 'media', 'shared', 'controls.css'), 'utf8')}</style>`)
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', `<style>${fs.readFileSync(path.join(componentRoot, 'console.css'), 'utf8')}</style>`);
for (const [marker, file] of [
  ['__CORE_SCRIPT_URI__', 'core.js'],
  ['__FIELDS_SCRIPT_URI__', 'fields.js'],
  ['__CONFIG_PANEL_SCRIPT_URI__', 'configPanel.js'],
  ['__TASK_CARD_SCRIPT_URI__', 'taskCard.js'],
  ['__CONSOLE_SCRIPT_URI__', 'console.js'],
  ['__APP_SCRIPT_URI__', 'app.js'],
]) {
  html = html.replace(`<script src="${marker}"></script>`, `<script>${fs.readFileSync(path.join(componentRoot, file), 'utf8')}</script>`);
}

const sent = [];
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(String(error)));
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  },
});
const { window } = dom;
const { document } = window;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const send = data => window.dispatchEvent(new window.MessageEvent('message', { data }));

const TASK_A = 'src.tasks.onetime.DailyTask::DailyTask';
const schemas = {
  [TASK_A]: {
    fields: [
      { key: '开关', displayKey: '开关', default: false, value: false, type: null, desc: '' },
    ],
    displayName: '日常任务', kind: 'onetime',
  },
};
const globalGroups = [
  {
    name: 'Game Hotkey Config', displayName: 'Game Hotkey Config', source: 'framework',
    fields: [{ key: '键位A', displayKey: '键位A', default: false, value: false, type: null, desc: '' }],
  },
];
const multiAccount = {
  available: true, storePath: 'x', hasStoreModule: true,
  enabledTasks: {
    [TASK_A]: { storageName: 'DailyTask', keys: ['开关'] },
    'Game Hotkey Config': { storageName: 'Game Hotkey Config', keys: ['键位A'], global: true },
  },
};
const store = {
  accountListText: '1111\n2222',
  registry: { acc_1: { username: '1111' }, acc_2: { username: '2222' } },
  accounts: { acc_1: { 'Game Hotkey Config': { '键位A': 'true' } } },
  mapContents: { acc_1: 'some content' },
};

console.log('1. tasks + accountStore 消息后账号分段渲染三张卡');
send({ type: 'tasks', tasks: [], schemas, globalGroups, multiAccount });
send({ type: 'globalGroups', groups: globalGroups, snapshots: {}, expanded: [] });
send({ type: 'accountStore', data: store });
const cards = document.querySelectorAll('#accountList .gconfig-card');
if (errors.length) {
  console.log('RUNTIME ERRORS:', errors.slice(0, 3));
  process.exit(1);
}
assert(cards.length === 3, `应渲染 3 张卡（账号列表/覆盖/地图），实际 ${cards.length}`);

console.log('1a. 覆盖卡头支持键盘折叠并同步 aria-expanded');
const initialCardHead = document.querySelector('#accountList .gconfig-card__head--toggle');
const initialCardBody = initialCardHead.nextElementSibling;
assert(initialCardHead.getAttribute('aria-expanded') === 'true', '初始展开时 aria-expanded=true');
const spaceEvent = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
initialCardHead.dispatchEvent(spaceEvent);
assert(initialCardBody.hidden === true && initialCardHead.getAttribute('aria-expanded') === 'false',
  'Space 收起卡片并同步 aria-expanded=false');
assert(spaceEvent.defaultPrevented, 'Space 激活时阻止默认滚动');
initialCardHead.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert(initialCardBody.hidden === false && initialCardHead.getAttribute('aria-expanded') === 'true',
  'Enter 重新展开卡片并同步 aria-expanded=true');

console.log('2. 覆盖对象下拉有任务/全局组两个 optgroup');
const optgroups = document.querySelectorAll('#accountList optgroup');
assert(optgroups.length === 2, `应有 2 个 optgroup，实际 ${optgroups.length}`);
const globalOpt = document.querySelector('#accountList optgroup[label="Global"] option');
assert(globalOpt && globalOpt.value.startsWith('global:'), '全局组选项存在');

console.log('3. 选全局组 → 表单用组 fields 渲染');
document.getElementById('segAccounts').click();
const targetSelect = document.querySelectorAll('#accountList select')[1];
targetSelect.value = 'global:Game Hotkey Config';
targetSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
const panel = document.querySelector('#accountList .account-override-form .config-panel');
assert(panel, '全局组表单渲染');
const globalCheckbox = panel.querySelector('input[type="checkbox"]');
assert(globalCheckbox?.checked === true, '全局组账号覆盖按 field 类型将字符串 true 矫正为布尔值');
if (errors.length) { console.log('RUNTIME ERRORS:', errors.slice(0, 3)); process.exit(1); }

console.log('4. 地图卡存在且有 content');
const mapCard = document.querySelectorAll('#accountList .gconfig-card')[2];
const ta = mapCard.querySelector('textarea');
assert(ta && ta.value === 'some content', '地图卡 textarea 显示 content');
const mapAccountSelect = mapCard.querySelector('select');
const mapAccountLabel = mapCard.querySelector('label');
assert(mapAccountSelect && (mapAccountSelect.compareDocumentPosition(ta) & window.Node.DOCUMENT_POSITION_FOLLOWING),
  '地图卡账号选择框位于 textarea 之前');
assert(mapAccountLabel?.control === mapAccountSelect, '地图卡账号选择框有关联标签');
mapAccountSelect.value = '2222';
mapAccountSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(ta.value === '', '切换账号后地图 content 同步刷新');
mapAccountSelect.value = '1111';
mapAccountSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(ta.value === 'some content', '切回账号后恢复对应 content');

console.log('5. 「启动设置」区不可折叠（折叠已移除，标题是普通标题）');
const overridePanel = document.querySelector('#accountList .account-override-form .config-panel');
const titleEl = overridePanel.querySelector(':scope > .config-section-title');
assert(titleEl && !titleEl.classList.contains('config-section-title--toggle'), '标题不带折叠标记');
const fieldsHost = overridePanel.querySelector(':scope > .config-fields');
assert(fieldsHost && fieldsHost.hidden === false, '字段区常驻显示');

console.log('6. CSS 兜底：hidden 必须压过作者样式的 display（真机折叠生效的前提）');
const css = fs.readFileSync(path.join(componentRoot, 'console.css'), 'utf8');
const sharedTokens = fs.readFileSync(path.join(root, 'media', 'shared', 'tokens.css'), 'utf8');
const sharedControls = fs.readFileSync(path.join(root, 'media', 'shared', 'controls.css'), 'utf8');
assert(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
  'console.css 必须包含 [hidden] { display: none !important }（否则 .config-fields 的 grid 会顶掉 hidden）');
assert(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(sharedTokens),
  'shared/tokens.css 必须包含 [hidden] { display: none !important }（否则 .config-fields 的 grid 会顶掉 hidden）');

console.log('7. 折叠状态持久化：覆盖卡点击折叠发出 saveUiState，注入 uiState 后初始即收起');
sent.length = 0;
const cardHead = document.querySelector('#accountList .gconfig-card__head--toggle');
// 折叠可见性回归：chev 必须真实入 DOM（此前漏 append 导致整卡可折叠但界面无任何提示）
const chevEl = cardHead.querySelector(':scope > .gconfig-card__chev');
assert(chevEl, '覆盖卡头部渲染折叠箭头（affordance）');
assert(cardHead.title && cardHead.title.length > 0, '覆盖卡头部带折叠提示 tooltip');
cardHead.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const uiMsg2 = sent.filter(m => m.type === 'saveUiState').pop();
assert(uiMsg2 && uiMsg2.key === 'cardCollapsed::accountOverride' && uiMsg2.value === true,
  `覆盖卡折叠落盘（got ${JSON.stringify(uiMsg2)}）`);
// 重发 taskConfigs 带 uiState：覆盖卡应初始收起
send({
  type: 'taskConfigs', configs: {},
  uiState: {
    'cardCollapsed::accountOverride': true,
  },
});
send({ type: 'accountStore', data: store });
const cardBody2 = document.querySelectorAll('#accountList .gconfig-card')[1].querySelector(':scope > .gconfig-card__body');
assert(cardBody2.hidden === true, '复用 uiState：覆盖卡初始收起');

console.log('8. 任务分组折叠持久化（taskCard：kind 级与业务分组）');
sent.length = 0;
const triggerHead = document.getElementById('triggerHead');
assert(triggerHead, '触发任务组头存在');
triggerHead.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const gMsg = sent.filter(m => m.type === 'saveUiState').pop();
assert(gMsg && gMsg.key === 'taskGroupCollapsed::trigger' && gMsg.value === true,
  `任务分组折叠落盘（got ${JSON.stringify(gMsg)}）`);

console.log('9. 有 store 模块但无数据文件时显示空编辑器');
send({
  type: 'tasks', tasks: [], schemas, globalGroups,
  multiAccount: { ...multiAccount, available: false },
});
send({ type: 'accountStore', data: { accountListText: '', registry: {}, accounts: {}, mapContents: {} } });
const emptyStoreCards = document.querySelectorAll('#accountList .gconfig-card');
assert(emptyStoreCards.length === 3, '无数据文件但有 store 模块时仍显示三张编辑卡');
assert(emptyStoreCards[0].querySelector('textarea'), '空 store 仍可编辑账号列表');

console.log('10. 可点击规范：真按钮=控件面+描边，行级区=极浅底色（无描边）');
assert(sharedControls.includes('可点击性硬规范'), 'shared/controls.css 含可点击规范段落');
assert(sharedTokens.includes('--bg-control') && sharedTokens.includes('--bg-control-hover'),
  'tokens 定义控件面底色（未悬浮即有底色）');
assert(sharedTokens.includes('--bg-row') && sharedTokens.includes('--bg-row-hover'),
  'tokens 定义行级可点击区的极浅底色 + hover');
assert(/\.config-group__toggle\s*\{[^}]*border:/.test(css), '分组折叠按键（真按钮）有描边');
assert(/\.config-section-title--toggle\s*\{[^}]*background:\s*var\(--bg-row\)/.test(css),
  '启动设置折叠头用行级浅底色');
assert(/\.subgroup-head\s*\{[^}]*background:\s*var\(--bg-row\)/.test(css),
  '任务分组头用行级浅底色');
assert(/\.group-head\s*\{[^}]*background:\s*var\(--bg-row\)/.test(css),
  'kind 级任务组头用行级浅底色');
assert(!/\.group-head\s*\{[^}]*border:\s*var\(--border-width/.test(css), '行级组头不再有描边（避免方块墙）');
assert(!/\.subgroup-head\s*\{[^}]*border:\s*var\(--border-width/.test(css), '业务分组头不再有描边');

console.log('\n全部通过');
