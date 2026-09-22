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
  oneTimeTask: 'One-time', triggerTask: 'Trigger', taskCount: '{count}', triggerTask: 'Trigger',
  enableTrigger: 'Enable', startExecutor: 'Start', accountNotAvailable: 'N/A',
  accountStoreTitle: 'Store', saveBtn: 'Save', openDataBtn: 'Open', accountListLabel: 'List',
  accountListHint: '', overrideTitle: 'Overrides', accountLabel: 'Account', taskLabel: 'Task',
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
const { document } = window;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const send = data => window.dispatchEvent(new window.MessageEvent('message', { data }));

const GROUPS = [
  {
    name: 'Basic Options', displayName: 'Basic Options', source: 'framework',
    fields: [
      { key: 'Trigger Interval', displayKey: 'Trigger Interval', default: 1, value: 1, type: null, desc: '' },
    ],
  },
  { name: 'Notification', displayName: 'Notification', source: 'framework', fields: [] },
];
const SNAPSHOTS = { 'Basic Options': { 'Trigger Interval': 800 } };

console.log('1. tasks + globalGroups 消息后配置分段渲染');
send({ type: 'tasks', tasks: [], schemas: {}, globalGroups: GROUPS, globalSnapshots: SNAPSHOTS, multiAccount: { available: false } });
send({ type: 'globalGroups', groups: GROUPS, snapshots: SNAPSHOTS, expanded: [] });
const pageConfig = document.getElementById('pageConfig');
assert(pageConfig, 'pageConfig 容器存在');
assert(document.querySelectorAll('#configList .gconfig-card').length === 2, '渲染 2 张全局组卡片');
assert(document.querySelector('#configList .gconfig-card .gconfig-card__body').hidden === true, '默认收起（body hidden）');

console.log('2. 点击组头 → 发出 toggleGlobalGroup(expanded=true)');
const head = document.querySelector('#configList .gconfig-card .gconfig-card__head--toggle');
head.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const toggleMsg = sent.filter(m => m.type === 'toggleGlobalGroup').pop();
assert(toggleMsg, '点击组头发出 toggleGlobalGroup');
assert(toggleMsg.name === 'Basic Options' && toggleMsg.expanded === true, `expanded=true（got ${JSON.stringify(toggleMsg)}）`);

console.log('3. 宿主回推 expanded 后重渲染 → 展开渲染出表单');
send({ type: 'globalGroups', groups: GROUPS, snapshots: SNAPSHOTS, expanded: ['Basic Options'] });
const body = document.querySelector('#configList .gconfig-card .gconfig-card__body');
assert(body.hidden === false, '展开后 body 可见');
assert(body.querySelector('.config-panel'), '展开后渲染出 config-panel 表单');

console.log('4. 再次点击 → toggle 为收起');
sent.length = 0;
document.querySelector('#configList .gconfig-card .gconfig-card__head--toggle')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const toggleMsg2 = sent.filter(m => m.type === 'toggleGlobalGroup').pop();
assert(toggleMsg2 && toggleMsg2.expanded === false, '第二次点击 expanded=false');

console.log('\n全部通过');
