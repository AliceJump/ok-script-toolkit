#!/usr/bin/env node
/**
 * 标注交换的**比例映射**测试（`src/annotationSwapPure.ts`）。
 *
 * 背景：标注管理里"把 A 图的标注整套搬到 B 图"是修正常见错误的操作，而标注框存的是
 * **绝对像素坐标**，ok_templates 里的图片尺寸又并不一致（截图与导入图混在一起）。
 * 这段映射的数值一旦算错，产出的是一份**看起来正常**的 COCO：框还在、分类还在、
 * 保存也成功，只有裁剪出来的模板是错的 —— 静默失败，所以必须钉死。
 *
 * 钉住的不变量：
 * 1. **同尺寸恒等**：比值恰为 1 时四个字段逐字节不变（同分辨率截图互换不该漂一格）；
 * 2. **按比例**：`x' = x * W2 / W1`，且四舍五入到整数（COCO 里的框本来就是整数）；
 * 3. **不越界**：任何输入组合下，映射结果都完整落在目标图内，宽高至少 1px
 *    —— 越界的框在画布上画不出来、点不到，只能手改 JSON 才能修；
 * 4. **不产生 NaN / Infinity**：尺寸读不出来（0 或 undefined）时退化成"原样搬运"，
 *    而不是把整份数据写成 NaN。
 *
 * 本模块刻意不 import `vscode`，所以这里**不需要任何桩**，直接 require 编译产物。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const purePath = path.join(root, 'out', 'annotationSwapPure.js');
const pure = require(purePath);

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

const box = (category, x, y, w, h) => ({ category, x, y, w, h });
const FHD = { width: 1920, height: 1080 };
const HD = { width: 1280, height: 720 };
const SMALL = { width: 800, height: 600 };

/* ── 1. 同尺寸恒等 ────────────────────────────────────────────────── */
console.log('同尺寸：逐字段不变');
{
  const boxes = [box('btn', 100, 200, 300, 400), box('icon', 0, 0, 1, 1)];
  const mapped = pure.scaleBoxes(boxes, FHD, FHD);
  check(mapped.length === 2, '框数量不变（扫到 2 个）');
  check(
    mapped.every((m, i) => m.category === boxes[i].category
      && m.x === boxes[i].x && m.y === boxes[i].y && m.w === boxes[i].w && m.h === boxes[i].h),
    '同尺寸时四个坐标字段逐字段相同（比值恰为 1，不因浮点漂一格）',
  );
  check(pure.isSameSize(FHD, { width: 1920, height: 1080 }), 'isSameSize 对同尺寸为真');
  check(!pure.isSameSize(FHD, SMALL), 'isSameSize 对不同尺寸为假');
}

/* ── 2. 按比例缩放 ────────────────────────────────────────────────── */
console.log('按比例：x\' = x * W2 / W1');
{
  // 2.1 整数倍：1920x1080 → 960x540（比例 0.5）
  const half = pure.scaleBoxes([box('btn', 100, 200, 300, 400)], FHD, { width: 960, height: 540 });
  check(
    half[0].x === 50 && half[0].y === 100 && half[0].w === 150 && half[0].h === 200,
    `整数倍精确缩放：期望 50/100/150/200，实际 ${half[0].x}/${half[0].y}/${half[0].w}/${half[0].h}`,
  );

  // 2.2 非整数比：1920x1080 → 800x600（rx=0.4167、ry=0.5556）
  const odd = pure.scaleBoxes([box('btn', 100, 200, 300, 400)], FHD, SMALL);
  check(
    odd[0].x === 42 && odd[0].y === 111 && odd[0].w === 125 && odd[0].h === 222,
    `非整数比四舍五入：期望 42/111/125/222，实际 ${odd[0].x}/${odd[0].y}/${odd[0].w}/${odd[0].h}`,
  );

  // 2.3 分类名原样带走 —— 交换不产生新分类（分类名全项目唯一，改名会撞校验）
  check(odd[0].category === 'btn', '分类名原样保留');
  check(!('id' in odd[0]), '不携带标注 id（id 由数据层重新分配）');

  // 2.4 两个轴独立缩放：宽扁的图换到高窄的图上，宽高比必须各自算
  const wide = pure.scaleBoxes([box('a', 400, 100, 400, 100)], { width: 1000, height: 1000 }, { width: 2000, height: 500 });
  check(
    wide[0].x === 800 && wide[0].w === 800 && wide[0].y === 50 && wide[0].h === 50,
    `两个轴各算各的：期望 800/50/800/50，实际 ${wide[0].x}/${wide[0].y}/${wide[0].w}/${wide[0].h}`,
  );
}

