'use strict';

/**
 * 校验 `l10n/bundle.l10n*.json` 的语言包对等性。
 *
 * 为什么需要这个脚本：`bundle.l10n.json`（英文原文）是**权威键集**，
 * 其它语言文件只是它的翻译。以前没有人核对，于是 5 个语言包长期各缺 3 个真实键
 * —— 缺键时 VS Code 会静默回落成英文，用户看到的是一句中英夹杂的界面，
 * 而 CI 全绿、没人发现（2026-09 实测：`LabelEnum.py file path…` 等 3 个键缺失）。
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

console.log(`✓ ${localeFiles.length} 个语言包与 ${BASE_FILE} 对等（各 ${baseKeys.size} 个键）`);
