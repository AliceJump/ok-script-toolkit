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

const dictionary = {
  taskTitle: 'Tasks', refresh: 'Refresh', noTasks: 'No tasks', launch: 'Launch', stop: 'Stop',
  pause: 'Pause', resume: 'Resume', parameters: 'Parameters', collapseParameters: 'Collapse',
  oneTimeTask: 'One-time', triggerTask: 'Trigger',
  enableTrigger: 'Enable', triggerDisabled: 'Not enabled', triggerArmed: 'Armed',
  triggerEnqueued: 'Enqueued',
  triggerPolling: 'Polling', taskQueued: 'Waiting', taskRunning: 'Running',
  executorIdle: 'Executor stopped', executorConnecting: 'Starting executor…',
  executorRunning: 'Executor running · {count} trigger task(s) enqueued',
  executorPaused: 'Paused', startExecutor: 'Start executor', stopExecutor: 'Close executor', stopCurrent: 'Stop current task',
  launchSettings: 'Launch Settings', reset: 'Reset', saved: 'Auto-saved', noConfigParameters: 'None',
  schemaFailed: 'Failed {error}', current: 'Current', currentValue: '{value}',
  selectedOptionsHint: '{values}', structuredJsonHint: '', holdCtrlMulti: '', confirm: 'Confirm',
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
const { document } = window;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const send = data => window.dispatchEvent(new window.MessageEvent('message', { data }));

const TRIGGER_A = 'demo.triggers::TriggerA';
const TRIGGER_B = 'demo.triggers::TriggerB';
const ONETIME_C = 'demo.onetime::OnetimeC';
const tasks = [
  { module: 'demo.triggers', className: 'TriggerA', displayName: 'Trigger A', kind: 'trigger' },
  { module: 'demo.triggers', className: 'TriggerB', displayName: 'Trigger B', kind: 'trigger' },
  { module: 'demo.onetime', className: 'OnetimeC', displayName: 'Onetime C', kind: 'onetime' },
];
const schemas = {
  [TRIGGER_A]: { fields: [], kind: 'trigger', displayName: 'Trigger A' },
  [TRIGGER_B]: { fields: [], kind: 'trigger', displayName: 'Trigger B' },
  [ONETIME_C]: { fields: [], kind: 'onetime', displayName: 'Onetime C' },
};

const cardOf = key => document.querySelector(`.task-card[data-task-key="${key}"]`);
const badgeOf = key => cardOf(key).querySelector('[data-role="status"]');
const toggleOf = key => cardOf(key).querySelector('[data-role="trigger-toggle"]');

send({ type: 'tasks', tasks, schemas });

// 触发任务：勾选启用；一次性任务：启动按钮
assert(toggleOf(TRIGGER_A) && toggleOf(TRIGGER_B), 'trigger tasks must render an enable checkbox');
assert(cardOf(TRIGGER_A).querySelector('[data-role="launch"]') === null, 'trigger tasks must not render a launch button');
assert(cardOf(ONETIME_C).querySelector('[data-role="launch"]') !== null, 'one-time tasks must render a launch button');
assert(toggleOf(ONETIME_C) === null, 'one-time tasks must not render an enable checkbox');
assert(badgeOf(TRIGGER_A).textContent === 'Not enabled', 'idle trigger task must show the disabled badge');
assert(document.getElementById('executorState').textContent === 'Executor stopped', 'idle executor label');
assert(document.getElementById('stopExecutor').hidden, 'close-executor button must be hidden while idle');

// 执行器运行中：A 已入列并被轮询、B 未启用、C 排队中
send({
  type: 'executor',
  status: 'running',
  paused: false,
  current: TRIGGER_A,
  currentIsTrigger: true,
  onetimeQueue: [ONETIME_C],
  enabledTriggers: [TRIGGER_A],
});
assert(toggleOf(TRIGGER_A).checked && !toggleOf(TRIGGER_B).checked, 'checkbox must mirror the enqueued set');
assert(badgeOf(TRIGGER_A).textContent === 'Polling', 'current trigger task must show the polling badge');
assert(badgeOf(TRIGGER_B).textContent === 'Not enabled', 'disabled trigger task must show the disabled badge');
assert(badgeOf(ONETIME_C).textContent === 'Waiting', 'queued one-time task must show the waiting badge');
assert(cardOf(ONETIME_C).querySelector('[data-role="launch"]').disabled, 'queued one-time task must disable its launch button');
assert(!document.getElementById('stopExecutor').hidden, 'close-executor button must appear while running');
assert(document.getElementById('executorState').textContent === 'Executor running · 1 trigger task(s) enqueued', 'running executor label');

// 勾选 B → triggerSet；取消勾选 A → triggerSet(false)
sent.length = 0;
toggleOf(TRIGGER_B).checked = true;
toggleOf(TRIGGER_B).dispatchEvent(new window.Event('change', { bubbles: true }));
assert(sent.length === 1 && sent[0].type === 'triggerSet' && sent[0].enabled === true && sent[0].task.className === 'TriggerB', 'checking a trigger must post triggerSet');

// 一次性任务入队（先让队列空出来，否则按钮处于禁用态）
send({
  type: 'executor',
  status: 'running',
  paused: false,
  current: TRIGGER_A,
  currentIsTrigger: true,
  onetimeQueue: [],
  enabledTriggers: [TRIGGER_A],
});
sent.length = 0;
cardOf(ONETIME_C).querySelector('[data-role="launch"]').click();
assert(sent.length === 1 && sent[0].type === 'enqueue' && sent[0].task.className === 'OnetimeC', 'launching a one-time task must post enqueue');

// 工具栏：暂停 / 恢复 / 停止当前任务 / 关闭执行器
sent.length = 0;
document.getElementById('pauseToggle').click();
assert(sent.length === 1 && sent[0].type === 'pause', 'pause button must post pause while running');
document.getElementById('stopCurrent').click();
assert(sent[1] && sent[1].type === 'stopCurrent', 'stop-current button must post stopCurrent');
document.getElementById('stopExecutor').click();
assert(sent[2] && sent[2].type === 'stopExecutor', 'close-executor button must post stopExecutor');

send({ type: 'executor', status: 'running', paused: true, current: '', onetimeQueue: [], enabledTriggers: [TRIGGER_A] });
assert(document.getElementById('pauseToggle').textContent.includes('Resume'), 'paused executor must offer resume');
assert(document.getElementById('executorState').textContent === 'Paused', 'paused executor label');
sent.length = 0;
document.getElementById('pauseToggle').click();
assert(sent.length === 1 && sent[0].type === 'resume', 'pause toggle must post resume when paused');

// 执行器关闭后回到 idle
send({ type: 'executor', status: 'idle', paused: false, current: '', onetimeQueue: [], enabledTriggers: [TRIGGER_A] });
assert(document.getElementById('stopExecutor').hidden, 'close-executor button must hide once stopped');
// 执行器没跑时不能显示「已入列」——那时根本没在轮询，会误导用户。
// 改成「已启用」表达「已记录，待启动」。
assert(badgeOf(TRIGGER_A).textContent === 'Armed', 'enabled trigger must show armed (not enqueued) while executor is idle');

// ── 显式启动按钮 ──────────────────────────────────────────────────────
// idle 时可见，点击发 startExecutor；执行器起来后隐藏
const startExecutorButton = document.getElementById('startExecutor');
assert(!startExecutorButton.hidden, 'start-executor button must be visible while idle');
sent.length = 0;
startExecutorButton.click();
assert(sent.length === 1 && sent[0].type === 'startExecutor', 'start-executor button must post startExecutor');

send({ type: 'executor', status: 'connecting', paused: false, current: '', onetimeQueue: [], enabledTriggers: [] });
assert(startExecutorButton.hidden, 'start-executor button must hide while connecting');
send({ type: 'executor', status: 'running', paused: false, current: '', onetimeQueue: [], enabledTriggers: [TRIGGER_A] });
assert(startExecutorButton.hidden, 'start-executor button must hide while running');
assert(badgeOf(TRIGGER_A).textContent === 'Enqueued', 'enabled trigger must show enqueued once the executor runs');

// 勾选触发任务只发 triggerSet，绝不顺带启动执行器（裸 webview 无宿主，这里只验证不发额外消息）
sent.length = 0;
const toggleB = toggleOf(TRIGGER_B);
toggleB.checked = true;
toggleB.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(sent.length === 1 && sent[0].type === 'triggerSet', 'checking a trigger must only post triggerSet');

console.log(JSON.stringify({ executorUi: 'ok', lastMessages: sent }));