/* ── 3. 不越界（核心不变量） ──────────────────────────────────────── */
console.log('不越界：任何输入都落在目标图内');
{
  const sizes = [FHD, HD, SMALL, { width: 100, height: 100 }, { width: 37, height: 11 }];
  let scanned = 0;
  let outside = 0;
  let degenerate = 0;
  for (const from of sizes) {
    for (const to of sizes) {
      // 刻意包含贴边、越界源框（旧数据里确实可能有）
      const boxes = [
        box('a', 0, 0, from.width, from.height),
        box('b', from.width - 1, from.height - 1, 1, 1),
        box('c', Math.round(from.width / 2), Math.round(from.height / 2), 3, 3),
        box('d', from.width, from.height, 10, 10),
      ];
      for (const m of pure.scaleBoxes(boxes, from, to)) {
        scanned++;
        if (m.x < 0 || m.y < 0 || m.x + m.w > to.width || m.y + m.h > to.height) outside++;
        if (m.w < 1 || m.h < 1) degenerate++;
      }
    }
  }
  // 空集包含于任何集合 ⇒ 先确认真的扫到了东西
  check(scanned >= 100, `扫描到的映射结果数 ≥ 100（实际 ${scanned}）—— 否则下面的断言恒真`);
  check(outside === 0, `没有任何映射结果越出目标图边界（越界 ${outside} 个）`);
  check(degenerate === 0, `没有宽高 <1 的退化框（退化 ${degenerate} 个）`);

  // 3.1 贴边源框映射到更小的目标图：必须被拉回来
  const pulled = pure.scaleBoxes([box('edge', 1920 - 4, 1080 - 4, 4, 4)], FHD, SMALL)[0];
  check(
    pulled.x + pulled.w <= SMALL.width && pulled.y + pulled.h <= SMALL.height && pulled.w >= 1 && pulled.h >= 1,
    `贴边框映射到小图后被拉回边界内：x=${pulled.x} y=${pulled.y} w=${pulled.w} h=${pulled.h}`,
  );

  // 3.2 源框本身就越界（旧数据）：仍要落在目标图内
  const badSource = pure.scaleBoxes([box('bad', 5000, 5000, 900, 900)], FHD, SMALL)[0];
  check(
    badSource.x + badSource.w <= SMALL.width && badSource.y + badSource.h <= SMALL.height,
    '源框越界时也不会把越界带到目标图（按比例缩完再钳制）',
  );
}

