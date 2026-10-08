'use strict';
const ts = require('typescript');

// 按 TypeScript 实际字符串值读取转义，避免把 \n、引号等当作不同的翻译键。
function trLiterals(source, fileName = 'source.ts', functionName = 'tr') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName) {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) result.push(first.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
module.exports = { trLiterals };
