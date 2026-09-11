/**
 * 缩略图缓存「以原图内容 hash 为唯一标识」回归测试。
 *
 * 背景：缓存 key 与磁盘文件名早先由 imagePath 参与哈希。同名图片被替换后
 * key 不变 → 旧缩略图被直接复用 → 面板里看到的图与点击打开的图不一致。
 * 现在 key = hash(内容 hash + bbox + 目标高度)，本测试锁住这个行为。
 *
 * 覆盖：
 *  - 同名图片内容变化 → 内容 hash 变化
 *  - 磁盘缩略图落到新文件，且二进制内容不同（不再复用旧图）
 *  - 内容未变时仍命中同一份缓存（不能误判为失效）
 *  - 内存 data URL 缓存同样按内容 hash 隔离
 *  - 图片被替换后 removeTemplateThumbFile 删掉的是「改动前」那份
 *  - purgeLegacyThumbFiles 只清旧命名（t_/a_），保留新命名（t2_/a2_）
 *  - worker 落盘的文件名与主线程按内容 hash 算出的名字一致
 *
 * out/pngCrop.js 经 featureData 间接依赖 vscode（扩展宿主注入的模块），
 * Node 下 require 不到，这里做一个空壳桩顶上；被测函数只用 fs/path/crypto。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Module = require('module');
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-vscode-stub-'));
const VSCODE_STUB = path.join(stubDir, 'vscode.js');
fs.writeFileSync(VSCODE_STUB, 'module.exports = {};\n');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return VSCODE_STUB;
  return origResolve.call(this, request, ...rest);
};

const root = path.resolve(__dirname, '..');
const pngCrop = require(path.join(root, 'out', 'pngCrop.js'));

const BBOX = [0, 0, 8, 8];
const RED = [220, 40, 40];
const BLUE = [40, 80, 220];
const GREEN = [40, 200, 90];

/** 生成纯色 PNG（借用被测模块的编码器，保证是合法图片） */
function solidPng(size, rgb) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return pngCrop.encodePngRgb(size, size, rgba);
}