/* ── 4. 尺寸读不出来时不产生 NaN ─────────────────────────────────── */
console.log('退化尺寸：退化成原样搬运，不产生 NaN');
{
  const boxes = [box('a', 100, 200, 300, 400)];
  const cases = [
    ['from 为 undefined', pure.scaleBoxes(boxes, undefined, SMALL)],
    ['from 为 0x0', pure.scaleBoxes(boxes, { width: 0, height: 0 }, SMALL)],
    ['to 为 undefined', pure.scaleBoxes(boxes, FHD, undefined)],
    ['to 为 0x0', pure.scaleBoxes(boxes, FHD, { width: 0, height: 0 })],
    ['两侧都不可用', pure.scaleBoxes(boxes, undefined, undefined)],
  ];
  let finite = 0;
  for (const [label, mapped] of cases) {
    const m = mapped[0];
    const ok = [m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v)) && m.w >= 1 && m.h >= 1;
    if (ok) finite++;
    check(ok, `${label}：坐标有限且宽高 ≥1（x=${m.x} y=${m.y} w=${m.w} h=${m.h}）`);
  }
  check(finite === cases.length, `5 种退化情形全部安全（实际 ${finite}/${cases.length}）`);

  check(!pure.isUsableSize(undefined), 'isUsableSize(undefined) 为假');
  check(!pure.isUsableSize({ width: 0, height: 100 }), 'isUsableSize 拒绝 0 宽');
  check(pure.isUsableSize({ width: 1, height: 1 }), 'isUsableSize 接受 1x1');
  check(!pure.isSameSize(undefined, undefined), '两侧都不可用时 isSameSize 为假（不能据此宣称"尺寸相同"）');
}

/* ── 5. 破坏性对照：证明上面的断言真的在约束实现 ──────────────────── */
console.log('破坏性对照');
{
  const source = fs.readFileSync(purePath, 'utf8');
  function evalSandbox(code) {
    const sandbox = { exports: {} };
    new Function('module', 'exports', 'require', code)(sandbox, sandbox.exports, require);
    return sandbox.exports;
  }

  // 对照一：去掉边界钳制（x/y 直接放行）
  // 用**源框本身就越界**的输入：按比例映射只会等比缩小，正常输入最多因四舍五入
  // 越界 1px，不足以暴露"钳制被拿掉"；而旧数据里的越界框正是钳制真正要救的情形。
  const noClamp = source.replace(
    'Math.min(Math.max(0, box.x), to.width - w)',
    'box.x',
  );
  check(noClamp !== source, '对照一源码确实被改动了（替换命中）—— 否则对照是假的');
  const strayBox = [box('stray', 5000, 5000, 900, 900)];
  const noClampOut = evalSandbox(noClamp).scaleBoxes(strayBox, FHD, SMALL)[0];
  const clampedOut = pure.scaleBoxes(strayBox, FHD, SMALL)[0];
  check(
    clampedOut.x + clampedOut.w <= SMALL.width,
    `钳制生效时越界源框被拉回（x+w=${clampedOut.x + clampedOut.w} ≤ ${SMALL.width}）`,
  );
  check(
    noClampOut.x + noClampOut.w > SMALL.width,
    `对照一：拿掉钳制后越界源框留在界外（x+w=${noClampOut.x + noClampOut.w} > ${SMALL.width}）—— 与第 3 组相反`,
  );

  // 对照二：比例取反（用 W1/W2 而不是 W2/W1）
  const inverted = source.replace(
    'return from > 0 && to > 0 ? to / from : 1;',
    'return from > 0 && to > 0 ? from / to : 1;',
  );
  check(inverted !== source, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');
  const invertedOut = evalSandbox(inverted).scaleBoxes([box('btn', 100, 200, 300, 400)], FHD, { width: 960, height: 540 })[0];
  check(
    invertedOut.x !== 50,
    `对照二：比例取反后整数倍缩放不再是 50（实际 x=${invertedOut.x}）—— 与第 2 组相反`,
  );

  // 对照三：去掉"尺寸不可用就退化成 1"的守卫
  const noGuard = source.replace(
    'return from > 0 && to > 0 ? to / from : 1;',
    'return to / from;',
  );
  check(noGuard !== source, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');
  const noGuardOut = evalSandbox(noGuard).scaleBoxes([box('a', 100, 200, 300, 400)], FHD, undefined)[0];
  check(
    noGuardOut.w < 1,
    `对照三：拿掉退化守卫后目标尺寸缺失会把框压成 0 宽（w=${noGuardOut.w}）—— 与第 4 组相反`,
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);
