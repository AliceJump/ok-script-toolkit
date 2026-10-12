const assert = require('assert');
const path = require('path');
const { featureHoverLinks, HOVER_ENABLED_COMMANDS } = require(path.join(__dirname, '..', 'out', 'hoverLinks'));
const md = featureHoverLinks('btn_claim', { reveal: '在资源中定位', refs: '查找引用' });
assert.strictEqual(md,
  '[$(search) 在资源中定位](command:okScriptToolkit.revealResource?%5B%22btn_claim%22%5D) · '
  + '[$(references) 查找引用](command:okScriptToolkit.findTemplateReferences?%5B%22btn_claim%22%5D)');
// 链接里出现的命令必须都在白名单内
for (const m of md.matchAll(/command:([\w.]+)/g)) assert.ok(HOVER_ENABLED_COMMANDS.includes(m[1]), m[1]);
// 名字里的特殊字符被编码，不能闭合 markdown 链接
assert.ok(!featureHoverLinks('a)b', { reveal: 'r', refs: 'f' }).includes('a)b'));
console.log('ok  hover links snapshot');
