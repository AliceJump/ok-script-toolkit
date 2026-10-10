const assert = require('assert');
const path = require('path');
const { findReferencesInText } = require(path.join(__dirname, '..', 'out', 'templateReferences'));
const src = [
  'box = self.find_one(fL.btn_claim)',
  'self.click(Features.btn_claim)',
  '# fL.btn_claim in a comment is ignored',
  'other = fL.btn_claim_all  # different template',
  'self.pos.btn_claim.to_box()',
  'self.find_feature("btn_claim")',
].join('\n');
const refs = findReferencesInText(src, 'btn_claim', ['fL', 'Features']);
assert.deepStrictEqual(refs.map((r) => [r.line, r.kind]), [
  [0, 'feature'], [1, 'feature'], [4, 'position'], [5, 'key'],
]);
assert.strictEqual(refs[0].column, 20);
assert.deepStrictEqual(findReferencesInText(src, '', ['fL']), []);
assert.strictEqual(findReferencesInText('fL.a.b', 'a.b', ['fL']).length, 1); // 点号按字面匹配
console.log('ok  template references');
