/**
 * 查找模板 / 位置资源在 Python 代码里的引用（纯函数部分）。
 * 认三种写法：<别名>.<名字>（fL.btn）、self.pos.<路径>、以及字符串键 "名字"（feature key）。
 */
export interface TextReference {
  line: number;
  column: number;
  length: number;
  kind: 'feature' | 'position' | 'key';
  preview: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findReferencesInText(text: string, name: string, aliases: string[]): TextReference[] {
  if (!name) return [];
  const n = escapeRe(name);
  const alias = aliases.length ? aliases.map(escapeRe).join('|') : 'fL';
  const patterns: [TextReference['kind'], RegExp][] = [
    ['feature', new RegExp(`\\b(?:${alias})\\.${n}(?![\\w])`, 'g')],
    ['position', new RegExp(`\\bself\\.pos\\.${n}(?![\\w])`, 'g')],
    ['key', new RegExp(`(["'])${n}\\1`, 'g')],
  ];
  const out: TextReference[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, line) => {
    const trimmed = lineText.trimStart();
    if (trimmed.startsWith('#')) return;
    for (const [kind, re] of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(lineText); m; m = re.exec(lineText)) {
        out.push({ line, column: m.index, length: m[0].length, kind, preview: trimmed.slice(0, 160) });
      }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
