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

// ── 6. 相对路径归一化 ────────────────────────────────────────────────
//
// 这个值会被三种方式消费：`path.join` 拼绝对路径、`rel.startsWith(...)` 比较、
// 以及**拼进 glob**（`extension.ts` 的文件监听）。后两种对 `\` 和首尾斜杠敏感，
// 而失配是**静默**的 —— 界面一切正常，只是改了模板文件不刷新。
console.log('\nnormalizeRelPath');
check(pure.normalizeRelPath('  ok_templates  ') === 'ok_templates', '去掉首尾空白');
check(pure.normalizeRelPath('ok_templates\\') === 'ok_templates', '**反斜杠转正斜杠并去掉尾斜杠**');
check(pure.normalizeRelPath('/ok_templates/') === 'ok_templates', '去掉首尾斜杠');
check(pure.normalizeRelPath('./ok_templates') === 'ok_templates', '**去掉开头的 `./`** —— 声明里这么写很自然，但 `startsWith`/glob 匹配会失配');
check(pure.normalizeRelPath('.//ok_templates') === 'ok_templates', '`./` 与多余斜杠的组合也一并剥掉');
check(pure.normalizeRelPath('../shared_tpl') === '../shared_tpl', '**`../` 必须保留** —— 那是有意义的上跳，剥了就指到别处去了');
check(pure.normalizeRelPath('a/b') === 'a/b', '多级目录原样保留');
check(pure.normalizeRelPath('   ') === undefined, '全空白等同于没写');
check(pure.normalizeRelPath('/') === undefined, '只有斜杠等同于没写（不能变成空目录名）');
check(pure.normalizeRelPath(42) === undefined, '非字符串等同于没写');

// ── 7. 模板目录：IDE > 项目 > 兜底 ──────────────────────────────────
//
// 这一组此前**完全没有被读**：VS Code 侧把 `ok_templates` 写成常量、
// 没有任何代码读 `okScriptToolkit.okTemplatesDirectory`（死设置），而子仓会读 ——
// 属反向不对等（docs/project-config.md §8.1）。
console.log('\ntemplatesDirectoryOf');
const TPL_FALLBACK = 'ok_templates';
check(
  pure.templatesDirectoryOf({}, undefined, TPL_FALLBACK) === 'ok_templates',
  '都没声明时用内置兜底',
);
check(
  pure.templatesDirectoryOf({ templates: { directory: 'my_tpl' } }, undefined, TPL_FALLBACK) === 'my_tpl',
  '**项目声明生效** —— 这正是修复前被完全忽略的那一项',
);
check(
  pure.templatesDirectoryOf({ templates: { directory: 'my_tpl' } }, 'mine', TPL_FALLBACK) === 'mine',
  '**个人偏好压过项目声明** —— 与全局取值链一致（个人偏好最高）',
);
check(
  pure.templatesDirectoryOf({ templates: { directory: 'my_tpl' } }, '   ', TPL_FALLBACK) === 'my_tpl',
  '个人偏好为空白时退回项目声明（空白 = 没设置，不是"清空"）',
);
check(
  pure.templatesDirectoryOf({ templates: { directory: 'ok_templates\\' } }, undefined, 'x') === 'ok_templates',
  '项目声明里的反斜杠/尾斜杠也会被归一化 —— 否则拼进 glob 会静默失配',
);
check(
  pure.templatesDirectoryOf({ templates: { directory: 42 } }, undefined, TPL_FALLBACK) === 'ok_templates',
  '目录名写成数字等同于没写（不能变成目录名 "42"）',
);
check(
  pure.templatesDirectoryOf({ templates: '不是对象' }, undefined, TPL_FALLBACK) === 'ok_templates',
  'templates 不是对象时按没写处理',
);
check(
  pure.templatesDirectoryOf({ templates: { directory: 'my_tpl' } }, undefined, TPL_FALLBACK) === 'my_tpl',
  '未受影响的字段（cocoAnnotations）不影响目录名取值',
);

