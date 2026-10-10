const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/run/publishDiff.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
Function('require', 'module', 'exports', js)(require, mod, mod.exports);
const { diffPublishSets, countUnpublished, fingerprintBox } = mod.exports;
const diffs = diffPublishSets(
  [
    { name: 'a', draftFingerprint: '1,2,3,4' },
    { name: 'b', draftFingerprint: '0,0,10,10' },
    { name: 'c', draftFingerprint: '1' },
  ],
  [
    { name: 'a', publishedFingerprint: '1,2,3,4' },
    { name: 'b', publishedFingerprint: '0,0,11,10' },
    { name: 'd', publishedFingerprint: '9' },
  ],
);
const by = Object.fromEntries(diffs.map((d) => [d.name, d.status]));
assert.strictEqual(by.a, 'published');
assert.strictEqual(by.b, 'modified');
assert.strictEqual(by.c, 'draft-only');
assert.strictEqual(by.d, 'orphan-published');
assert.strictEqual(countUnpublished(diffs), 2);
assert.strictEqual(fingerprintBox({ bbox: [1.2, 3.7, 4, 5] }), '1,4,4,5');
console.log('ok  publish diff');
