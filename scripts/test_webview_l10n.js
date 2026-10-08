'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { trLiterals } = require('./release/l10n-literals');
const root = path.resolve(__dirname, '..');
const locales = ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'es'];
const dictionaries = locales.map(locale => JSON.parse(fs.readFileSync(path.join(root, 'l10n/webview.' + locale + '.json'), 'utf8')));
const keys = Object.keys(dictionaries[0]).sort();
for (let i = 0; i < locales.length; i++) {
  assert.deepStrictEqual(Object.keys(dictionaries[i]).sort(), keys, locales[i]);
  assert(Object.values(dictionaries[i]).every(value => typeof value === 'string' && value.length > 0), locales[i]);
}
let calls = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) for (const key of trLiterals(fs.readFileSync(file, 'utf8'), file, 't')) {
      calls++;
      assert(keys.includes(key), `${path.relative(root, file)}: missing translation ${key}`);
    }
  }
}
walk(path.join(root, 'media'));
assert(calls > 200, 'the scan must reach actual webview UI calls');
const exportsUnderTest = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'out/localization.js'), 'utf8'), {
  __dirname: path.join(root, 'out'), exports: exportsUnderTest,
  require: name => name === 'vscode' ? { env: { language: 'en' } } : require(name),
});
for (const locale of locales) {
  const actual = exportsUnderTest.webviewStrings(locale);
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(dictionaries[locales.indexOf(locale)]));
  assert.strictEqual(exportsUnderTest.formatWebviewString(actual, 'templatesCount', { shown: 2, total: 3 }), actual.templatesCount.replace('{shown}', '2').replace('{total}', '3'));
}
assert.strictEqual(exportsUnderTest.webviewStrings('fr'), exportsUnderTest.webviewStrings('en'));
console.log(`webview translations: ${calls} literal calls covered in all six external dictionaries`);
