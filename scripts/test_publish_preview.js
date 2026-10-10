const assert = require('assert');
const path = require('path');
const { buildPublishPreview } = require(path.join(__dirname, '..', 'out', 'publishPreview'));
const p = buildPublishPreview({
  template: { targetLabel: 'assets/', enumPath: 'src/LabelEnum.py', draftNames: ['b', 'a', 'a'], publishedNames: ['a', 'old'] },
  position: { format: 'json', files: ['assets/positions.json'], rect: true, point: false },
});
assert.deepStrictEqual(p.files.map((f) => f.label), [
  'assets/coco_annotations.json', 'assets/images/', 'src/LabelEnum.py', 'assets/positions.json',
]);
assert.deepStrictEqual(p.templates.map((r) => `${r.kind}:${r.label}`), ['keep:a', 'add:b', 'remove:old']);
assert.deepStrictEqual(p.counts, { add: 1, keep: 1, remove: 1 });
const empty = buildPublishPreview({});
assert.deepStrictEqual(empty.files, []);
console.log('ok  publish preview');
