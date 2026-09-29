#!/usr/bin/env node
/**
 * 框资源契约测试（`src/boxResourcePure.ts` + `src/boxResourceStore.ts`）。
 *
 * Authoring 已切换为与模板标注一致的 Pixel 模型，钉住这些不变量：
 * 1. 运行时路径是 约定 > config.py > src/scene/boxes.json，首选存在时不合并探测位置；
 * 2. Authoring 是 Pixel bbox + 图片 width/height（version 2），序列化整数、按 path 排序；
 * 3. Publish 是 Pixel → normalized 的唯一入口，输出 6 位小数，丢 image；
 * 4. 旧 normalized（version 1）不受支持：解析直接报 version 错误，不做迁移；
 * 5. 图片交换：同尺寸换 image，不同尺寸按比例映射并钳制进目标边界；
 * 6. 生成框走 Pixel union，全程不出现 normalized；
 * 7. webview 的路径校验规则由宿主下发，不允许再内联一份。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pure = require(path.join(root, 'out', 'boxResourcePure'));
const config = require(path.join(root, 'out', 'projectConfigPure'));
const store = require(path.join(root, 'out', 'boxResourceStore'));

// 测试图直接在这里造（最小合法 PNG：签名 + IHDR + IDAT + IEND）。
// 不能 require out/pngCrop：它的 featureData 导入链会牵进 projectConfig → vscode，
// 在 CI 的普通 node 进程里直接 Cannot find module 'vscode'。
const zlib = require('zlib');
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  let c = 0xffffffff;
  for (const byte of body) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function writePng(file, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  const raw = Buffer.alloc((width + 1) * height); // 每行一个 0 号 filter 字节
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

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

// ── Authoring 的 Pixel 校验 ─────────────────────────────────────────
check(pure.pixelBboxError([10, 20, 300, 200], { width: 1920, height: 1080 }) === undefined, '图内的像素 bbox 合法');
check(pure.pixelBboxError([-1, 20, 300, 200], { width: 1920, height: 1080 }) === 'rect', '负坐标拒绝');
check(pure.pixelBboxError([0, 0, 0, 100], { width: 1920, height: 1080 }) === 'rect', '零宽拒绝');
check(pure.pixelBboxError([1900, 20, 300, 200], { width: 1920, height: 1080 }) === 'rect', '越出右边界拒绝');
check(pure.pixelBboxError([0, 0, 1920, 200], { width: 1920, height: 1080 }) === undefined, '贴边矩形可以保存');
check(pure.pixelBboxError([0, 0, 30, 20]) === undefined, '尺寸未知时只查正性');

const union = pure.unionPixelBoxes([{ x: 100, y: 50, w: 40, h: 30 }, { x: 120, y: 60, w: 60, h: 20 }]);
check(union && union.x === 100 && union.y === 50 && union.w === 80 && union.h === 30, 'Pixel union 是最小包围框');
check(pure.unionPixelBoxes([]) === undefined, '空列表没有包围框');

// ── v2 解析 / 序列化 ─────────────────────────────────────────────────
const fileV2 = {
  version: pure.AUTHORING_VERSION,
  images: [{ file: '12.png', width: 1920, height: 1080 }],
  boxes: [{ path: 'screen.main_viewport', image: '12.png', bbox: [184, 112, 1544, 853] }],
};
const text = pure.serializeAuthoring(fileV2);
check(text.includes('"version": 2'), 'authoring 序列化是 version 2');
check(!text.includes('0.100000'), 'authoring 不再出现 normalized 小数');
const round = pure.parseAuthoring(text);
check(!round.errors.length, '刚写出的文件能原样读回');
check(round.file.boxes[0].path === 'screen.main_viewport' && round.file.boxes[0].bbox.join() === '184,112,1544,853', '读回后 bbox 是同一组整数');
check(round.file.images[0].width === 1920 && round.file.images[0].height === 1080, '读回后图片尺寸还在');

const badParse = pure.parseAuthoring(JSON.stringify({
  version: 2,
  images: [{ file: '12.png', width: 1920, height: 1080 }],
  boxes: [
    { path: 'screen.ok', image: '12.png', bbox: [0, 0, 10, 10] },
    { path: 'screen.ok', image: '12.png', bbox: [0, 0, 10, 10] },
    { path: 'screen.a', image: 'missing.png', bbox: [0, 0, 10, 10] },
    { path: 'screen.b', image: '12.png', bbox: [0, 0, 99999, 10] },
    { path: 'mainonly', image: '12.png', bbox: [0, 0, 10, 10] },
  ],
}));
check(badParse.errors.includes('1:duplicate'), '重复 path 记错');
check(badParse.errors.includes('3:rect'), '越界 bbox 记错');
check(badParse.errors.includes('4:path'), '一段 path 记错');
const unregistered = badParse.file.boxes.find((box) => box.path === 'screen.a');
check(!!unregistered, '引用未登记图片的框保持可读（0 尺寸占位）');
check(badParse.file.images.some((item) => item.file === 'missing.png' && item.width === 0), '未登记图片按 0 尺寸占位');
const unregisteredPublish = pure.publishBoxes(badParse.file);
check(unregisteredPublish.errors.some((item) => item === 'size:screen.a'), '0 尺寸占位的框发布时按 size: 报告');

// ── 内存编辑：replaceAuthoringImages ────────────────────────────────
const edited = pure.replaceAuthoringImages(fileV2, [{
  fileName: '12.png', width: 1920, height: 1080,
  boxes: [{ path: 'combat.enemy.hp', x: 5, y: 6, w: 100, h: 50 }],
}]);
check(!edited.error, '整图替换成功');
check(edited.file.boxes.length === 1 && edited.file.boxes[0].path === 'combat.enemy.hp', '旧框被这套替换掉');
check(edited.file.images[0].width === 1920, 'images 条目随编辑刷新');
const fresh = pure.replaceAuthoringImages(pure.emptyAuthoringFile(), [{
  fileName: 'new.png', width: 640, height: 480,
  boxes: [{ path: 'screen.x', x: 1, y: 2, w: 30, h: 40 }],
}]);
check(!fresh.error && fresh.file.images.some((item) => item.file === 'new.png'), '首次编辑登记新图片尺寸');
check(pure.replaceAuthoringImages(fileV2, [
  { fileName: 'a.png', width: 100, height: 100, boxes: [{ path: 'screen.ok', x: 0, y: 0, w: 10, h: 10 }] },
  { fileName: 'a.png', width: 100, height: 100, boxes: [{ path: 'screen.bad', x: 0, y: 0, w: 999, h: 10 }] },
]).error === 'rect', '多图编辑有一张越界就整批失败');

const trimmedEdit = pure.replaceAuthoringImages(fileV2, [{
  fileName: '12.png', width: 1920, height: 1080,
  boxes: [{ path: '  screen.padded  ', x: 1, y: 2, w: 30, h: 40 }],
}]);
check(!trimmedEdit.error && trimmedEdit.file.boxes[0].path === 'screen.padded', '保存前 path 先 trim，不以原值入库');
const paddedParse = pure.parseAuthoring(pure.serializeAuthoring({
  version: pure.AUTHORING_VERSION,
  images: [{ file: '12.png', width: 1920, height: 1080 }],
  boxes: [{ path: ' screen.pad2 ', image: '12.png', bbox: [1, 2, 30, 40] }],
}));
check(!paddedParse.errors.length && paddedParse.file.boxes[0].path === 'screen.pad2', '解析时 path 同样先 trim');

// ── 图片交换：同尺寸换 image，不同尺寸按比例映射 ─────────────────────
const swapBase = {
  version: pure.AUTHORING_VERSION,
  images: [
    { file: 'big.png', width: 1920, height: 1080 },
    { file: 'small.png', width: 960, height: 540 },
  ],
  boxes: [
    { path: 'screen.a', image: 'big.png', bbox: [960, 540, 960, 540] },
    { path: 'screen.b', image: 'small.png', bbox: [480, 270, 480, 270] },
  ],
};
const swappedSame = pure.swapImageBoxes({
  version: pure.AUTHORING_VERSION,
  images: [{ file: 'a.png', width: 100, height: 100 }, { file: 'b.png', width: 100, height: 100 }],
  boxes: [{ path: 'screen.a', image: 'a.png', bbox: [10, 10, 20, 20] }],
}, 'a.png', 'b.png');
check(!swappedSame.error && swappedSame.file.boxes[0].image === 'b.png' && swappedSame.file.boxes[0].bbox.join() === '10,10,20,20', '同尺寸交换坐标逐字段不变');
const swappedDiff = pure.swapImageBoxes(swapBase, 'big.png', 'small.png');
check(!swappedDiff.error, '不同尺寸也能交换');
const movedA = swappedDiff.file.boxes.find((box) => box.path === 'screen.a');
check(movedA.image === 'small.png' && movedA.bbox.join() === '480,270,480,270', 'big→small 按比例映射（x/2）');
const movedB = swappedDiff.file.boxes.find((box) => box.path === 'screen.b');
check(movedB.image === 'big.png' && movedB.bbox.join() === '960,540,960,540', 'small→big 按比例映射（x*2）');
check(pure.swapImageBoxes({ ...swapBase, images: [{ file: 'big.png', width: 1920, height: 1080 }] }, 'big.png', 'small.png').error === 'size', '尺寸缺失的交换拒绝');

// ── Publish：Pixel → normalized 的唯一入口 ──────────────────────────
const published = pure.publishBoxes(fileV2);
check(!published.errors.length, '尺寸齐全时发布成功');
check(published.file.version === pure.RUNTIME_VERSION, 'runtime 还是 version 1');
const rect = published.file.boxes[0].rect;
check(
  rect[0] === 184 / 1920 && rect[1] === 112 / 1080
  && rect[2] === (184 + 1544) / 1920 && rect[3] === (112 + 853) / 1080,
  '发布输出 normalized [left, top, right, bottom]',
);
const runtimeText = pure.serializeRuntime(published.file);
check(runtimeText.includes('0.095833'), 'runtime 序列化固定 6 位小数');
check(pure.publishBoxes({ ...fileV2, images: [] }).errors.some((item) => item.startsWith('size:')), '尺寸缺失的框不发布并记错');
check(pure.isStorableRuntimeRect(rect) && !pure.isStorableRuntimeRect([0, 0, 2, 0.5]), '0~1 规则只属于 Runtime');

const status = pure.publishStatus(
  fileV2,
  { version: 1, boxes: [{ path: 'screen.main_viewport', rect }] },
);
check(status[0].status === 'same', '发布状态一致');
check(pure.publishStatus(fileV2, { version: 1, boxes: [{ path: 'gone.only', rect }] })
  .some((item) => item.status === 'runtimeOnly'), '运行时独有的 path 单独标记');

// ── 旧 normalized（version 1）不受支持，也不迁移 ────────────────────
const legacyText = JSON.stringify({
  version: 1,
  boxes: [{ path: 'screen.main_viewport', image: '12.png', rect: [0.1, 0.2, 0.9, 0.8] }],
});
const legacyParsed = pure.parseAuthoring(legacyText);
check(legacyParsed.file.boxes.length === 0 && legacyParsed.errors.includes('version'), 'v1 authoring 直接报 version 错误');
check(typeof pure.parseLegacyAuthoring === 'undefined' && typeof pure.migrateAuthoringV1 === 'undefined', '迁移函数已从纯模块删除');

// ── 读盘侧：自动创建、登记、迁移写回 ────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-boxes-pixel-'));
try {
  const templates = 'ok_templates';
  const templatesAbs = path.join(tmp, templates);
  fs.mkdirSync(templatesAbs, { recursive: true });
  const writeImage = (name, width, height) => {
    writePng(path.join(templatesAbs, name), width, height);
  };
  writeImage('12.png', 1920, 1080);

  const err1 = store.addBox(tmp, templates, 'screen.main_viewport', '12.png', { x: 184, y: 112, w: 1544, h: 853 });
  check(err1 === undefined, '首次合法保存自动创建 boxes.json');
  const authoring1 = store.readAuthoringFile(tmp, templates);
  check(authoring1.images.some((item) => item.file === '12.png' && item.width === 1920), '保存时登记图片尺寸');
  check(pure.serializeAuthoring(authoring1) === pure.serializeAuthoring(store.readAuthoringFile(tmp, templates)), '读回稳定');
  check(store.addBox(tmp, templates, 'screen.main_viewport', '12.png', { x: 0, y: 0, w: 10, h: 10 }) === 'duplicate', '重复 path 拒绝');
  check(store.addBox(tmp, templates, 'screen.huge', '12.png', { x: 0, y: 0, w: 9999, h: 10 }) === 'rect', '越界 bbox 拒绝');
  check(store.addBox(tmp, templates, 'panels.x', '12.png', { x: 0, y: 0, w: 10, h: 10 }) === 'reserved', '保留根拒绝');
  check(store.addBox(tmp, templates, 'screen.other', 'missing.png', { x: 0, y: 0, w: 10, h: 10 }) === 'image', '图片不存在拒绝');

  const saveErr = store.replaceImageBoxes(tmp, templates, '12.png', 1920, 1080, [
    { path: 'screen.main_viewport', x: 200, y: 120, w: 1500, h: 840 },
  ]);
  check(saveErr === undefined, '整图替换保存成功');
  const authoring2 = store.readAuthoringFile(tmp, templates);
  check(authoring2.boxes.length === 1 && authoring2.boxes[0].bbox.join() === '200,120,1500,840', '替换后只剩新框');

  const published2 = store.publishRuntime(tmp, templates);
  check(published2.ok && !published2.errors.length, '发布成功');
  const runtimeFile = path.join(tmp, 'src', 'scene', 'boxes.json');
  check(fs.existsSync(runtimeFile), '运行时文件已写出');
  const runtimeRead = pure.parseRuntime(fs.readFileSync(runtimeFile, 'utf8'));
  check(!runtimeRead.errors.length && runtimeRead.file.boxes[0].path === 'screen.main_viewport', '运行时内容可读');
  check(fs.readFileSync(runtimeFile, 'utf8').includes('0.104167'), '发布坐标是 normalized 6 位小数');

  // version 1 读盘：报 version 错误，不做迁移，文件保持原样
  const legacyFile = path.join(templatesAbs, 'boxes.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    boxes: [{ path: 'screen.legacy', image: '12.png', rect: [0.25, 0.25, 0.75, 0.75] }],
  }));
  const legacyErrors = store.authoringReadErrors(tmp, templates);
  check(legacyErrors.includes('version'), 'v1 读盘报 version 错误（不支持，不迁移）');
  const legacyRead = store.readAuthoringFile(tmp, templates);
  check(legacyRead.boxes.length === 0 && legacyRead.images.length === 0, 'v1 不产出任何框');
  check(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).version === 1, '不做迁移写回，文件保持原样');

  // 删除图片：框与尺寸登记一起消失，失败时快照恢复（先把干净的 v2 写回去）
  fs.writeFileSync(legacyFile, pure.serializeAuthoring(authoring2));
  const snapshot = store.captureAuthoring(tmp, templates);
  check(store.removeImageBoxes(tmp, templates, '12.png'), '先去掉这张图的框');
  const afterRemove = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  check(!afterRemove.images.some((item) => item.file === '12.png'), '尺寸登记也清掉');
  check(store.restoreAuthoring(tmp, templates, snapshot), '图片还在时写回原文件');

  // 交换（读盘侧）：目标图没登记尺寸时从图片头补登记
  writeImage('big.png', 1920, 1080);
  writeImage('small.png', 960, 540);
  const swapBaseNoEntry = {
    ...swapBase,
    images: [swapBase.images[0]], // small.png 没登记（从未标过框的新截图场景）
  };
  fs.writeFileSync(path.join(templatesAbs, 'boxes.json'), pure.serializeAuthoring(swapBaseNoEntry));
  // 界面预检查用的尺寸查询：与补登记同一条回退。此时 small.png 只有 0 尺寸占位条目
  // （box screen.b 引用了它但没登记尺寸）—— 不回退图片头的话，界面会在弹确认框前先拦下。
  check(
    JSON.stringify(store.authoringImageSize(tmp, templates, 'big.png')) === JSON.stringify({ width: 1920, height: 1080 }),
    '已登记的有效尺寸直接返回登记值',
  );
  check(
    JSON.stringify(store.authoringImageSize(tmp, templates, 'small.png')) === JSON.stringify({ width: 960, height: 540 }),
    '0 尺寸占位时回退图片头',
  );
  check(store.authoringImageSize(tmp, templates, 'not-here.png') === undefined, '图片头也读不出来时返回 undefined');
  check(store.swapImageBoxes(tmp, templates, 'big.png', 'small.png'), '目标图缺尺寸登记时交换成功');
  const afterSwap = store.readAuthoringFile(tmp, templates);
  check(afterSwap.boxes.find((box) => box.path === 'screen.a').image === 'small.png', '交换后框换了宿主');
  check(afterSwap.images.some((item) => item.file === 'small.png' && item.width === 960), '交换时补登记了目标图尺寸');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── webview 与宿主共用同一份路径规则 ─────────────────────────────────
const appSource = fs.readFileSync(path.join(root, 'media', 'annotationPanel', 'app.js'), 'utf8');
const annotationSource = fs.readFileSync(path.join(root, 'src', 'annotationPanel.ts'), 'utf8');
const boxPanelsSource = fs.readFileSync(path.join(root, 'src', 'boxPanels.ts'), 'utf8');

check(typeof pure.BOX_PATH_SEGMENT_SOURCE === 'string', '纯模块导出段名规则的字面量');
const injectedSegment = new RegExp(pure.BOX_PATH_SEGMENT_SOURCE);
check(injectedSegment.test('main_viewport') && injectedSegment.test('_p2'), '下发的文法接受 Python 标识符');
check(!injectedSegment.test('2bad') && !injectedSegment.test('has-dash') && !injectedSegment.test(''), '下发的文法拒绝数字开头与非标识符');
check(!/SEGMENT\s*=\s*\//.test(appSource) && !/RESERVED_BOX_ROOTS\s*=/.test(appSource), 'webview 不再内联自己的路径文法');
check(/msg\.boxPathRule/.test(appSource), 'webview 从 config 消息取用下发的规则');
check(/ok\.disabled\s*=\s*!!problem/.test(appSource), '路径不合法时禁用保存按钮');
check(/if \(refreshGeneratePathState\(\)\) return;/.test(appSource), '保存前再校验一次，不合法直接拦住');
check(/boxPathOccupied/.test(appSource), 'webview 做全局占用查重');
check(annotationSource.includes('BOX_PATH_SEGMENT_SOURCE') && /boxPaths/.test(annotationSource), '标注编辑器下发规则与 path 占用');
check(boxPanelsSource.includes('BOX_PATH_SEGMENT_SOURCE') && /boxPaths:\s*boxPathOccupancy\(authoring\)/.test(boxPanelsSource), '框编辑器下发规则，占用表字段名是 boxPaths');
check(!/allCategories:\s*boxPathOccupancy/.test(boxPanelsSource), '框编辑器不再把占用表塞进 allCategories');

// ── 占用查重的真实行为（把 webview 的函数抽出来在 Node 里跑）──────────
// BoxEditor 的占用字段曾经接错（下发 allCategories、webview 读 boxPaths），
// 查重静默失效；这里的抽取执行保证字段名与语义都被钉住。
const occupiedStart = appSource.indexOf('function boxPathOccupied(');
const occupiedEnd = appSource.indexOf('\n  }', occupiedStart) + '\n  }'.length;
assert(occupiedStart > 0, 'app.js 里找得到 boxPathOccupied');
const occupiedFn = new Function('imageData', `
  const imageDataRef = imageData;
  ${appSource.slice(occupiedStart, occupiedEnd).replace(/^  /gm, '').replace('imageData?.boxPaths', 'imageDataRef?.boxPaths')}
  return boxPathOccupied;
`);
const occupied = occupiedFn({ boxPaths: { 'screen.main_viewport': '1.png', 'screen.other': '2.png' } });
check(occupied('screen.main_viewport', 'screen.main_viewport') === undefined, '原 path 保持不变：不报重复');
check(occupied('screen.main_viewport', null) === undefined ? false : occupied('screen.main_viewport', null)?.code === 'duplicate', '生成新框时命中占用即重复');
check(occupied('screen.brand_new', 'screen.main_viewport') === undefined, '换成没人占用的 path：放行');
check(occupied('screen.other', 'screen.main_viewport')?.code === 'duplicate', '改成其他图占用的 path：报重复');
check(occupied('  screen.other  ', 'screen.main_viewport')?.code === 'duplicate', '占用比对先做 trim');

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nbox resource pixel contract ok');
