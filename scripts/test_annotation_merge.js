const assert = require('assert');
const { mergeAnnotations, findAnnotationConflictItemIndex } = require('../out/annotationMergePure');

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

{
  const base = [];
  const local = [
    ann(1, 'shared.category', 10, 10),
    ann(2, 'shared.category', 30, 10),
  ];
  const external = [
    ann(101, 'shared.category', 11, 10),
    ann(102, 'shared.category', 31, 10),
  ];
  const result = mergeAnnotations('template', base, local, external);
  assert.strictEqual(result.conflicts.length, 2, 'template mode allows multiple new annotations in one category');
  assert.strictEqual(new Set(result.conflicts.map(conflict => conflict.key)).size, 2,
    'each template add-add conflict has an independent choice key');
}

{
  const conflict = {
    key: 'template:5:shared.category',
    kind: 'modify-modify',
    fields: ['x'],
    base: ann(5, 'shared.category', 10, 10),
    local: ann(5, 'shared.category', 20, 10),
    external: ann(5, 'shared.category', 30, 10),
  };
  const merged = [
    ann(3, 'shared.category', 5, 5),
    ann(5, 'shared.category', 20, 10),
  ];
  assert.strictEqual(findAnnotationConflictItemIndex('template', merged, conflict), 1,
    'template conflict lookup prefers exact id even when an earlier annotation shares the category');
}

{
  const conflict = {
    key: 'template:5:shared.category',
    kind: 'delete-modify',
    fields: ['x'],
    base: ann(5, 'shared.category', 10, 10),
    external: ann(5, 'shared.category', 30, 10),
  };
  const merged = [ann(3, 'shared.category', 5, 5)];
  assert.strictEqual(findAnnotationConflictItemIndex('template', merged, conflict), -1,
    'template local deletion never falls back to a different same-category annotation');
}

console.log('annotation merge tests passed');
