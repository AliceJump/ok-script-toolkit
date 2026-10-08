'use strict';
const assert = require('assert');
const { trLiterals } = require('./release/l10n-literals');
const source = [
  "tr('Confirm:\\n{files}')",
  "tr('User\\'s choice')",
  'tr(`Cost $5`)',
  'tr(`Dynamic ${value}`)',
  '// tr("Comment")',
  'const text = "tr(\\\"Text\\\")"',
  'tr(variable)',
  'function tr(message: string) { return message; }',
  'wrap(tr("Nested"))',
].join('\n');
assert.deepStrictEqual(trLiterals(source), ['Confirm:\n{files}', "User's choice", 'Cost $5', 'Nested']);
console.log('l10n literal decoding tests passed');
