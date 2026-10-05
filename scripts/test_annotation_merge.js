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
  assert.strictEqual(result.conflicts[0].mergedIndex, 0);
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
  assert.strictEqual(result.conflicts[0].mergedIndex, undefined);
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
  const base = [ann(1, 'shared.category', 10, 10)];
  const local = [ann(2, 'shared.category', 30, 10)];
  const external = [ann(3, 'shared.category', 15, 10)];
  const result = mergeAnnotations('template', base, local, external);
  assert.strictEqual(result.conflicts.length, 1, 'template replacement must not inherit identity from category alone');
  assert.strictEqual(result.conflicts[0].kind, 'add-add');
  assert.strictEqual(result.merged[0].id, 2, 'local replacement stays independent from the external original');
}

{
  const base = [ann(1, 'screen.same', 10, 10)];
  const local = [ann(20, 'screen.same', 11, 10)];
  const external = [ann(30, 'screen.same', 10, 12)];
  const result = mergeAnnotations('rect', base, local, external);
  assert.strictEqual(result.conflicts.length, 0, 'rect identity remains category-based when persisted ids differ');
  assert.strictEqual(result.merged[0].x, 11);
  assert.strictEqual(result.merged[0].y, 12);
}

{
  const base = [ann(1, 'screen.same_point', 10, 10, 0, 0)];
  const local = [ann(20, 'screen.same_point', 11, 10, 0, 0)];
  const external = [ann(30, 'screen.same_point', 10, 12, 0, 0)];
  const result = mergeAnnotations('point', base, local, external);
  assert.strictEqual(result.conflicts.length, 0, 'point identity remains category-based when persisted ids differ');
  assert.strictEqual(result.merged[0].x, 11);
  assert.strictEqual(result.merged[0].y, 12);
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
  const base = [ann(1, 'screen.a', 10, 10)];
  const local = [ann(2, 'screen.b', 50, 50)];
  const external = [ann(2, 'screen.a', 15, 10)];
  const result = mergeAnnotations('template', base, local, external);
  assert.strictEqual(result.conflicts.length, 1,
    'template replacements with ambiguous branch-local ids become an explicit conflict');
  assert.strictEqual(result.conflicts[0].kind, 'add-add');
  assert.strictEqual(result.conflicts[0].local.category, 'screen.b');
  assert.strictEqual(result.conflicts[0].external.category, 'screen.a');
  assert.strictEqual(result.merged.length, 1,
    'the merge keeps the local candidate in the editable slot while retaining external data in conflict metadata');
  assert.strictEqual(result.merged[0].category, 'screen.b');
  assert.strictEqual(findAnnotationConflictItemIndex('template', result.merged, {
    key: 'synthetic', kind: 'delete-modify', fields: ['x'], external: external[0],
  }), -1, 'a conflict without a merge-owned slot never retargets by branch-local id');
}

{
  const base = [ann(1, 'screen.a', 10, 10), ann(2, 'screen.b', 20, 20)];
  const local = [ann(1, 'screen.a', 11, 10), ann(2, 'screen.b', 21, 20)];
  const result = mergeAnnotations('rect', base, local, []);
  assert.strictEqual(result.conflicts.length, 2);
  assert(result.conflicts[0].mergedIndex > result.conflicts[1].mergedIndex,
    'conflicts are ordered from higher to lower merge slot so removals cannot shift later targets');
}

console.log('annotation merge tests passed');
