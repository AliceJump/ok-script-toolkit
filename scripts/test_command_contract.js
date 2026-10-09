/**
 * 命令契约：package.json 声明 ↔ 源码注册 ↔ nls 文案 ↔ menus/walkthrough 引用 必须一一对上。
 *
 * 防的是两类历史问题：
 *   1. 命令名不副实 / 声明了却没注册（命令面板里点了没反应）；
 *   2. menus / walkthrough 引用了不存在的命令，或 when 子句用了没人设置的 context key。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes;
const srcDir = path.join(root, 'src');
const source = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
  .map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
const nlsFiles = fs.readdirSync(root).filter((f) => /^package\.nls(\.[a-z-]+)?\.json$/.test(f));

const declared = new Set(contributes.commands.map((c) => c.command));
const registered = new Set([...source.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]));

console.log('1. 每条声明的命令都已注册');
for (const id of declared) assert(registered.has(id), `${id} 在 package.json 声明了，但 src 里没有 registerCommand`);

console.log('2. 每条注册的 okScriptToolkit.* 命令都已声明（命令面板可见）');
for (const id of registered) {
  if (id.startsWith('okScriptToolkit.')) assert(declared.has(id), `${id} 已注册但未在 contributes.commands 声明`);
}

console.log('3. 命令标题走 nls，且六种语言都有译文');
for (const cmd of contributes.commands) {
  const m = /^%(.+)%$/.exec(cmd.title);
  assert(m, `${cmd.command} 的 title 没走 nls`);
  for (const file of nlsFiles) {
    const nls = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert(typeof nls[m[1]] === 'string' && nls[m[1]].trim(), `${file} 缺 ${m[1]}`);
  }
}

console.log('4. menus 引用的命令都存在，导航组命令带图标');
for (const [menu, items] of Object.entries(contributes.menus || {})) {
  for (const item of items) {
    assert(declared.has(item.command), `menus.${menu} 引用了未声明的命令 ${item.command}`);
    if (menu === 'view/title' && String(item.group || '').startsWith('navigation')) {
      const cmd = contributes.commands.find((c) => c.command === item.command);
      assert(cmd.icon, `${item.command} 在视图标题栏 navigation 组，必须有 icon`);
    }
  }
}

console.log('5. when 子句里的 okScriptToolkit.* context key 都有 setContext');
const setKeys = new Set();
for (const m of source.matchAll(/'setContext',\s*'([^']+)'/g)) setKeys.add(m[1]);
for (const m of source.matchAll(/const\s+\w+_CONTEXT\s*=\s*'([^']+)'/g)) setKeys.add(m[1]);
const viewIds = new Set(Object.values(contributes.views || {}).flat().map((v) => v.id));
const whenTexts = [];
for (const items of Object.values(contributes.menus || {})) for (const item of items) if (item.when) whenTexts.push(item.when);
for (const when of whenTexts) {
  for (const m of when.matchAll(/okScriptToolkit\.[A-Za-z]+(?![A-Za-z.])/g)) {
    if (viewIds.has(m[0])) continue; // view == <id>
    assert(setKeys.has(m[0]), `when 子句用了 ${m[0]}，但源码里没有 setContext 它`);
  }
}

console.log('6. walkthrough / nls 里的 command: 链接指向已声明命令');
for (const file of nlsFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const m of text.matchAll(/command:(okScriptToolkit\.[A-Za-z.]+)/g)) {
    assert(declared.has(m[1]), `${file} 链接了未声明的命令 ${m[1]}`);
  }
}

console.log('\n全部通过');
