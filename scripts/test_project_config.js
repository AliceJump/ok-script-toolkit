#!/usr/bin/env node
/**
 * 项目约定文件的**取值链**测试（`src/projectConfigPure.ts`）。
 *
 * 这里刻意不碰 vscode / 文件系统 —— 读盘侧在 `projectConfig.ts`，纯逻辑在
 * `projectConfigPure.ts`，本仓库的既有约定就是"不依赖 IDE 的逻辑抽纯对象配单测"。
 *
 * 取值链（高 → 低）：个人偏好（IDE 设置 / 上次保存）> 项目约定文件 > 调用方兜底。
 * 用户明确定过：**个人偏好最高** —— 项目文件是团队开箱默认，我改过就用我的。
 */
const assert = require('assert');
const path = require('path');

const pure = require(path.join(path.resolve(__dirname, '..'), 'out', 'projectConfigPure'));

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

// ── 1. 解析容错 ──────────────────────────────────────────────────────
console.log('parseProjectConfig');
check(JSON.stringify(pure.parseProjectConfig(null)) === '{}', 'null -> 空配置');
check(JSON.stringify(pure.parseProjectConfig('字符串')) === '{}', '字符串 -> 空配置');
check(JSON.stringify(pure.parseProjectConfig([1, 2])) === '{}', '数组 -> 空配置（顶层必须是对象）');
check(
  pure.parseProjectConfig({ labelEnum: { path: 'a' } }).labelEnum.path === 'a',
  '正常对象按原样返回',
);

// ── 2. nonEmpty / nonEmptyStrings ───────────────────────────────────
console.log('\n取值助手');
check(pure.nonEmpty('  x  ') === 'x', 'nonEmpty 去掉首尾空白');
check(pure.nonEmpty('   ') === undefined, '全空白等同于没写');
check(pure.nonEmpty(123) === undefined, '非字符串返回 undefined');
check(pure.nonEmptyStrings(['a', '', '  ', 7, 'b']).join(',') === 'a,b', '数组过滤掉空串与非字符串');

// ── 3. 别名：IDE > 项目 > 兜底 ──────────────────────────────────────
console.log('\nlabelEnumAliases');
const FALLBACK = ['fL', 'FeatureList'];
check(
  pure.labelEnumAliases({}, undefined, FALLBACK).join(',') === 'fL,FeatureList',
  '都没声明时用内置兜底',
);
check(
  pure.labelEnumAliases({ labelEnum: { aliases: ['FL'] } }, undefined, FALLBACK).join(',') === 'FL',
  '项目声明生效',
);
check(
  pure.labelEnumAliases({ labelEnum: { aliases: ['FL'] } }, ['mine'], FALLBACK).join(',') === 'mine',
  '**个人偏好压过项目声明** —— 用户定的优先级',
);
check(
  pure.labelEnumAliases({ labelEnum: { aliases: ['FL'] } }, [], FALLBACK).join(',') === 'FL',
  '个人偏好为空数组时退回项目声明（空数组 = 没设置，不是"清空"）',
);
check(
  pure.labelEnumAliases({ labelEnum: { aliases: ['  ', 5] } }, undefined, FALLBACK).join(',') === 'fL,FeatureList',
  '项目声明的全是无效项时退回兜底',
);

// ── 4. 类名：项目声明 > 文件名 ──────────────────────────────────────
console.log('\nlabelEnumName');
check(
  pure.labelEnumName({}, '/p/src/data/feature_labels.py', path.basename) === 'feature_labels',
  '没声明时退回文件名（去 .py）—— 即旧行为',
);
check(
  pure.labelEnumName({ labelEnum: { name: 'FeatureList' } }, '/p/src/data/feature_labels.py', path.basename) === 'FeatureList',
  '**声明后文件与类名解耦** —— 文件叫 feature_labels.py、类叫 FeatureList',
);
check(
  pure.labelEnumName({ labelEnum: { name: '   ' } }, '/p/src/data/FeatureList.py', path.basename) === 'FeatureList',
  '声明为空串等同于没声明',
);

// ── 5. 枚举文件路径：上次保存 > 项目声明 > 无（且模块路径必须补 .py）────
//
// 个人偏好最高（用户明确纠正过）——项目文件是团队开箱默认，我手动指定过就以我的为准。
console.log('\nlabelEnumFile');
check(pure.labelEnumFile({}, undefined) === undefined, '都没有时返回 undefined（交给调用方用内置默认）');
check(
  pure.labelEnumFile({}, '上次/存的.py') === '上次/存的.py',
  '只有上次保存时用它（它已是文件路径，原样返回、不重复补后缀）',
);
check(
  pure.labelEnumFile({ labelEnum: { path: 'src/data/FeatureList' } }, undefined) === 'src/data/FeatureList.py',
  '**项目声明是模块路径，必须补 .py** —— 否则会生成一个没有扩展名的文件，Python import 不到',
);
check(
  pure.labelEnumFile({ labelEnum: { path: 'src/data/FeatureList.py' } }, undefined) === 'src/data/FeatureList.py',
  '声明里已经带了 .py 就不重复补（对写法宽容）',
);
check(
  pure.labelEnumFile({ labelEnum: { path: 'src/data/FeatureList' } }, '上次/存的.py') === '上次/存的.py',
  '**个人偏好压过项目声明** —— 与全局取值链一致（个人偏好最高）',
);
check(
  pure.labelEnumFile({ labelEnum: { path: '' } }, '上次/存的.py') === '上次/存的.py',
  '项目声明为空串时仍用上次保存',
);

// ── 6. 破坏性对照 ────────────────────────────────────────────────────
//
// 纯函数的"改回旧写法"不好做，于是**就地改造编译产物**再求值。
// 两组对照，分别钉住这一块的两条不变量：优先级顺序、模块路径必须补 .py。
// 若对照跑出来的结果与期望相同，说明对应的那组断言其实没在约束任何东西。
console.log('\n破坏性对照');
{
  const fs = require('fs');
  const outDir = path.join(path.resolve(__dirname, '..'), 'out');
  const source = fs.readFileSync(path.join(outDir, 'projectConfigPure.js'), 'utf-8');

  function evalSandbox(code) {
    const sandbox = { exports: {} };
    new Function('module', 'exports', 'require', code)(sandbox, sandbox.exports, require);
    return sandbox.exports;
  }

  // 对照一：优先级反转（项目声明优先）
  const swapped = source.replace(
    /const saved = nonEmpty\(lastSaved\);\s*if \(saved\)\s*return saved;/,
    'const saved = undefined;',
  );
  check(swapped !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
  const reversed = evalSandbox(swapped).labelEnumFile(
    { labelEnum: { path: 'src/data/FeatureList' } },
    '上次/存的.py',
  );
  check(
    reversed === 'src/data/FeatureList.py',
    '对照一：拿掉个人偏好后，项目声明生效 —— 与第 5 组的期望相反，证明该组确实在约束优先级',
  );

  // 对照二：不补 .py（= 修复前的行为）
  const noExt = source.replace(
    /return declared\.toLowerCase\(\)\.endsWith\('\.py'\) \? declared : `\$\{declared\}\.py`;/,
    'return declared;',
  );
  check(noExt !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
  const bare = evalSandbox(noExt).labelEnumFile({ labelEnum: { path: 'src/data/FeatureList' } }, undefined);
  check(
    bare === 'src/data/FeatureList',
    '对照二：不补 .py 时拿到的正是"没有扩展名的文件"—— 即修复前会把项目弄坏的那个值',
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
