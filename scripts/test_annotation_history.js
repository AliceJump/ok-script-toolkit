const assert = require('assert');
const { AnnotationHistory } = require('../out/annotationHistoryPure');

const history = new AnnotationHistory(true);
history.push('template', 't0', 't1');
history.push('rect', 'r0', 'r1');
history.push('point', 'p0', 'p1');

assert.strictEqual(history.undo('template').value, 'p0');
assert.strictEqual(history.undo('template').value, 'r0');

history.setSharedHistory(false);
assert.strictEqual(history.undo('template').value, 't0');
assert.strictEqual(history.undo('rect'), undefined, 'rect transaction already undone through shared history must not undo twice');
assert.strictEqual(history.redo('rect').value, 'r1');

history.setSharedHistory(true);
assert.strictEqual(history.redo('point').value, 't1', 'shared redo resumes the global chronology, including edits undone while history was isolated');
assert.strictEqual(history.redo('point').value, 'p1', 'already-redone rect transaction is skipped rather than applied twice');
assert.strictEqual(history.canUndo('point'), true);

console.log('annotation history tests passed');
