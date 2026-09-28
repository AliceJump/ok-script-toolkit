#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const { reconcileCachedTaskList, reconcileTaskList } = require(path.join(path.resolve(__dirname, '..'), 'out', 'taskReconcile'));

const ast = [
  { module: 'ok', className: 'DiagnosisTask', displayName: 'Diagnosis', kind: 'onetime' },
  { module: 'src.tasks', className: 'DailyTask', displayName: 'Daily', kind: 'trigger' },
];
assert.strictEqual(reconcileCachedTaskList(ast, {}), ast, 'AST remains the first paint before probing');
assert.deepStrictEqual(reconcileTaskList(ast, {}), [], 'a successful empty probe removes cached tasks');

const cached = reconcileCachedTaskList(ast, {
  'ok::DiagnosisTask': { displayName: 'Cached diagnosis' },
  'src.deleted::OldTask': { displayName: 'Removed task' },
});
assert.deepStrictEqual(cached, [
  { module: 'ok', className: 'DiagnosisTask', displayName: 'Cached diagnosis', kind: 'onetime' },
  ast[1],
], 'first paint keeps fresh AST membership, fills cached labels, and drops deleted tasks');
assert.deepStrictEqual(reconcileCachedTaskList([...ast, {
  module: 'src.new', className: 'FreshTask', displayName: 'FreshTask', kind: 'onetime',
}], { 'ok::DiagnosisTask': { displayName: 'Cached diagnosis' } }).at(-1), {
  module: 'src.new', className: 'FreshTask', displayName: 'FreshTask', kind: 'onetime',
}, 'new tasks stay visible before the full probe completes');

const runtime = reconcileTaskList(ast, {
  'ok.task.DiagnosisTask::DiagnosisTask': { displayName: 'Diagnosis', kind: 'onetime', showInTaskTab: true },
  'src.tasks::DailyTask': { displayName: 'Daily translated', kind: 'trigger', showInTaskTab: true },
  'src.hidden::Helper': { showInTaskTab: false },
});
assert.deepStrictEqual(runtime, [
  { module: 'ok.task.DiagnosisTask', className: 'DiagnosisTask', displayName: 'Diagnosis', kind: 'onetime' },
  { module: 'src.tasks', className: 'DailyTask', displayName: 'Daily translated', kind: 'trigger' },
  { module: 'src.hidden', className: 'Helper', displayName: 'Helper', kind: 'onetime' },
]);
console.log('Task list follows runtime schema keys and keeps all registered tasks.');