// ── 8. i18n / characters / effects 三组 ──────────────────────────────
//
// 这三组此前是**硬编码常量**（`langData.ts` 写死 `assets/lang`、`effectData.ts`
// 写死 `src/data/effects.py`…），接进取值链后每个字段都多了一条"项目声明"的来源。
//
// 这里按字段**类型**分组断言，因为类型决定了走哪条归一化：
//   · 相对路径 → `relPathResolved`（斜杠归一化，会被拼进 glob / 做目录段匹配）
//   · 绝对路径 / 正则 → `textResolved`（**绝不能归一化**，见下面那条最关键的断言）
//   · 布尔 / 字符串数组 → 类型守卫 + "空 = 没声明"
console.log('\ni18n 一组');
check(pure.i18nEnabled({}, undefined, true) === true, '都没声明时用内置兜底');
check(
  pure.i18nEnabled({ i18n: { enabled: false } }, undefined, true) === false,
  '**项目声明 false 生效** —— 此前这一项根本没有项目层，只能靠个人设置关',
);
check(
  pure.i18nEnabled({ i18n: { enabled: false } }, true, false) === true,
  '**个人偏好压过项目声明** —— 与全局取值链一致（个人偏好最高）',
);
check(
  pure.i18nEnabled({ i18n: { enabled: 'false' } }, undefined, true) === true,
  '**声明写成字符串 "false" 当没写** —— 手写文件里最容易犯的错；若照真值判断，"false" 是 truthy，会把开关反向锁死在开',
);
check(
  pure.i18nEnabledResolved({ i18n: { enabled: false } }, undefined, true).layer === 'project',
  '来源层标注为「项目约定」（溯源面板用）',
);
check(
  pure.i18nLangDirectory({ i18n: { langDirectory: 'assets\\lang' } }, undefined, 'x') === 'assets/lang',
  '语言目录归一化 —— 它会被拼进文件监听的 glob，反斜杠会静默失配',
);
check(
  pure.i18nPoDirectory({ i18n: { poDirectory: '/i18n/' } }, undefined, 'x') === 'i18n',
  'po 目录去掉首尾斜杠',
);
check(
  pure.i18nPoDomains({ i18n: { poDomains: ['ocr', 'ui'] } }, undefined, ['ocr']).join(',') === 'ocr,ui',
  'po domain 列表按项目声明取值',
);
check(
  pure.i18nPoDomains({ i18n: { poDomains: [] } }, undefined, ['ocr']).join(',') === 'ocr',
  '空数组 = 没声明（不是"清空"）—— 否则用户没法用空值表达"回到项目约定"',
);
check(
  pure.i18nPoDomains({ i18n: { poDomains: [' ', 7] } }, undefined, ['ocr']).join(',') === 'ocr',
  '列表里全是无效项时退回兜底',
);

console.log('\ncharacters 一组');
check(
  pure.charactersProjectPath({ characters: { projectPath: '/home/me/other_proj' } }, undefined, '') ===
    '/home/me/other_proj',
  '**POSIX 绝对路径的开头斜杠必须保住** —— 走路径归一化会变成相对路径 home/me/other_proj，指向一个不存在的地方',
);
check(
  pure.charactersProjectPath({ characters: { projectPath: 'D:\\items\\other_proj' } }, undefined, '') ===
    'D:\\items\\other_proj',
  '**Windows 绝对路径的反斜杠必须保住** —— 归一化会把分隔符换成正斜杠（`path.resolve` 能吃，但展示与 `~` 展开逻辑会失真）',
);
check(
  pure.charactersProjectPath({ characters: { projectPath: '' } }, undefined, '') === '',
  '空串 = 与当前项目相同（合法声明，等价于没声明）',
);
check(
  pure.charactersProjectPath({ characters: { projectPath: '/a' } }, '/b', '') === '/b',
  '个人偏好压过项目声明',
);
check(
  pure.charactersAvatarTemplateRegex(
    { characters: { avatarTemplateRegex: '^icon\\d+/' } },
    undefined,
    'x',
  ) === '^icon\\d+/',
  '**正则必须原样保留** —— 归一化会把 `\\d` 的反斜杠换成 `/`、把尾部 `/` 吃掉，正则当场废掉且不报错',
);
check(
  pure.charactersMasterFile({ characters: { masterFile: 'data/chars.json' } }, undefined, 'x') === 'data/chars.json',
  '角色主数据文件按项目声明取值',
);
check(
  pure.charactersSkillsDirectory({ characters: { skillsDirectory: 'data\\skills\\' } }, undefined, 'x') === 'data/skills',
  '技能目录是相对路径，要归一化',
);
check(
  pure.charactersLocaleFile({ characters: { localeFile: '/lang/chars.json/' } }, undefined, 'x') === 'lang/chars.json',
  '角色名多语言文件同样归一化',
);
check(
  pure.charactersMasterFile({ characters: '不是对象' }, undefined, 'x') === 'x',
  'characters 不是对象时按没写处理（整组降级，不能抛异常）',
);

