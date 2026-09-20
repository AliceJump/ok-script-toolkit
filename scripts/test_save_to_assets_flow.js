#!/usr/bin/env node
/**
 * 「保存到 assets」纯逻辑测试（`src/saveToAssetsPure.ts`）。
 *
 * 背景：枚举路径的输入框此前**每次保存都弹**（预填上次的值，回车即可）。
 * 改成"有默认值就不再问"之后，多出两条必须钉住的不变量 ——
 * 它们都属于**改错也看不出来**的那类：
 *
 * 1. **跳过输入框 ⇒ 必须留一个改的口子。**
 *    那个输入框是设置"个人枚举路径"（`globalState.lastEnumFilePath`）的**唯一**写入点，
 *    跳过它而不给替代入口，用户就再也改不了自己的枚举路径 —— 功能静默丢失。
 * 2. **不跳过 ⇒ 不能多出那一项。**
 *    否则变成"既问了、又给一个改的入口"，用户看到两个都能改路径的地方。
 *
 * 所以「改路径」项必须**当且仅当**跳过输入框时出现 —— 这条双向的"当且仅当"
 * 就是本文件的主要断言。
 *
 * 本模块刻意不 import `vscode`，所以这里**不需要任何桩**，直接 require 编译产物。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pure = require(path.join(root, 'out', 'saveToAssetsPure'));

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

const TARGETS = [
  { label: 'assets', description: 'standalone app', folder: '/ws/assets' },
  { label: 'ok_tasks/assets', description: 'custom scripts', folder: '/ws/ok_tasks/assets' },
];
const CHANGE_LABEL = 'Change LabelEnum.py path...';

const items = (enumPath) =>
  pure.saveToAssetsItems({ targets: TARGETS, enumPath, changePathLabel: CHANGE_LABEL });

const isChangeItem = (item) => item.label === CHANGE_LABEL;

// ── 1. 保存目标永远都在 ───────────────────────────────────────────────
console.log('保存目标');
{
  for (const [name, enumPath] of [['没有默认路径', ''], ['有默认路径', 'src/data/LabelEnum.py']]) {
    const list = items(enumPath);
    const targets = list.filter((i) => !isChangeItem(i));
    check(
      targets.length === TARGETS.length && targets.every((t, i) => t.label === TARGETS[i].label),
      `${name}：两个保存目标都在，且顺序不变`,
    );
    check(
      targets.every((t, i) => t.target === TARGETS[i].folder),
      `${name}：每个目标的 target 指向自己的绝对目录`,
    );
  }
  check(
    items('').every((i) => i.description !== undefined),
    '每一项都带说明文案（目标项带自己的描述）',
  );
}

// ── 2. 「改路径」项当且仅当跳过输入框时出现 ──────────────────────────
console.log('\n跳过输入框 ⇔ 提供改路径的入口');
{
  const withDefault = items('src/data/FeatureList.py');
  check(
    withDefault.filter(isChangeItem).length === 1,
    '**有默认路径时会跳过输入框，所以必须给出「改路径」项** —— 否则用户再也改不了自己的枚举路径',
  );
  check(withDefault.length === TARGETS.length + 1, '那一项追加在末尾，不插进目标之间');

  const withoutDefault = items('');
  check(
    withoutDefault.filter(isChangeItem).length === 0,
    '**没有默认路径时仍然会问，所以不能多出「改路径」项** —— 否则出现两个都能改路径的地方',
  );
  check(withoutDefault.length === TARGETS.length, '没默认路径时列表里只有目标');

  const change = withDefault.find(isChangeItem);
  check(change.target === undefined, '**「改路径」项没有 target** —— 点它不会误触发保存');
  check(
    change.description === 'src/data/FeatureList.py',
    '描述里显示当前值（用户得知道现在用的是什么，才知道要不要改）',
  );
  check(change.label === CHANGE_LABEL, '文案由调用方传入（本模块不依赖 i18n）');
}

// ── 3. 什么时候需要先问一次 ──────────────────────────────────────────
console.log('\nneedsEnumPathPrompt');
{
  check(pure.needsEnumPathPrompt('') === true, '从没定过 → 必须问（留空即"不生成枚举"，这是唯一的跳过入口）');
  check(pure.needsEnumPathPrompt('   ') === true, '全空白等同于没定过');
  check(
    pure.needsEnumPathPrompt('src/data/FeatureList.py') === false,
    '**已经有默认路径 → 不问**（每次保存都按一次回车是纯噪音）',
  );
  check(
    pure.needsEnumPathPrompt('', true) === false,
    '**用户在「改路径」里显式清空 → 不问** —— 那表达的是"这次不生成枚举"，再问一遍只能按 Esc 取消整个保存',
  );
  check(
    pure.needsEnumPathPrompt('', true) === false && pure.needsEnumPathPrompt('  ', true) === false,
    'decided 与路径内容无关（清空后不追问这条不受空白写法影响）',
  );
  check(
    pure.needsEnumPathPrompt('src/data/FeatureList.py', true) === false,
    'decided 与"有值"是同一个结论，不冲突',
  );
}

// ── 4. 破坏性对照 ────────────────────────────────────────────────────
//
// 就地改造编译产物再求值。若对照跑出来的结果与期望相同，说明对应断言没在约束任何东西。
console.log('\n破坏性对照');
{
  const source = fs.readFileSync(path.join(root, 'out', 'saveToAssetsPure.js'), 'utf-8');

  function evalSandbox(code) {
    const sandbox = { exports: {} };
    new Function('module', 'exports', 'require', code)(sandbox, sandbox.exports, require);
    return sandbox.exports;
  }

  // 对照一：永远加「改路径」项（= 既问了又给入口）
  const always = source.replace(
    'if (!needsEnumPathPrompt(input.enumPath)) {',
    'if (true) {',
  );
  check(always !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
  const alwaysItems = evalSandbox(always).saveToAssetsItems({
    targets: TARGETS,
    enumPath: '',
    changePathLabel: CHANGE_LABEL,
  });
  check(
    alwaysItems.filter(isChangeItem).length === 1,
    '对照一：写死成"永远加"之后，没默认路径时也多出改路径项 —— 与第 2 组的期望相反',
  );

  // 对照二：永远不加「改路径」项（= 跳过了却没入口）
  const never = source.replace(
    'if (!needsEnumPathPrompt(input.enumPath)) {',
    'if (false) {',
  );
  check(never !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
  const neverItems = evalSandbox(never).saveToAssetsItems({
    targets: TARGETS,
    enumPath: 'src/data/FeatureList.py',
    changePathLabel: CHANGE_LABEL,
  });
  check(
    neverItems.filter(isChangeItem).length === 0,
    '对照二：写死成"永远不加"之后，跳过输入框却没有改路径的入口 —— 用户再也改不了枚举路径（功能静默丢失）',
  );

  // 对照三：改路径项带上 target（= 点它就会直接按某个目标保存）
  const withTarget = source.replace(
    'return { label, description: currentPath };',
    'return { label, description: currentPath, target: "/ws/assets" };',
  );
  check(withTarget !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
  const targetItems = evalSandbox(withTarget).saveToAssetsItems({
    targets: TARGETS,
    enumPath: 'src/data/FeatureList.py',
    changePathLabel: CHANGE_LABEL,
  });
  check(
    targetItems.find(isChangeItem).target !== undefined,
    '对照三：带上 target 后，点「改路径」会直接跳到保存 —— 与第 2 组的"没有 target"相反',
  );

  // 对照四：decided 被忽略（= 用户清空后又被追问）
  const ignoreDecided = source.replace(
    'return !decided && enumPath.trim().length === 0;',
    'return enumPath.trim().length === 0;',
  );
  check(ignoreDecided !== source, '对照四源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(ignoreDecided).needsEnumPathPrompt('', true) === true,
    '对照四：忽略 decided 后，用户显式清空仍会被追问 —— 与第 3 组的期望相反',
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
