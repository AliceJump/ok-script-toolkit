#!/usr/bin/env node
/**
 * 框资源纯契约测试（`src/boxResourcePure.ts`）。
 *
 * 钉住和模板两份 COCO 同一类的不变量：
 * 1. 运行时路径是 约定 > config.py > src/scene/boxes.json，首选存在时不合并探测位置；
 * 2. 序列化按 path 排序、矩形 6 位小数，改一个框不会重排其余对象；
 * 3. 像素没变时写回保留原浮点；
 * 4. 发布丢掉 image，显隐不进资源。
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pure = require(path.join(root, 'out', 'boxResourcePure'));
const config = require(path.join(root, 'out', 'projectConfigPure'));

const failures = [];
function check(condition, message) {
  if (condition) console.log(`  ok    ${message}`);
  else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

const ROOT = path.join('X:', 'proj');
const PROBE = path.join(ROOT, 'src', 'scene', 'boxes.json');

const plan = (declared, fromConfigPy) => pure.resolveBoxRuntimePlan(ROOT, declared, fromConfigPy);

check(plan().layer === 'probe' && plan().preferred === undefined, '都没声明时来源是探测');
check(plan().probeCandidates.length === 1 && plan().probeCandidates[0] === PROBE, '探测位置是 src/scene/boxes.json');
check(plan('custom/boxes.json').layer === 'convention', '项目约定 boxes.runtime 生效');
check(plan(undefined, 'assets/boxes.json').layer === 'configPy', '只有 config.py 的 boxes_json 时来源是 configPy');
check(plan('custom/boxes.json', 'assets/boxes.json').layer === 'convention', '约定压过 config.py');
check(plan('   ', '  ').layer === 'probe', '空白声明等同于没写');

const preferred = plan('custom/boxes.json');
check(
  pure.effectiveBoxRuntimeFile(preferred, () => true) === path.join(ROOT, 'custom', 'boxes.json'),
  '首选存在时只用首选，不把探测位置并进来',
);
check(pure.effectiveBoxRuntimeFile(plan(), () => false) === undefined, '文件都不存在时读取结果为空');
check(pure.runtimeWriteTarget(plan()) === PROBE, '未声明时发布目标就是探测位置');
check(
  pure.runtimeWriteTarget(preferred) === path.join(ROOT, 'custom', 'boxes.json'),
  '已声明时发布目标是首选，即使文件还没创建',
);
const authoringPath = path.join(ROOT, 'ok_templates', 'boxes.json');
check(pure.sameBoxFile(authoringPath, path.join(ROOT, 'ok_templates', '.', 'boxes.json')), '规范化后同一路径视为同一文件');
check(!pure.sameBoxFile(authoringPath, PROBE), '标注文件和运行时探测位置不是同一个文件');

check(pure.boxPathError('screen.main_viewport') === undefined, 'screen.main_viewport 合法');
check(pure.boxPathError('main_viewport') === 'shallow', '少一层 group 不合法');
check(pure.boxPathError('panels.esc.mail') === 'reserved', 'panels 留给点击点');
check(pure.boxPathError('screen.bad-name') === 'segment', '非法标识符拒绝');
check(pure.boxPathError('') === 'empty', '空路径拒绝');
check(pure.imageFileName('ok_templates/12.png') === '12.png', 'image 只留文件名');

const original = [0.0984, 0.1042, 0.8961, 0.8944];
const pixel = pure.rectToPixel(original, 2560, 1440);
const kept = pure.rectForSave(original, pixel, 2560, 1440);
check(kept === original, '像素没变时保留原浮点数组，打开后保存不会重算');
const moved = { ...pixel, x: pixel.x + 4 };
const rewritten = pure.rectForSave(original, moved, 2560, 1440);
check(rewritten !== original && rewritten[0] !== original[0], '像素变了才重新归一化');

const union = pure.unionOnImage(
  [{ x: 10, y: 20, w: 30, h: 40 }, { x: 50, y: 10, w: 20, h: 15 }],
  100,
  100,
);
check(
  union[0] === 0.1 && union[1] === 0.1 && union[2] === 0.7 && union[3] === 0.6,
  '同图包围框取 min left/top 与 max right/bottom',
);
check(pure.unionOnImage([], 100, 100) === undefined, '空列表没有包围框');

const authoring = {
  version: 1,
  boxes: [
    { path: 'screen.main_viewport', image: '12.png', rect: [0.0984, 0.1042, 0.8961, 0.8944] },
    { path: 'screen.dialog_icon', image: '3.png', rect: [0.845, 0.047, 0.975, 0.074] },
  ],
};
const text = pure.serializeAuthoring(authoring);
const expected = [
  '{',
  '  "version": 1,',
  '  "boxes": [',
  '    {',
  '      "path": "screen.dialog_icon",',
  '      "image": "3.png",',
  '      "rect": [0.845000, 0.047000, 0.975000, 0.074000]',
  '    },',
  '    {',
  '      "path": "screen.main_viewport",',
  '      "image": "12.png",',
  '      "rect": [0.098400, 0.104200, 0.896100, 0.894400]',
  '    }',
  '  ]',
  '}',
  '',
].join('\n');
check(text === expected, '标注资源按 path 排序，矩形固定 6 位小数');

const parsed = pure.parseAuthoring(text);
check(parsed.errors.length === 0 && parsed.file.boxes.length === 2, '刚写出的文件能原样读回');
check(parsed.file.boxes[0].path === 'screen.dialog_icon', '读回后仍按 path 排序');

const runtimeText = pure.serializeRuntime(pure.publishBoxes(parsed.file));
check(!runtimeText.includes('"image"'), '发布结果不含 image');
check(runtimeText.includes('"path": "screen.dialog_icon"'), '发布保留 path 和 rect');

const duplicate = pure.parseAuthoring(JSON.stringify({
  version: 1,
  boxes: [
    { path: 'screen.a', image: '1.png', rect: [0, 0, 0.5, 0.5] },
    { path: 'screen.a', image: '2.png', rect: [0, 0, 0.2, 0.2] },
  ],
}));
check(duplicate.file.boxes.length === 1 && duplicate.file.boxes[0].image === '1.png', '重复 path 保留先出现的那条');
check(duplicate.errors.some((item) => item.endsWith(':duplicate')), '重复 path 记一条错误');

const bad = pure.parseRuntime('{');
check(bad.errors[0] === 'json' && bad.file.boxes.length === 0, '坏 JSON 给出空运行时文件而不是抛异常');

const hidden = pure.applyVisibility(['a', 'b'], new Set(), 'hideAll');
check(hidden.has('a') && hidden.has('b'), '隐藏全部覆盖当前条目');
const shown = pure.applyVisibility(['a', 'b'], hidden, 'showAll');
check(shown.size === 0, '显示全部清空隐藏集合');
const only = pure.applyVisibility(['a', 'b'], shown, 'only', 'b');
check(only.has('a') && !only.has('b'), '只显示当前留下选中项');
const toggled = pure.applyVisibility(['a', 'b'], only, 'toggle', 'a');
check(!toggled.has('a') && !toggled.has('b'), '再勾一次把隐藏去掉');
check(pure.isAnnotationVisible('b', toggled), '不在隐藏集合里的条目可见');

const statuses = pure.publishStatus(parsed.file, pure.parseRuntime(runtimeText).file);
check(statuses.every((item) => item.status === 'same'), '刚发布的运行时与标注几何一致');

const batchRect = [0, 0, 0.5, 0.5];
const batchPixel = pure.rectToPixel(batchRect, 100, 100);
const edit = (fileName, boxPath) => ({
  fileName,
  width: 100,
  height: 100,
  boxes: [{ path: boxPath, x: batchPixel.x, y: batchPixel.y, w: batchPixel.w, h: batchPixel.h, original: batchRect }],
});
const existing = [
  { path: 'screen.a', image: '1.png', rect: batchRect },
  { path: 'screen.b', image: '2.png', rect: batchRect },
];
const conflict = pure.replaceAuthoringImages(existing, [edit('1.png', 'screen.a'), edit('2.png', 'screen.a')]);
check(conflict.error === 'duplicate', '后一张图路径冲突时整批替换失败');
const applied = pure.replaceAuthoringImages(existing, [edit('1.png', 'screen.a'), edit('2.png', 'screen.b')]);
check(!applied.error && applied.boxes.map((box) => box.path).sort().join() === 'screen.a,screen.b', '两张图都合法时一起替换');

const declared = config.boxesRuntimeOf({ boxes: { runtime: 'src/scene/boxes.json' } });
check(declared === 'src/scene/boxes.json', '约定文件的 boxes.runtime 归一化后可读');
check(config.boxesRuntimeOf({ boxes: { runtime: 42 } }) === undefined, '类型不对当没写');

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nbox resource pure ok');