console.log('\neffects 一组');
check(pure.effectsFile({}, undefined, 'src/data/effects.py') === 'src/data/effects.py', '都没声明时用内置兜底');
check(
  pure.effectsFile({ effects: { file: 'src/data/effect_defs.py' } }, undefined, 'x') === 'src/data/effect_defs.py',
  '项目声明生效',
);
check(
  pure.effectsFile({ effects: { file: 'src/data/effect_defs.py' } }, 'mine.py', 'x') === 'mine.py',
  '个人偏好压过项目声明',
);
check(
  pure.effectsFile({ effects: { file: './src/data/effects.py' } }, undefined, 'x') === 'src/data/effects.py',
  '声明里写 `./` 前缀也会被归一化掉 —— 否则 `path.relative` 比较与 glob 都会失配',
);
check(
  pure.effectsFileResolved({ effects: { file: 'a.py' } }, undefined, 'x').layer === 'project',
  '来源层标注为「项目约定」',
);

// ── 9. 破坏性对照 ────────────────────────────────────────────────────
//
// 纯函数的"改回旧写法"不好做，于是**就地改造编译产物**再求值。
// 七组对照，分别钉住这一块的七条不变量：优先级顺序、模块路径必须补 .py、
// 相对路径必须归一化、模板目录的优先级顺序、取值链共享核心 `resolveSetting`
// 本身（个人偏好必须最高）、绝对路径/正则**不能**被当成相对路径归一化、
// 以及布尔字段的类型守卫。
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

  // 对照三：不归一化（= 把声明值原样当路径用）
  const normLine = String.raw`const cleaned = raw.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '');`;
  const noNorm = source.replace(normLine, 'const cleaned = raw;');
  check(noNorm !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
  const rawDir = evalSandbox(noNorm).templatesDirectoryOf(
    { templates: { directory: 'ok_templates\\' } },
    undefined,
    'x',
  );
  check(
    rawDir === 'ok_templates\\',
    '对照三：不归一化时尾反斜杠会原样漏出去 —— 拼进 glob 就是静默失配（监听不触发）',
  );

  // 对照四：相对路径字段的优先级反转（项目声明优先）
  //
  // 杠杆点在 `relPathResolved` —— 所有**相对路径类**字段（模板目录、语言目录、
  // po 目录、角色数据文件…）都从这一个函数取值，所以它一反转，整族字段都跟着反转。
  const projFirst = source.replace(
    'return resolveSetting(normalizeRelPath(ideValue), normalizeRelPath(declared), fallback);',
    'return resolveSetting(normalizeRelPath(declared), normalizeRelPath(ideValue), fallback);',
  );
  check(projFirst !== source, '对照四源码确实被改动了（替换命中）—— 否则对照是假的');
  const projFirstExports = evalSandbox(projFirst);
  const projWins = projFirstExports.templatesDirectoryOf(
    { templates: { directory: 'my_tpl' } },
    'mine',
    'x',
  );
  check(
    projWins === 'my_tpl',
    '对照四：拿掉个人偏好优先后，项目声明生效 —— 与第 7 组的期望相反，证明该组确实在约束优先级',
  );
  check(
    projFirstExports.effectsFile({ effects: { file: 'proj.py' } }, 'mine.py', 'x') === 'proj.py',
    '对照四：同一个杠杆也反转了后来接入的 effects 组 —— 证明新分组复用的确实是这条共享链，不是自己另写的一套',
  );

  // 对照五：`resolveSetting` 本身（取值链的**共享核心**，三层都走它）
  //
  // 这个对照比对照四的杠杆更大：它一坏，所有走取值链的设置项都跟着错，
  // 而且错法正好是"个人偏好被无视"。所以单独钉一条。
  const noIde = source.replace(
    'if (ideValue !== undefined)\n        return { value: ideValue, layer: \'personal\' };',
    'if (false)\n        return { value: ideValue, layer: \'personal\' };',
  );
  check(noIde !== source, '对照五源码确实被改动了（替换命中）—— 否则对照是假的');
  const noIdeExports = evalSandbox(noIde);
  check(
    noIdeExports.labelEnumAliases({ labelEnum: { aliases: ['FL'] } }, ['mine'], ['fL']).join(',') === 'FL',
    '对照五：拿掉「个人偏好」分支后，别名也变成项目声明生效 —— 与第 3 组的期望相反',
  );
  check(
    noIdeExports.labelEnumAliasesResolved({ labelEnum: { aliases: ['FL'] } }, ['mine'], ['fL']).layer === 'project',
    '对照五：同时证明"来源层"确实由这条链产出（拿掉分支后层也跟着变），不是另算的一套',
  );

  // 对照六：绝对路径/正则也走相对路径归一化（= 第 8 组最危险的那个写法）
  //
  // 这两条合起来才是完整的：`characters.projectPath` 是绝对路径、
  // `avatarTemplateRegex` 是正则，一旦被当成相对路径处理，值是**静默**变坏的
  // —— 面板照常显示、脚本照常跑，只是指向/匹配的东西变了。
  const absNorm = source.replace(
    'return textResolved(ideValue, charactersOf(config).projectPath, fallback);',
    'return relPathResolved(ideValue, charactersOf(config).projectPath, fallback);',
  );
  check(absNorm !== source, '对照六源码确实被改动了（替换命中）—— 否则对照是假的');
  const absExports = evalSandbox(absNorm);
  check(
    absExports.charactersProjectPath({ characters: { projectPath: '/home/me/other_proj' } }, undefined, '') ===
      'home/me/other_proj',
    '对照六：绝对路径被归一化后开头斜杠被吃掉，变成一个相对路径 —— 与第 8 组的期望相反',
  );

  const regexNorm = source.replace(
    'return textResolved(ideValue, charactersOf(config).avatarTemplateRegex, fallback);',
    'return relPathResolved(ideValue, charactersOf(config).avatarTemplateRegex, fallback);',
  );
  check(regexNorm !== source, '对照六（正则）源码确实被改动了（替换命中）—— 否则对照是假的');
  check(
    evalSandbox(regexNorm).charactersAvatarTemplateRegex(
      { characters: { avatarTemplateRegex: '^icon\\d+/' } },
      undefined,
      'x',
    ) === '^icon/d+',
    '对照六：正则被归一化后 `\\d` 变成 `/d`、尾部 `/` 被吃掉 —— 正则静默失效，头像永远匹配不上',
  );

  // 对照七：布尔字段不做类型守卫（= 手写文件里的 "false" 当真值）
  const looseBool = source.replace(
    "const dec = typeof declared === 'boolean' ? declared : undefined;",
    'const dec = declared;',
  );
  check(looseBool !== source, '对照七源码确实被改动了（替换命中）—— 否则对照是假的');
  const looseExports = evalSandbox(looseBool);
  check(
    looseExports.i18nEnabled({ i18n: { enabled: 'false' } }, undefined, true) !== true,
    '对照七：不做类型守卫时，"false" 这个**真值**直接穿过取值链 —— 项目声明关掉 i18n 反而被锁在开',
  );
  check(
    evalSandbox(looseBool).i18nEnabledResolved({ i18n: { enabled: 'false' } }, undefined, true).layer === 'project',
    '对照七：同时说明层也被污染成「项目约定」—— 面板会显示"来源是项目约定、值是 false"，而实际生效的是 true',
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
