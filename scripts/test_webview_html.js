'use strict';

/**
 * `escapeHtml` / `getNonce` / `errorPage` 的回归测试。
 *
 * 复现的缺陷：多个 panel 的 `buildHtml` 在读到视图文件失败时，把 `error.message`
 * **未转义**地拼进 HTML 返回给 webview。错误消息里含文件路径，而路径可以合法包含
 * `<` `>` `&` `"` —— 一个名为 `a<script>.json` 的文件就能在错误页里注入脚本。
 *
 * 另一个缺陷是 nonce 生成用了 `Math.random()`：nonce 是 CSP 唯一的信任凭据，
 * 可预测的 PRNG 等于没有凭据。
 */

const assert = require('assert');
const path = require('path');

// 编译产物平铺在 out/ 下（tsc 的 outDir 不带 src/ 前缀），沿用仓库其它测试脚本的加载方式
const outDir = path.join(__dirname, '..', 'out');
const { escapeHtml, getNonce, errorPage } = require(path.join(outDir, 'webviewHtml'));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

console.log('[1] escapeHtml 覆盖 HTML 危险字符');
check('转义 < > & " 与 \'', () => {
  assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
  assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
  assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
});
check('& 先于其它字符处理，不发生二次转义', () => {
  // 若先替换 < 再替换 &，会把 &lt; 变成 &amp;lt; —— 这是经典顺序错误
  assert.strictEqual(escapeHtml('<'), '&lt;');
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});
check('非字符串输入不抛异常', () => {
  assert.strictEqual(escapeHtml(undefined), 'undefined');
  assert.strictEqual(escapeHtml(null), 'null');
  assert.strictEqual(escapeHtml(42), '42');
});
check('恶意文件名样例被完全中和', () => {
  const hostile = 'D:\\proj\\a<script>alert(1)</script>.json';
  const escaped = escapeHtml(hostile);
  assert.ok(!escaped.includes('<script>'), '不得残留可执行标签');
  assert.ok(escaped.includes('&lt;script&gt;'), '应转义成实体');
});

console.log('[2] getNonce 形状与不可预测性');
check('长度固定为 32 且只用字母数字', () => {
  for (let i = 0; i < 200; i += 1) {
    const nonce = getNonce();
    assert.strictEqual(nonce.length, 32, `长度应为 32，实际 ${nonce.length}`);
    assert.ok(/^[A-Za-z0-9]+$/.test(nonce), `只应含字母数字：${nonce}`);
  }
});
check('两次调用不重复（不是常量/可预测序列）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(getNonce());
  assert.strictEqual(seen.size, 500, '500 次调用应产生 500 个不同 nonce');
});
check('字符分布无明显偏置（取模偏置已消除）', () => {
  // 62 个字符，各取 1/62；抽样 62000 个字符，每个字符期望出现 1000 次
  let sample = '';
  for (let i = 0; i < 1937; i += 1) sample += getNonce(); // 1937*32 ≈ 61984
  const counts = new Map();
  for (const ch of sample) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.ok(counts.size >= 60, `应覆盖几乎全部 62 个字符，实际 ${counts.size}`);
  // 若存在取模偏置，前 8 个字符会明显偏高；给 35% 的宽松容差
  const expected = sample.length / 62;
  for (const [ch, n] of counts) {
    assert.ok(
      n < expected * 1.35,
      `字符 ${ch} 出现 ${n} 次，超出期望 ${expected.toFixed(0)} 的 1.35 倍，疑似取模偏置`,
    );
  }
});

console.log('[3] errorPage 对消息做转义');
check('模板里的消息被转义', () => {
  const html = errorPage('Error', 'cannot read <path> & "file"');
  assert.ok(html.includes('&lt;path&gt;'), '消息必须转义');
  assert.ok(!html.includes('<path>'), '不得残留原始尖括号');
  assert.ok(html.startsWith('<!DOCTYPE html>'), '应是完整 HTML 文档');
});
check('标题同样被转义', () => {
  const html = errorPage('<b>t</b>', 'ok');
  assert.ok(html.includes('&lt;b&gt;t&lt;/b&gt;'));
  assert.ok(!html.includes('<b>t</b>'));
});
check('破坏性对照：未转义版本确实会注入', () => {
  const hostile = 'a<script>alert(1)</script>';
  const buggy = `<!DOCTYPE html><html><body>${'$'}{msg}</body></html>`.replace('${msg}', hostile);
  // 对照实现里标签是真的标签
  assert.ok(buggy.includes('<script>'), '对照实现确实含可执行标签，说明本测试能捕获该缺陷');
  // 真实现里不是
  assert.ok(!errorPage('Error', hostile).includes('<script>'));
});

console.log(`\n全部通过（${passed} 项）`);
