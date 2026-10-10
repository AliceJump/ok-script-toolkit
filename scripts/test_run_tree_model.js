const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ts = require('typescript');

// Compile treeModel + deps on the fly without pulling vscode.
const root = path.resolve(__dirname, '..');
function loadTs(rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  // Strip vscode-only type imports; treeModel only imports types from ./status and ./types
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(path.join(root, rel));
  const req = (id) => {
    if (id.startsWith('.')) {
      const resolved = path.join(dirname, id.endsWith('.ts') ? id : id + '.ts');
      if (fs.existsSync(resolved)) return loadTs(path.relative(root, resolved));
      const jsPath = resolved.replace(/\.ts$/, '.js');
      if (fs.existsSync(jsPath)) return require(jsPath);
    }
    return require(id);
  };
  Function('require', 'module', 'exports', '__dirname', '__filename', js)(req, mod, mod.exports, dirname, path.join(root, rel));
  return mod.exports;
}

const { buildRunTree, taskKeyOf } = loadTs('src/run/treeModel.ts');

const tasks = [
  { module: 'a', className: 'T1', displayName: '自动对话', kind: 'trigger' },
  { module: 'a', className: 'T2', displayName: '自动战斗', kind: 'trigger' },
  { module: 'b', className: 'Daily', displayName: '每日任务', kind: 'onetime' },
  { module: 'b', className: 'Mail', displayName: '领取邮件', kind: 'onetime' },
];
const schemas = {
  'b::Daily': { fields: [], groupName: '日常' },
  'b::Mail': { fields: [] },
};
const tree = buildRunTree({
  game: { connected: true, title: 'Endfield' },
  executor: { status: 'running', paused: false, current: '每日任务', queued: 1, triggers: 1 },
  tasks,
  schemas,
  enabledTriggers: ['a::T1'],
  currentTaskKey: 'b::Daily',
  onetimeQueue: ['b::Mail'],
  globalGroups: [{ name: 'window', displayName: '窗口', fields: [] }],
  globalOverrides: { window: { w: 1 } },
  accounts: { available: true, names: ['主号'], active: '主号' },
});

assert.strictEqual(tree.length, 6);
assert.strictEqual(tree[0].kind, 'game');
assert.ok(tree[0].description.includes('Endfield'));
assert.strictEqual(tree[1].kind, 'executor');
assert.ok(tree[1].description.includes('每日任务'));
const triggers = tree[2];
assert.strictEqual(triggers.children.length, 2);
assert.strictEqual(triggers.children[0].checked, true);
assert.strictEqual(triggers.children[1].checked, false);
assert.strictEqual(triggers.description, '1/2 已启用');
const onetimes = tree[3];
assert.strictEqual(onetimes.children.length, 2); // 日常 + 未分组
const daily = onetimes.children.find((g) => g.label === '日常');
assert.ok(daily);
assert.strictEqual(daily.children[0].contextValue, 'run.task.running');
assert.strictEqual(daily.children[0].description, '运行中');
const ungrouped = onetimes.children.find((g) => g.label === '未分组');
assert.strictEqual(ungrouped.children[0].description, '排队 #1');
assert.strictEqual(tree[4].description.includes('1 处覆盖'), true);
assert.strictEqual(tree[5].children[0].label, '主号');
assert.strictEqual(taskKeyOf(tasks[0]), 'a::T1');
console.log('ok  run tree model');
