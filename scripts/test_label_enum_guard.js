#!/usr/bin/env node
/**
 * 枚举类名变更校验的测试（`src/labelEnumGuard.ts`）。
 *
 * 背景：`labelEnum.name` 现在有"个人偏好"层（IDE 设置 `labelEnumName`），而这一项
 * **决定写进源码的类名**，项目的代码是按名字 import 的：
 *
 * ```python
 * from src.data.feature_list import FeatureList      # 项目里有 10 处这么写
 * ```
 *
 * 个人覆盖改错 → 整个项目 `ImportError`，而界面上唯一的反馈是"保存成功"。
 * 这个模块算的就是"这次覆盖会废掉多少处 import"，好在写入前问一句。
 *
 * 判据全是字符串处理，所以能脱离 IDE 直接断言（本仓库的既有约定）。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const guard = require(path.join(root, 'out', 'labelEnumGuard'));

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

/** 与 `localization.tr` 同形状的最小替身：只做 `{name}` 替换，不做查表。 */
function t(message, args) {
  if (!args) return message;
  return String(message).replace(/\{(\w+)\}/g, (all, name) => (name in args ? String(args[name]) : all));
}

/** 我们真正会写出来的那种文件。 */
function enumSource(className) {
  return `from enum import Enum\n\n\nclass ${className}(str, Enum):\n    a = 'a'\n`;
}

// ── 1. 从源码里认类名 ────────────────────────────────────────────────
console.log('extractClassName');
check(guard.extractClassName(enumSource('FeatureList')) === 'FeatureList', '认得出我们生成的枚举文件');
check(guard.extractClassName('class X:') === 'X', '没有基类也能认（`class X:`）');
check(guard.extractClassName('class _Private(Base):') === '_Private', '下划线开头的类名');
check(guard.extractClassName('    class Indented(Base):') === 'Indented', '允许缩进（模块级之外也可能有 class）');
check(guard.extractClassName('from enum import Enum\nx = 1\n') === undefined, '没有 class 时返回 undefined');
check(guard.extractClassName('') === undefined, '空文件返回 undefined');
check(
  guard.extractClassName('# class Commented:\n') === undefined,
  '**注释里的 class 不算** —— 行首必须是 class 本身，否则会把说明文字当成类名',
);
check(
  guard.extractClassName('class 2Fast(Base):') === undefined,
  '非法标识符（数字开头）不算 —— 认出来也没用，那种文件本来就不是我们生成的',
);

// ── 2. 谁 import 了这个名字 ──────────────────────────────────────────
console.log('\nimportsName');
check(
  guard.importsName('from src.data.feature_list import FeatureList\n', 'FeatureList'),
  '最常见的写法',
);
check(
  guard.importsName('from src.data.feature_list import FeatureList as fL\n', 'FeatureList'),
  '带 as 别名也算 —— 别名绑定的是同一个类，改名同样会断',
);
check(
  guard.importsName('from src.data.feature_list import (A, FeatureList)\n', 'FeatureList'),
  '括号列表里的一项',
);
check(guard.importsName('import src.data.feature_list.FeatureList\n', 'FeatureList'), '`import a.b.X` 写法');
check(
  guard.importsName('from src.data.feature_list import FeatureList2\n', 'FeatureList') === false,
  '**词边界必须成立** —— `FeatureList2` 不是 `FeatureList`，否则会到处误报',
);
check(
  guard.importsName('x = FeatureList.foo\n', 'FeatureList') === false,
  '只用到名字、没 import 的（`import ... as m` 那种）查不到 —— 这是已知的漏报，宁可漏不可乱报',
);
check(
  guard.importsName('from src.data.feature_list import FeatureList\n', '') === false,
  '空名字一律不匹配（读不出旧类名时不该把所有文件都算成引用方）',
);
check(
  guard.importsName('# from x import FeatureList\n', 'FeatureList'),
  '**注释掉的 import 也算命中** —— 有意的：这是"问一句"的依据，多报一次比漏报一次便宜',
);
check(
  guard.importsName('from x import List+Thing\n', 'List+Thing'),
  '名字里有正则特殊字符也不会抛异常（内部做了转义）',
);

