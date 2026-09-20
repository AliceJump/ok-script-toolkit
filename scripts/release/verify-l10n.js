'use strict';

/**
 * 校验 `l10n/bundle.l10n*.json` 的语言包对等性。
 *
 * 为什么需要这个脚本：`bundle.l10n.json`（英文原文）是**权威键集**，
 * 其它语言文件只是它的翻译。以前没有人核对，于是 5 个语言包长期各缺 3 个真实键
 * —— 缺键时 VS Code 会静默回落成英文，用户看到的是一句中英夹杂的界面，
 * 而 CI 全绿、没人发现（2026-09 实测：`LabelEnum.py file path…` 等 3 个键缺失）。
 *
 * 但"6 个 bundle 彼此对等"只是**一半**：如果某个 `tr('...')` 的字符串压根没进
 * 任何一个 bundle，6 个 bundle 依然对等、CI 依然全绿，而用户在**所有**语言下
 * 看到的都是英文原文 —— 同样是静默的。所以这里顺带扫一遍 `src` 下的 `.ts` 文件里
 * 的 `tr()` 字面量，逐个核对是否在 base bundle 里（见下方 §覆盖率）。
 *
 * 与 `verify-version.js` 一样是**零依赖的纯 Node 脚本**，可以在 CI 与
 * `npm test` 里低成本跑。
 *
 * 退出码：0 = 全部对等；1 = 有缺失/多余键。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const l10nDir = path.join(root, 'l10n');
const BASE_FILE = 'bundle.l10n.json';

if (!fs.existsSync(l10nDir)) {
  throw new Error(`Missing l10n directory: ${l10nDir}`);
}

const localeFiles = fs.readdirSync(l10nDir)
  .filter((name) => /^bundle\.l10n(\.[a-z]{2}(-[a-z]{2})?)?\.json$/.test(name))
  .sort();

if (!localeFiles.includes(BASE_FILE)) {
  throw new Error(`Missing base bundle ${BASE_FILE} in ${path.relative(root, l10nDir)}`);
}

const readBundle = (name) => JSON.parse(fs.readFileSync(path.join(l10nDir, name), 'utf8'));
const baseKeys = new Set(Object.keys(readBundle(BASE_FILE)));

const problems = [];
for (const name of localeFiles) {
  if (name === BASE_FILE) continue;
  const keys = new Set(Object.keys(readBundle(name)));
  const missing = [...baseKeys].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !baseKeys.has(key));

  if (missing.length || extra.length) {
    problems.push({ name, missing, extra });
  }
}

if (problems.length) {
  // 报全量而不是第一处：一次改完比来回跑 CI 便宜
  for (const { name, missing, extra } of problems) {
    console.error(`✗ ${name}`);
    for (const key of missing) console.error(`    缺少: ${JSON.stringify(key)}`);
    for (const key of extra) console.error(`    多余（不在 ${BASE_FILE} 里）: ${JSON.stringify(key)}`);
  }
  console.error(
    `\n共 ${problems.length} 个语言包与 ${BASE_FILE} 不一致。\n` +
    `补译文时请填进对应语言的 bundle，不要只加在 ${BASE_FILE} —— 缺键会静默回落成英文。`,
  );
  process.exit(1);
}

// ── 覆盖率：src 下每个 tr('...') 字面量都要在 base bundle 里 ─────────────
//
// 只查**字面量**首参：`tr(someVariable)` 静态查不到，不能假装查过。
// 宿主侧所有面向用户的字符串都必须经 `localization.tr()`（见 AGENT.md 的
// 「不硬编码 i18n 字符串」约定），所以这个正则的覆盖面就是"用户可见文案"。
const srcDir = path.join(root, 'src');
const trLiterals = []; // { file, text }

if (fs.existsSync(srcDir)) {
  const tsFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) tsFiles.push(p);
    }
  })(srcDir);

  // 单引号 / 双引号 / 反引号（无插值）三种写法都收；`localization.ts` 里
  // `function tr(message: string…)` 的首参不是引号，天然不会命中。
  const TR_CALL = /\btr\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$\\]*)`)/g;
  for (const file of tsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(TR_CALL)) {
      trLiterals.push({ file: path.relative(root, file), text: match[1] ?? match[2] ?? match[3] });
    }
  }
}

const untranslated = trLiterals.filter(({ text }) => !baseKeys.has(text));

if (untranslated.length) {
  console.error(`✗ ${untranslated.length} 处 tr() 字面量不在 ${BASE_FILE} 里：`);
  for (const { file, text } of untranslated) {
    console.error(`    ${file}  ${JSON.stringify(text)}`);
  }
  console.error(
    `\n这些字符串会在**所有**语言下显示英文原文（不只是缺翻译）。\n` +
    `请把英文原文作为键补进全部 ${localeFiles.length} 个 bundle —— 键是英文原文，只有值是译文。`,
  );
  process.exit(1);
}

console.log(
  `✓ ${localeFiles.length} 个语言包与 ${BASE_FILE} 对等（各 ${baseKeys.size} 个键）\n` +
  `✓ src 下 ${trLiterals.length} 处 tr() 字面量全部有译文`,
);
