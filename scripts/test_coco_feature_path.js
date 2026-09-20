#!/usr/bin/env node
/**
 * 运行时模板库路径解析的测试（`src/cocoFeaturePathPure.ts`）。
 *
 * 背景：ok 框架加载的是 `config.py` 的 `template_matching.coco_feature_json` 指向的那份
 * COCO，而插件此前**硬编码探测** `assets/coco_annotations.json` /
 * `ok_tasks/assets/coco_annotations.json`。实测 6 个 ok 系项目全都声明了它，
 * 其中 **ok-infinity-nikki 声明的是 `assets/coco_detection.json`** ——
 * 旧代码在它那儿一个候选都探不到，模板库直接是空的。
 *
 * 这里钉住两条容易改坏的不变量：
 * 1. **优先级**：项目约定 > config.py > 探测候选（反了就是"项目说了不算"）；
 * 2. **首选可用时只用首选** —— 否则库搬到别处之后，旧位置的库会和新库一起被加载，
 *    同一个 feature 名出现两份（先到的那份胜出，静默）。
 *
 * 本模块刻意不 import `vscode`，所以这里**不需要任何桩**，直接 require 编译产物。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pure = require(path.join(root, 'out', 'cocoFeaturePathPure'));

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

const ROOT = path.join('X:', 'proj');
const A = path.join(ROOT, 'assets', 'coco_annotations.json');
const B = path.join(ROOT, 'ok_tasks', 'assets', 'coco_annotations.json');

// ── 1. 三层的来源 ───────────────────────────────────────────────────
console.log('取值链');
{
  const bare = pure.resolveCocoFeaturePlan(ROOT);
  check(bare.layer === 'probe', '都没有声明时来源是「探测候选」（= 改动前的行为）');
  check(bare.preferred === undefined, '没有首选');
  check(
    JSON.stringify(bare.probeCandidates) === JSON.stringify([A, B]),
    '探测候选就是那两个惯例位置，顺序不变',
  );

  const declared = pure.resolveCocoFeaturePlan(ROOT, 'custom/coco.json');
  check(declared.layer === 'convention', '项目约定声明生效，来源标注为 convention');
  check(declared.preferred === path.join(ROOT, 'custom', 'coco.json'), '**声明值按相对项目根绝对化**');
  check(
    JSON.stringify(declared.probeCandidates) === JSON.stringify([A, B]),
    '声明后探测候选仍然保留（首选不存在时要退回它）',
  );

  const fromPy = pure.resolveCocoFeaturePlan(ROOT, undefined, 'assets/coco_detection.json');
  check(fromPy.layer === 'configPy', '只有 config.py 声明时来源是 configPy');
  check(
    fromPy.preferred === path.join(ROOT, 'assets', 'coco_detection.json'),
    '**config.py 的值也按相对项目根绝对化** —— ok-infinity-nikki 就是这一种',
  );

  const both = pure.resolveCocoFeaturePlan(ROOT, 'custom/coco.json', 'assets/coco_detection.json');
  check(
    both.layer === 'convention' && both.preferred === path.join(ROOT, 'custom', 'coco.json'),
    '**项目约定压过 config.py** —— 与全局取值链一致（项目文件在上、config.py 事实在下）',
  );
}

// ── 2. 边界写法 ─────────────────────────────────────────────────────
console.log('\n边界写法');
{
  check(
    pure.resolveCocoFeaturePlan(ROOT, '   ').layer === 'probe',
    '全空白的声明等同于没写（不能变成项目根本身）',
  );
  check(
    pure.resolveCocoFeaturePlan(ROOT, '', '   ').layer === 'probe',
    '两侧都是空白时退回探测',
  );
  // 绝对路径原样保留。
  // **不要写 `D:/…` 或 `/srv/…` 这类平台专属字面量** —— 它们在另一个平台上根本不是绝对路径
  // （Node `path.isAbsolute('D:/x')` 在 Linux 上是 false），而 CI 跑在 Linux、本地在 Windows，
  // 写死了只有一边会过（本次就这么踩了一次）。用 `os.homedir()` 构造平台原生的绝对路径。
  const nativeAbs = path.join(os.homedir(), 'ok-coco-outside', 'coco.json');
  check(path.isAbsolute(nativeAbs), '前置条件：homedir 拼出来的必须是绝对路径');
  check(
    pure.resolveCocoFeaturePlan(ROOT, undefined, nativeAbs).preferred === nativeAbs,
    '**config.py 给的绝对路径原样返回** —— 不做任何改写（改了就与项目声明的不是同一个文件）',
  );
  if (process.platform === 'win32') {
    check(
      pure.resolveCocoFeaturePlan(ROOT, undefined, 'D:/elsewhere/coco.json').preferred === 'D:/elsewhere/coco.json',
      'Windows：`D:/…` 正斜杠写法同样算绝对路径，原样保留',
    );
  } else {
    check(
      pure.resolveCocoFeaturePlan(ROOT, undefined, '/srv/coco.json').preferred === '/srv/coco.json',
      'POSIX：绝对路径的开头斜杠必须保住',
    );
  }
  check(
    pure.resolveCocoFeaturePlan(ROOT, 'custom/coco.json').preferred === path.join(ROOT, 'custom', 'coco.json'),
    '项目约定那一侧传进来时**已经归一化过**（`templatesCocoAnnotationsSetting` 负责），这里只管绝对化',
  );
  check(
    pure.resolveCocoFeaturePlan('', 'custom/coco.json').preferred === path.join('', 'custom', 'coco.json'),
    '项目根为空时不炸（只是拼出来的路径没意义）',
  );
}

// ── 3. 实际要扫描哪些文件 ───────────────────────────────────────────
console.log('\neffectiveCocoFiles');
{
  const declared = pure.resolveCocoFeaturePlan(ROOT, 'custom/coco.json');
  const onlyPreferred = pure.effectiveCocoFiles(declared, (f) => f === declared.preferred || f === A);
  check(
    JSON.stringify(onlyPreferred) === JSON.stringify([declared.preferred]),
    '**首选可用时只用首选** —— 不能把惯例位置的旧库也带上，否则同名 feature 出现两份',
  );

  const preferredMissing = pure.effectiveCocoFiles(declared, (f) => f === A);
  check(
    JSON.stringify(preferredMissing) === JSON.stringify([A]),
    '首选不存在时退回**存在**的探测候选（config.py 里声明的文件可能还没生成）',
  );

  const bare = pure.resolveCocoFeaturePlan(ROOT);
  check(
    JSON.stringify(pure.effectiveCocoFiles(bare, () => true)) === JSON.stringify([A, B]),
    '没声明时两个惯例位置都存在就都加载（与改动前完全一致）',
  );
  check(
    JSON.stringify(pure.effectiveCocoFiles(bare, (f) => f === B)) === JSON.stringify([B]),
    '没声明时只存在第二个候选，就只加载它',
  );
  check(
    pure.effectiveCocoFiles(bare, () => false).length === 0,
    '一个都不存在时返回空列表（不抛异常、也不编造路径）',
  );
}

// ── 3.5 监听 / 变更归属用的相对路径 ─────────────────────────────────
//
// 这份列表同时喂给**文件监听 glob** 与**变更归属判定**，所以它有一条硬不变量：
// **每一条都必须是「项目内相对路径」** —— 绝对路径或 `../…` 混进去，
// 监听会盯到项目外、变更比较也永远匹配不上（表现为"改那个文件不触发刷新"，静默）。
console.log('\ncocoFeatureRelPaths');
{
  const relsOf = (declared, fromConfigPy) =>
    pure.cocoFeatureRelPaths(pure.resolveCocoFeaturePlan(ROOT, declared, fromConfigPy), ROOT);

  check(
    JSON.stringify(relsOf()) === JSON.stringify(['assets/coco_annotations.json', 'ok_tasks/assets/coco_annotations.json']),
    '没声明时就是两个惯例位置',
  );
  check(
    JSON.stringify(relsOf('custom/coco.json')) ===
      JSON.stringify(['custom/coco.json', 'assets/coco_annotations.json', 'ok_tasks/assets/coco_annotations.json']),
    '**首选与探测候选都要覆盖** —— 监听不能按存在性过滤，否则第一次生成库时不会触发刷新',
  );
  check(
    JSON.stringify(relsOf('assets/coco_annotations.json')) ===
      JSON.stringify(['assets/coco_annotations.json', 'ok_tasks/assets/coco_annotations.json']),
    '首选恰好等于某个惯例位置时**去重**（同一路径不该出现两次）',
  );

  // 同盘符/同根的项目外路径 → `path.relative` 给出 `../…` → 剔除
  const outsideSameRoot = relsOf(undefined, path.join(ROOT, '..', 'other', 'coco.json'));
  check(
    !outsideSameRoot.some((r) => r.includes('other')),
    '**项目外的首选被剔除**（`../…` 不能当监听目标），但两个惯例候选仍在',
  );

  // 属性断言：不管哪种输入，返回的每一条都必须是项目内相对路径。
  // 这条在两种平台上都成立，且正好覆盖"跨盘符"那个平台专属分支的**结果**。
  const cases = [
    { plan: pure.resolveCocoFeaturePlan(ROOT), root: ROOT },
    { plan: pure.resolveCocoFeaturePlan(ROOT, 'custom/coco.json'), root: ROOT },
    { plan: pure.resolveCocoFeaturePlan(ROOT, undefined, path.join(ROOT, '..', 'other', 'coco.json')), root: ROOT },
  ];
  if (process.platform === 'win32') {
    // Windows 专属：**跨盘符**时 `path.relative` 返回的是**绝对路径**而不是 `../…`
    cases.push({ plan: pure.resolveCocoFeaturePlan('C:/proj', undefined, 'D:/other/coco.json'), root: 'C:/proj' });
  }
  const offenders = [];
  for (const { plan, root: caseRoot } of cases) {
    for (const r of pure.cocoFeatureRelPaths(plan, caseRoot)) {
      if (path.isAbsolute(r) || r.startsWith('..')) offenders.push(r);
    }
  }
  check(
    offenders.length === 0,
    offenders.length === 0
      ? '**返回的每一条都是项目内相对路径**（不含绝对路径、不以 `..` 开头）'
      : `**有项目外的路径漏了出来**：${offenders.join(', ')} —— 监听会盯到项目外、变更比较永远匹配不上`,
  );

  if (process.platform === 'win32') {
    const crossDrive = pure.cocoFeatureRelPaths(
      pure.resolveCocoFeaturePlan('C:/proj', undefined, 'D:/other/coco.json'),
      'C:/proj',
    );
    check(
      !crossDrive.some((r) => path.isAbsolute(r)),
      '**Windows 跨盘符的首选也要被剔除** —— `path.relative` 这时返回的是绝对路径（`D:/other/coco.json`），' +
        '光判 `startsWith("..")` 拦不住，必须再判 `path.isAbsolute`',
    );
  }
}

// ── 4. 破坏性对照 ───────────────────────────────────────────────────
console.log('\n破坏性对照');
{
  const source = fs.readFileSync(path.join(root, 'out', 'cocoFeaturePathPure.js'), 'utf-8');
  // 沙箱里的 `require` 必须能解析 `./projectConfigPure`，所以从 `out/` 建一个
  const outRequire = require('module').createRequire(path.join(root, 'out', 'cocoFeaturePathPure.js'));

  function evalSandbox(code) {
    const sandbox = { exports: {} };
    new Function('module', 'exports', 'require', code)(sandbox, sandbox.exports, outRequire);
    return sandbox.exports;
  }

  // 对照一：首选可用时把探测候选也带上（= 库搬家后两份一起加载）
  const alsoProbe = source.replace(
    'if (plan.preferred && exists(plan.preferred))\n        return [plan.preferred];',
    'if (plan.preferred && exists(plan.preferred))\n        return [plan.preferred, ...plan.probeCandidates.filter(exists)];',
  );
  check(alsoProbe !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
  const alsoProbeFiles = evalSandbox(alsoProbe).effectiveCocoFiles(
    pure.resolveCocoFeaturePlan(ROOT, 'custom/coco.json'),
    (f) => f === path.join(ROOT, 'custom', 'coco.json') || f === A,
  );
  check(
    alsoProbeFiles.length === 2,
    '对照一：把探测候选也带上后变成两份 —— 与第 3 组的"只用首选"相反（同名 feature 会静默取先到的那份）',
  );

  // 对照二：config.py 压过项目约定（= 优先级反转）
  const pyFirst = source.replace(
    "if (declaredPath) {\n        return { preferred: toAbsolute(rootDir, declaredPath), probeCandidates, layer: 'convention' };\n    }",
    "if (false) {\n        return { preferred: toAbsolute(rootDir, declaredPath), probeCandidates, layer: 'convention' };\n    }",
  );
  check(pyFirst !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
  const pyFirstPlan = evalSandbox(pyFirst).resolveCocoFeaturePlan(
    ROOT,
    'custom/coco.json',
    'assets/coco_detection.json',
  );
  check(
    pyFirstPlan.layer === 'configPy',
    '对照二：拿掉项目约定分支后 config.py 生效 —— 与第 1 组的期望相反，证明该组确实在约束优先级',
  );

  // 对照三：声明值不绝对化（= 相对路径被当成绝对路径用）
  const noJoin = source.replace(
    'return path.isAbsolute(value) ? value : path.join(rootDir, value);',
    'return value;',
  );
  check(noJoin !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
  const noJoinPlan = evalSandbox(noJoin).resolveCocoFeaturePlan(ROOT, 'custom/coco.json');
  check(
    noJoinPlan.preferred === 'custom/coco.json',
    '对照三：不绝对化时拿到的是相对路径 —— `fs.existsSync` 会按**进程 cwd** 去找，指到别处',
  );
  // 对照四：去掉 `!path.isAbsolute(rel)` 这道守卫
  const noAbsGuard = source.replace('&& !path.isAbsolute(rel)', '');
  check(noAbsGuard !== source, '对照四源码确实被改动了（替换命中）—— 否则对照是假的');
  if (process.platform === 'win32') {
    const leaked = evalSandbox(noAbsGuard).cocoFeatureRelPaths(
      pure.resolveCocoFeaturePlan('C:/proj', undefined, 'D:/other/coco.json'),
      'C:/proj',
    );
    check(
      leaked.some((r) => path.isAbsolute(r)),
      '对照四：拿掉 isAbsolute 守卫后，**跨盘符的绝对路径会漏进监听列表** —— 与第 3.5 组的期望相反',
    );
  } else {
    // ⚠️ POSIX 上 `path.relative` 永远给相对路径（"跨盘"不存在），这道守卫**不可观测**，
    // 所以没法用行为对照 —— 退而断言"它还在源码里"，防止被当成冗余代码删掉（Windows 上会漏）。
    check(
      source.includes('!path.isAbsolute(rel)'),
      'POSIX 上该守卫不可观测，改为断言它**仍在源码里** —— 删掉它 Windows 上会静默漏路径',
    );
  }
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