// ── 3. 要不要问 ──────────────────────────────────────────────────────
console.log('\nwritableClassName');
check(guard.writableClassName('FeatureList') === 'FeatureList', '合法标识符原样通过');
check(guard.writableClassName('_X1') === '_X1', '下划线开头 + 数字也合法');
check(guard.writableClassName('2Bad') === 'LabelEnum', '数字开头 → 退回兜底名（否则生成的文件是 SyntaxError）');
check(guard.writableClassName('洗手台') === 'LabelEnum', '非 ASCII → 退回兜底名');
check(guard.writableClassName('') === 'LabelEnum', '空串 → 退回兜底名');
check(
  guard.writableClassName('a b') === 'LabelEnum',
  '含空格 → 退回兜底名',
);
check(
  guard.FALLBACK_ENUM_CLASS_NAME === 'LabelEnum',
  '兜底名与子仓同值 —— 两端生成同一个文件，名字不一致就是新的不对等',
);

console.log('\nlabelEnumRenameImpact');
check(
  guard.labelEnumRenameImpact({ existingSource: undefined, newClassName: 'X' }) === undefined,
  '**文件不存在 → 不问** —— 全新生成，没有旧名字可废',
);
check(
  guard.labelEnumRenameImpact({ existingSource: enumSource('FeatureList'), newClassName: 'FeatureList' }) === undefined,
  '**同名 → 不问** —— 每次保存都会重新生成一遍，问了就是纯噪音',
);
const impact = guard.labelEnumRenameImpact({ existingSource: enumSource('FeatureList'), newClassName: 'MyEnum' });
check(!!impact && impact.existingClassName === 'FeatureList' && impact.newClassName === 'MyEnum', '改名 → 报出旧名与新名');
const unknown = guard.labelEnumRenameImpact({ existingSource: 'x = 1\n', newClassName: 'FeatureList' });
check(
  !!unknown && unknown.existingClassName === '',
  '**文件在、却认不出类名 → 也要问** —— 用户很可能把路径填到了一个普通模块上，覆盖会删掉里面的东西',
);

// ── 4. 挑出引用方 ────────────────────────────────────────────────────
console.log('\nreferencingFiles');
const files = [
  { path: 'src/tasks/farm.py', source: 'from src.data.feature_list import FeatureList\n' },
  { path: 'src/main.py', source: 'from src.data.feature_list import FeatureList as fL\n' },
  { path: 'src/other.py', source: 'import os\n' },
  // 枚举文件自己**不算**引用方：它只有 `from enum import Enum`，不会 import 自己的类。
  // 这条恰好说明判据是"按名字 import"，不是"提到过这个名字"。
  { path: 'src/data/feature_list.py', source: enumSource('FeatureList') },
];
const hits = guard.referencingFiles(files, 'FeatureList');
check(hits.length === 2, `命中了 2 个，实际 ${hits.length}`);
check(
  JSON.stringify(hits) === JSON.stringify(['src/main.py', 'src/tasks/farm.py']),
  '**按路径排序** —— 提示文案里的顺序必须稳定，否则同一件事每次说的都不一样',
);
check(
  !hits.includes('src/data/feature_list.py'),
  '枚举文件自身不算引用方（它不 import 自己）—— 否则文案里会出现"这个文件会被自己弄坏"',
);
check(guard.referencingFiles(files, '').length === 0, '旧类名读不出来时不报任何引用方（没有可查的名字）');
check(
  guard.referencingFiles(files, 'Nonexistent').length === 0,
  '没人 import 的名字返回空数组 —— 文案会退化成"只改类名、不提引用"',
);

// ── 5. 提示文案 ──────────────────────────────────────────────────────
console.log('\nlabelEnumRenameMessage');
const msg = guard.labelEnumRenameMessage(impact, ['src/a.py', 'src/b.py'], t);
check(msg.includes('FeatureList') && msg.includes('MyEnum'), '文案里同时出现旧名与新名（用户得知道改成什么）');
check(msg.includes('src/a.py'), '列出受影响的文件');
check(
  !guard.labelEnumRenameMessage(impact, [], t).includes('import'),
  '没人 import 时不提"会失效" —— 否则是一句永远不成立的恐吓',
);
const many = Array.from({ length: 40 }, (_, i) => `src/f${i}.py`);
const truncated = guard.labelEnumRenameMessage(impact, many, t);
check(truncated.includes('40'), '**总数照实报** —— 用户要的是"会炸多少处"，不是"前 5 个是谁"');
check(truncated.includes('src/f0.py') && !truncated.includes('src/f39.py'), '列表只列前几个，避免撑爆模态框');
const unknownMsg = guard.labelEnumRenameMessage(unknown, [], t);
check(
  unknownMsg.includes('could not be recognized') && !unknownMsg.includes('rename'),
  '认不出类名时换一套说法（"内容会被覆盖"），不能说成"改名"',
);

