#!/usr/bin/env node
/**
 * 项目约定文件的**示例与 schema 必须一致**。
 *
 * 为什么值得单独一条测试：schema 里每一层都是 `additionalProperties: false` ——
 * 也就是说**示例里打错一个键名，照抄示例的用户立刻会看到"未知属性"的校验报错**，
 * 而报错看起来像是插件/schema 的问题，不是示例的问题。反方向同理：
 * schema 里声明了、示例里没展示的字段，用户就不知道该写。
 *
 * 这条测试在 2026-09-21 抓到一次真实漂移：`templates.cocoAnnotations`
 * 已经接线（schema 有、两端代码都读），但示例里没有 ——
 * 文档说"可直接复制的示例"，复制出来就是缺一块的。
 *
 * 不需要任何桩（只读 JSON 文件）。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'ok-script-toolkit.schema.json'), 'utf-8'));
const example = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'ok-script-toolkit.example.json'), 'utf-8'));

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

/** schema 里「是叶子字段」的路径（带 properties 的算分组，不算叶子）。 */
function leafPaths(node, prefix = '', out = []) {
  if (!node || !node.properties) return out;
  for (const [key, value] of Object.entries(node.properties)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (value && value.properties) leafPaths(value, p, out);
    else out.push({ path: p, type: value.type });
  }
  return out;
}

function valueAt(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** 与 schema 类型对得上吗（示例是手写 JSON，类型写错同样会让用户照抄到错值）。 */
function typeMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return true; // 没写 type 的（如 $schema）不校验
}

// ── 1. 示例覆盖 schema 的每个字段 ────────────────────────────────────
console.log('示例 ↔ schema 一致性');
{
  const leaves = leafPaths(schema).filter((l) => l.path !== '$schema');
  check(leaves.length >= 15, `schema 里扫到 ${leaves.length} 个叶子字段 —— **不能让扫描静默扫空**（空集比较会恒真）`);

  const missing = leaves.filter((l) => valueAt(example, l.path) === undefined).map((l) => l.path);
  check(
    missing.length === 0,
    missing.length === 0
      ? `示例展示了 schema 的全部 ${leaves.length} 个字段`
      : `**示例缺这些字段**：${missing.join(', ')} —— 文档说它"可直接复制"，缺字段等于复制出一份不完整的约定`,
  );

  const badType = leaves
    .filter((l) => valueAt(example, l.path) !== undefined && !typeMatches(valueAt(example, l.path), l.type))
    .map((l) => `${l.path}（schema 要 ${l.type}，示例是 ${JSON.stringify(valueAt(example, l.path))}）`);
  check(badType.length === 0, badType.length === 0 ? '示例里每个值的类型都与 schema 一致' : `**类型不符**：${badType.join('；')}`);
}

// ── 2. 示例不能有 schema 之外的键（additionalProperties: false） ────
console.log('\n示例不含 schema 之外的键');
{
  // 逐层比对：schema 每层都声明了 additionalProperties: false，
  // 所以示例多一个键（哪怕只是拼错）就会让照抄的人看到校验报错。
  const extras = [];
  (function walk(node, value, prefix) {
    if (!node || !node.properties || value === null || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      const p = prefix ? `${prefix}.${key}` : key;
      const child = node.properties[key];
      if (!child) {
        extras.push(p);
        continue;
      }
      walk(child, value[key], p);
    }
  })(schema, example, '');

  check(
    extras.length === 0,
    extras.length === 0
      ? '示例里没有 schema 之外的键（每层都是 additionalProperties: false，多一个键就是一条假的校验报错）'
      : `**示例里有 schema 不认识的键**：${extras.join(', ')}`,
  );
}

// ── 3. 对照：把某个字段从示例里拿掉，第 1 组必须变红 ────────────────
console.log('\n破坏性对照');
{
  const leaves = leafPaths(schema).filter((l) => l.path !== '$schema');
  const victim = leaves[leaves.length - 1].path;
  const broken = JSON.parse(JSON.stringify(example));
  const parts = victim.split('.');
  // 只对**倒数第二层之前**做 reduce，最后一段才是要删的键 ——
  // 写成 `parts.reduce(...)` 会把最后一段也走完，拿到的是**值**（字符串），
  // `delete` 作用在字符串上等于没删，对照就恒真了。
  const parent = parts.slice(0, -1).reduce((acc, k) => acc[k], broken);
  delete parent[parts[parts.length - 1]];
  const brokenMissing = leaves.filter((l) => valueAt(broken, l.path) === undefined).map((l) => l.path);
  check(
    brokenMissing.includes(victim),
    `对照：把示例里的 ${victim} 拿掉后会漏出来 —— 证明第 1 组确实在约束"示例覆盖全部字段"`,
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
