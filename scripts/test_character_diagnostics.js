const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/run/characterDiagnostics.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
Function('exports', js)(mod.exports);
const { issuesToDiagnostics } = mod.exports;
const out = issuesToDiagnostics(
  [{ message: 'missing id', severity: 'error', source: { fileName: 'char_a.json' } }],
  { characterDir: '/proj/skills' },
);
assert.strictEqual(out.length, 1);
assert.strictEqual(out[0].line, 0);
assert.ok(out[0].file.includes('char_a.json'));
console.log('ok  character diagnostics');