// ── 6. 破坏性对照 ────────────────────────────────────────────────────
//
// 就地改造编译产物再求值。若对照跑出来的结果与期望相同，说明对应断言没在约束任何东西。
console.log('\n破坏性对照');
{
  const source = fs.readFileSync(path.join(root, 'out', 'labelEnumGuard.js'), 'utf-8');
  function evalSandbox(code) {
    const sandbox = { exports: {} };
    new Function('module', 'exports', 'require', code)(sandbox, sandbox.exports, require);
    return sandbox.exports;
  }

  // 对照一：拿掉"同名不问"的短路（= 每次保存都弹一次）
  //
  // 只替换**条件那一行**，不连正文一起匹配 —— 编译产物的缩进是 tsc 定的，
  // 把缩进写死在测试里，下次升级 TS 就会静默失配（"替换没命中"那条断言就是为此设的）。
  const nag = source.replace(
    'if (existingClassName === args.newClassName)',
    'if (false)',
  );
  check(nag !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    !!evalSandbox(nag).labelEnumRenameImpact({ existingSource: enumSource('FeatureList'), newClassName: 'FeatureList' }),
    '对照一：拿掉短路后，**每次常规保存都会弹确认框** —— 与第 3 组的期望相反',
  );

  // 对照二：`labelEnumRenameImpact` 恒返回 undefined（= 静默改名）
  const silent = source.replace(
    'return { existingClassName, newClassName: args.newClassName };',
    'return undefined;',
  );
  check(silent !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(silent).labelEnumRenameImpact({ existingSource: enumSource('FeatureList'), newClassName: 'MyEnum' }) ===
      undefined,
    '对照二：恒不问之后，改名会**静默**把项目 import 弄坏 —— 这正是这个模块存在的理由',
  );

  // 对照三：`importsName` 去掉词边界（= 到处误报）
  const loose = source.replace(
    'new RegExp(`(^|[^\\\\w.])import[ \\\\t][^\\\\n]*\\\\b${escaped}\\\\b`)',
    'new RegExp(`(^|[^\\\\w.])import[ \\\\t][^\\\\n]*${escaped}`)',
  );
  check(loose !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(loose).importsName('from x import FeatureList2\n', 'FeatureList'),
    '对照三：去掉词边界后 `FeatureList2` 被误报成引用方 —— 与第 2 组的期望相反',
  );

  // 对照四：`referencingFiles` 不再过滤（= 每个文件都算引用方）
  const noFilter = source.replace(
    '.filter((f) => importsName(f.source, name))',
    '.filter(() => true)',
  );
  check(noFilter !== source, '对照四源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(noFilter).referencingFiles(files, 'Nonexistent').length === files.length,
    '对照四：不过滤时"没人引用"也会报满 —— 用户会看到一句纯属虚构的警告',
  );

  // 对照五：类名不做合法性兜底（= 校验拿原始值去比，警告内容与实际写入不符）
  //
  // 用正则匹配三元表达式的尾部而不是整行：tsc 会把模块内的常量写成
  // `exports.FALLBACK_ENUM_CLASS_NAME`，把这一串硬编码进测试会在升级 TS 时静默失配。
  const rawName = source.replace(/\?\s*raw\s*:\s*[^;]*FALLBACK_ENUM_CLASS_NAME;/, '? raw : raw;');
  check(rawName !== source, '对照五源码确实被改动了（替换命中）—— 否则对照是假的');
  const rawExports = evalSandbox(rawName);
  check(
    rawExports.writableClassName('2Bad') === '2Bad',
    '对照五：不做兜底时"将要写入的类名"是个非法标识符 —— 面板会为一次**实际什么都没变**的保存报警',
  );
  check(
    !!rawExports.labelEnumRenameImpact({
      existingSource: enumSource('LabelEnum'),
      newClassName: rawExports.writableClassName('2Bad'),
    }),
    '对照五：于是出现"从 LabelEnum 改名为 2Bad"这种**不成立**的警告 —— 比没有警告更糟',
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
