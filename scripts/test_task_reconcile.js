#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const { reconcileTaskList } = require(path.join(path.resolve(__dirname, '..'), 'out', 'taskReconcile'));

const ast = [
  { module: 'ok', className: 'DiagnosisTask', displayName: 'Diagnosis', kind: 'onetime' },
  { module: 'src.tasks', className: 'DailyTask', displayName: 'Daily', kind: 'trigger' },
];
assert.strictEqual(reconcileTaskList(ast, {}), ast, 'AST remains the first paint before probing');

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
