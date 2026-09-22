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
    fields: [{ key: '键位A', displayKey: '键位A', default: 'q', value: 'q', type: null, desc: '' }],
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
  accounts: {},
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
if (errors.length) { console.log('RUNTIME ERRORS:', errors.slice(0, 3)); process.exit(1); }

console.log('4. 地图卡存在且有 content');
const mapCard = document.querySelectorAll('#accountList .gconfig-card')[2];
const ta = mapCard.querySelector('textarea');
assert(ta && ta.value === 'some content', '地图卡 textarea 显示 content');

console.log('\n全部通过');