// 覆盖写可能被文件系统截断到同一毫秒 → 显式推进 mtime，保证 stat 指纹一定变化
let clockOffset = 1000;
function writeImage(imgPath, rgb) {
  fs.mkdirSync(path.dirname(imgPath), { recursive: true });
  fs.writeFileSync(imgPath, solidPng(8, rgb));
  const t = new Date(Date.now() + (clockOffset += 1000));
  fs.utimesSync(imgPath, t, t);
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-thumb-hash-'));
  const thumbDir = path.join(tmpRoot, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const imgA = path.join(tmpRoot, 'assets', 'images', 'same_name.png');

  /* ---- 1. 内容 hash 随内容变化 ---- */
  writeImage(imgA, RED);
  const hashRed = pngCrop.imageContentHash(imgA);
  assert.ok(hashRed, '应算出内容 hash');
  writeImage(imgA, BLUE);
  const hashBlue = pngCrop.imageContentHash(imgA);
  assert.notStrictEqual(hashBlue, hashRed, '同名图片内容变化后 hash 必须变化');

  /* ---- 2. 磁盘缩略图不再复用旧图 ---- */
  writeImage(imgA, RED);
  const fileRed = await pngCrop.cropTemplateThumbFileAsync(imgA, BBOX, thumbDir);
  assert.ok(fileRed && fs.existsSync(fileRed), '应生成缩略图文件');
  const bytesRed = fs.readFileSync(fileRed);

  writeImage(imgA, BLUE);
  const fileBlue = await pngCrop.cropTemplateThumbFileAsync(imgA, BBOX, thumbDir);
  assert.ok(fileBlue && fs.existsSync(fileBlue), '内容变化后应生成新的缩略图文件');
  assert.notStrictEqual(fileBlue, fileRed, '内容变化后必须落到新文件，不能复用旧缩略图');
  assert.notStrictEqual(
    fs.readFileSync(fileBlue).toString('base64'),
    bytesRed.toString('base64'),
    '两次缩略图的像素内容必须不同',
  );

  /* ---- 3. 内容未变时命中同一份缓存 ---- */
  const fileAgain = await pngCrop.cropTemplateThumbFileAsync(imgA, BBOX, thumbDir);
  assert.strictEqual(fileAgain, fileBlue, '内容未变时应命中同一份缓存');

  /* ---- 4. 内存 data URL 缓存同样按内容 hash 隔离 ---- */
  const urlBlue = pngCrop.cropTemplateToDataUrlCached(imgA, BBOX);
  assert.ok(urlBlue, '应拿到 data URL');
  writeImage(imgA, GREEN);
  const urlGreen = pngCrop.cropTemplateToDataUrlCached(imgA, BBOX);
  assert.notStrictEqual(urlGreen, urlBlue, '内存缓存也要以内容 hash 为 key');

  /* ---- 5. 图片被替换后，删除的是「改动前」那份缩略图 ---- */
  writeImage(imgA, RED);
  const fileBeforeReplace = await pngCrop.cropTemplateThumbFileAsync(imgA, BBOX, thumbDir);
  assert.ok(fs.existsSync(fileBeforeReplace));
  writeImage(imgA, BLUE); // 替换内容，此时还没人重算 hash
  pngCrop.removeTemplateThumbFile(imgA, BBOX, thumbDir);
  assert.ok(!fs.existsSync(fileBeforeReplace), '旧内容对应的缩略图应被删除');

  /* ---- 6. 旧命名清理只针对 t_/a_ ---- */
  const legacyDir = path.join(tmpRoot, 'legacy');
  fs.mkdirSync(path.join(legacyDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(legacyDir, 'annotated'), { recursive: true });
  const files = {
    legacyThumb: path.join(legacyDir, 'assets', 't_0123456789abcdef.png'),
    modernThumb: path.join(legacyDir, 'assets', 't2_0123456789abcdef.png'),
    legacyAnn: path.join(legacyDir, 'annotated', 'a_0123456789abcdef.png'),
    modernAnn: path.join(legacyDir, 'annotated', 'a2_0123456789abcdef.png'),
  };
  for (const f of Object.values(files)) fs.writeFileSync(f, 'x');
  pngCrop.purgeLegacyThumbFiles(legacyDir);
  assert.ok(!fs.existsSync(files.legacyThumb), '旧 t_ 缩略图应被清理');
  assert.ok(!fs.existsSync(files.legacyAnn), '旧 a_ 标注图应被清理');
  assert.ok(fs.existsSync(files.modernThumb), '新 t2_ 缩略图必须保留');
  assert.ok(fs.existsSync(files.modernAnn), '新 a2_ 标注图必须保留');

  /* ---- 7. worker 落盘文件名必须与主线程一致 ---- */
  pngCrop.initCropWorkerPool(root, 1);
  const imgB = path.join(tmpRoot, 'ok_templates', 'worker.png');
  try {
    writeImage(imgB, RED);
    const wFile1 = await pngCrop.cropTemplateThumbFileAsync(imgB, BBOX, thumbDir);
    assert.ok(wFile1 && fs.existsSync(wFile1), 'worker 应把缩略图写到主线程预期的位置');
    writeImage(imgB, GREEN);
    const wFile2 = await pngCrop.cropTemplateThumbFileAsync(imgB, BBOX, thumbDir);
    assert.ok(
      fs.existsSync(wFile2),
      'worker 落盘文件名必须与主线程按内容 hash 算出的名字一致',
    );
    assert.notStrictEqual(wFile2, wFile1, '内容变化后 worker 应写到新文件');
  } finally {
    pngCrop.disposeCropWorkerPool();
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
  console.log('test_thumb_content_hash: all assertions passed');
}

main().catch((err) => {
  console.error('test_thumb_content_hash FAILED:', err);
  process.exit(1);
});
