const assert = require('assert');
const { mergeAnnotations } = require('../out/annotationMergePure');

const ann = (id, category, x, y, w = 10, h = 10) => ({ id, category, x, y, w, h });

{
  const base = [ann(1, 'screen.a', 10, 10), ann(2, 'screen.b', 20, 20)];
  const local = [ann(1, 'screen.a', 11, 10), ann(2, 'screen.b', 20, 20)];
  const external = [ann(1, 'screen.a', 10, 10), ann(2, 'screen.b', 20, 21)];
  const result = mergeAnnotations('rect', base, local, external);
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.merged.find(x => x.category === 'screen.a').x, 11);
  assert.strictEqual(result.merged.find(x => x.category === 'screen.b').y, 21);
}

{
  const base = [ann(7, 'title', 10, 10)];
  const local = [ann(7, 'title', 30, 10)];
  const external = [ann(7, 'title', 40, 10)];
  const result = mergeAnnotations('template', base, local, external);
  assert.strictEqual(result.conflicts.length, 1);
  assert.deepStrictEqual(result.conflicts[0].fields, ['x']);
  assert.strictEqual(result.merged[0].x, 30, 'local candidate stays editable while external candidate is retained in conflict data');
}

{
  const base = [ann(1, 'screen.point', 10, 10, 0, 0)];
  const local = [];
  const external = [ann(1, 'screen.point', 11, 10, 0, 0)];
  const result = mergeAnnotations('point', base, local, external);
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].kind, 'delete-modify');
  assert.strictEqual(result.conflicts[0].local, undefined);
}

{
  const base = [ann(4, 'old_name', 10, 10)];
  const local = [ann(4, 'new_name', 10, 10)];
  const external = [ann(4, 'old_name', 10, 15)];
  const result = mergeAnnotations('template', base, local, external);
  assert.strictEqual(result.conflicts.length, 0, 'template id lets rename and geometry edit merge');
  assert.strictEqual(result.merged[0].category, 'new_name');
  assert.strictEqual(result.merged[0].y, 15);
}

{
  const base = [];
  const local = [ann(1, 'screen.same', 10, 10)];
  const external = [ann(99, 'screen.same', 20, 10)];
  const result = mergeAnnotations('rect', base, local, external);
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].kind, 'add-add');
}

console.log('annotation merge tests passed');
