#!/usr/bin/env node
/**
 * 「保存到 assets」纯逻辑测试（`src/saveToAssetsPure.ts`）。
 *
 * 这一版的形态来自用户反馈：**「我希望在点击保存到 assets 时就可以直接设置路径和位置」**。
 * 此前枚举路径只能靠"没定过就弹一次输入框"来设、类名压根没有入口（只能去设置界面找，
 * 而那个设置藏在一堆项里）。现在改成：**列表里永远有两行可以直接点改的项**。
 *
 * 必须钉住的不变量（都属于**改错也看不出来**的那类）：
 *
 * 1. **保存目标永远在，顺序不变** —— 它们是这个对话框存在的理由。
 * 2. **两行枚举设置永远在，且都没有 `target`。**
 *    永远在 = "点保存就能直接设"这个承诺；没有 `target` = "点错就误保存"在类型上不可能。
 * 3. **首次仍然会问一次路径**（`needsEnumPathPrompt`）—— 不问会让从没配过的用户
 *    **静默拿不到枚举文件**。"问了"与"也有行"并存是刻意的，不是重复。
 * 4. **预填值是推导出来的**（`derivedEnumPath`）—— 否则按回车等于"不生成枚举"。
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
const LABELS = {
  path: 'Enum file path',
  name: 'Enum class name',
  notSet: 'Not set — click to set',
  derived: 'Not set — follows the project convention',
};

const items = (enumPath, enumName = '') =>
  pure.saveToAssetsItems({ targets: TARGETS, enumPath, enumName, labels: LABELS });

const fieldRows = (list) => list.filter((i) => i.edit);
const rowOf = (list, field) => list.find((i) => i.edit === field);

// ── 1. 保存目标永远都在 ───────────────────────────────────────────────
console.log('保存目标');
{
  for (const [name, enumPath, enumName] of [
    ['什么都没设过', '', ''],
    ['路径与类名都设过', 'src/data/LabelEnum.py', 'FeatureList'],
  ]) {
    const list = items(enumPath, enumName);
    const targets = list.filter((i) => i.target);
    check(
      targets.length === TARGETS.length && targets.every((t, i) => t.label === TARGETS[i].label),
      `${name}：两个保存目标都在，且顺序不变`,
    );
    check(
      targets.every((t, i) => t.target === TARGETS[i].folder),
      `${name}：每个目标的 target 指向自己的绝对目录`,
    );
    check(
      targets.every((t) => t.edit === undefined),
      `${name}：目标项不带 edit —— 点它就走保存，不会去弹输入框`,
    );
  }
}

// ── 2. 两行枚举设置：永远在、没有 target、显示当前值 ──────────────────
console.log('\n枚举路径 / 类名两行');
{
  const empty = items('', '');
  const filled = items('src/data/FeatureList.py', 'FeatureList');

  check(
    fieldRows(empty).length === 2,
    '**什么都没设过时，两行依然在** —— 这就是"点保存就能直接设"的入口；少了它用户只能去设置界面找',
  );
  check(fieldRows(filled).length === 2, '设过之后两行也在（随时能改）');

  check(
    fieldRows(empty).every((i) => i.target === undefined),
    '**两行都没有 target** —— 点它只弹输入框，不会误触发保存',
  );
  check(
    fieldRows(filled).every((i) => i.target === undefined),
    '有值时也一样没有 target（不然"改个路径"会顺手把文件也保存了）',
  );

  check(
    rowOf(empty, 'enumPath').description === LABELS.notSet,
    '路径没定过时显示"未设置 —— 点这里设置"，用户才知道这里能点',
  );
  check(
    rowOf(filled, 'enumPath').description === 'src/data/FeatureList.py',
    '路径有值时显示当前值（用户得知道现在用的是什么，才知道要不要改）',
  );
  check(
    rowOf(empty, 'enumName').description === LABELS.derived,
    '类名没设过时显示"未设置 —— 跟随项目约定"（取值链是「个人偏好 > 项目约定 > 文件名」，'
      + '这里只是**我这一层**没设过，不等于会由文件名推导）',
  );
  check(
    rowOf(filled, 'enumName').description === 'FeatureList',
    '类名设过时显示我设的值',
  );

  check(
    empty.slice(-2).every((i) => i.edit) && filled.slice(-2).every((i) => i.edit),
    '两行固定在末尾，不插进保存目标之间（"保存"才是这一步的主意图）',
  );
  const sep = empty.findIndex((i) => i.separator);
  check(
    sep === TARGETS.length,
    '分隔线在目标之后、枚举两行之前 —— 两组分开才看得出"上面是保存、下面是设置"',
  );
  check(
    empty[sep].target === undefined && empty[sep].edit === undefined,
    '分隔线既不是目标也不是可编辑项（它在 VS Code 里压根选不中）',
  );
}

// ── 3. 什么时候需要先问一次 ──────────────────────────────────────────
console.log('\nneedsEnumPathPrompt');
{
  check(pure.needsEnumPathPrompt('') === true, '从没定过 → 必须问（留空即"不生成枚举"，这是唯一的跳过入口）');
  check(pure.needsEnumPathPrompt('   ') === true, '全空白等同于没定过');
  check(
    pure.needsEnumPathPrompt('src/data/FeatureList.py') === false,
    '**已经有生效路径 → 不问**（每次保存都按一次回车是纯噪音）',
  );
  check(
    pure.needsEnumPathPrompt('', true) === false,
    '**用户在那一行里显式清空 → 不问** —— 那表达的是"这次不生成枚举"，再问一遍只能按 Esc 取消整个保存',
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

// ── 4. 预填的推导值 ──────────────────────────────────────────────────
console.log('\nderivedEnumPath');
{
  check(
    pure.derivedEnumPath('assets') === 'assets/LabelEnum.py',
    'assets 目标 → assets/LabelEnum.py（按回车就能得到一个写在项目里的合法路径）',
  );
  check(
    pure.derivedEnumPath('ok_tasks/assets') === 'ok_tasks/assets/LabelEnum.py',
    '嵌套目录原样保留',
  );
  check(
    pure.derivedEnumPath('assets/') === 'assets/LabelEnum.py',
    '目录末尾多一个斜杠也不会拼出 assets//LabelEnum.py',
  );
  check(
    pure.derivedEnumPath('') === 'LabelEnum.py',
    '没有目标名时退化成裸文件名，不生成以斜杠开头的路径',
  );
}

// ── 5. 枚举输出必须留在工作区 ───────────────────────────────────────
console.log('\nisPathInsideRoot');
{
  const ws = path.join(path.sep, 'workspace', 'project');
  check(pure.isPathInsideRoot(ws, path.join(ws, 'src', 'LabelEnum.py')), '工作区内的枚举文件合法');
  check(pure.isPathInsideRoot(ws, ws), '工作区根本身仍属于工作区');
  check(!pure.isPathInsideRoot(ws, path.join(ws, '..', 'LabelEnum.py')), '拒绝解析到工作区外的路径');
  check(
    !pure.isPathInsideRoot(ws, path.join(path.sep, 'workspace', 'project-other', 'LabelEnum.py')),
    '同前缀的兄弟目录不算工作区内',
  );
}

// ── 6. 破坏性对照 ────────────────────────────────────────────────────
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

  const call = (mod, enumPath = '', enumName = '') =>
    mod.saveToAssetsItems({ targets: TARGETS, enumPath, enumName, labels: LABELS });

  // 对照一：路径行只在有值时才出现（= 回到"没设过就没入口"的旧形态）
  const PATH_PUSH =
    "items.push(enumFieldItem('enumPath', input.labels.path, input.enumPath, input.labels.notSet));";
  const conditional = source.replace(PATH_PUSH, `if (input.enumPath) ${PATH_PUSH}`);
  check(conditional !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    fieldRows(call(evalSandbox(conditional), '', '')).length === 1,
    '对照一：改成"只在有值时出现"之后，从没配过的用户就没有设置入口了 —— 与第 2 组的期望相反',
  );

  // 对照二：路径行带上 target（= 点它就会直接按某个目标保存）
  const withTarget = source.replace(
    'return { label, description: current || empty, edit: field };',
    "return { label, description: current || empty, edit: field, target: '/ws/assets' };",
  );
  check(withTarget !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    rowOf(call(evalSandbox(withTarget)), 'enumPath').target !== undefined,
    '对照二：带上 target 后，点「枚举文件路径」会直接跳到保存 —— 与第 2 组的"没有 target"相反',
  );

  // 对照三：decided 被忽略（= 用户清空后又被追问）
  const ignoreDecided = source.replace(
    'return !decided && enumPath.trim().length === 0;',
    'return enumPath.trim().length === 0;',
  );
  check(ignoreDecided !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(ignoreDecided).needsEnumPathPrompt('', true) === true,
    '对照三：忽略 decided 后，用户显式清空仍会被追问 —— 与第 3 组的期望相反',
  );

  // 对照四：推导值不拼目标目录（= 预填值变成一个项目根下的裸文件）
  const bare = source.replace(
    "return dir ? `${dir}/LabelEnum.py` : 'LabelEnum.py';",
    "return 'LabelEnum.py';",
  );
  check(bare !== source, '对照四源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(bare).derivedEnumPath('assets') === 'LabelEnum.py',
    '对照四：不拼目标目录之后，预填值落到项目根 —— 与第 4 组的期望相反',
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
