/**
 * test_asset_pack_worker.js — 纯 node 单测（不依赖 vscode）。
 *
 * 覆盖 saveToAssets 打包渲染的 worker 管线：
 *  1. worker 输出 PNG 与旧主线程 encodePngRgb 逐字节一致（Sub 滤波 + level-6 deflate）
 *  2. bbox 原坐标粘贴、越界裁剪、源图缺失时该源跳过且 page 照常产出（白底）
 *  3. worker 直连回包协议（bytes / skipped / error）
 *  4. renderPagesViaPool：并行完成 + 进度回调单调递增至 total
 *  5. 取消：cancelled() => true 抛 AssetPackCancelledError
 *  6. 池未初始化/已销毁：抛 AssetPackUnavailableError（调用方据此回退内联）
 *
 * 运行：node scripts/test_asset_pack_worker.js（需先 npm run compile）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const assetPack = require(path.join(OUT, 'assetPack.js'));

/* ---------- 测试用 PNG 编解码（RGB 8-bit，与 src/pngCrop.ts 语义一致） ---------- */

function crc32(buf) {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 生成 RGB PNG（filter 0），像素由 f(x,y) => [r,g,b] 决定 */
function makeRgbPng(width, height, f) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = f(x, y);
      const di = y * (stride + 1) + 1 + x * 3;
      raw[di] = r; raw[di + 1] = g; raw[di + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** 与 src/pngCrop.ts encodePngRgb 相同的参考实现（Sub 滤波 + level-6），用于字节级对齐 */
function referenceEncodePngRgb(width, height, rgba) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawRowStart = y * (stride + 1);
    raw[rawRowStart] = 1;
    const rgbaRowStart = y * width * 4;
    const rowStart = rawRowStart + 1;
    raw[rowStart] = rgba[rgbaRowStart];
    raw[rowStart + 1] = rgba[rgbaRowStart + 1];
    raw[rowStart + 2] = rgba[rgbaRowStart + 2];
    for (let x = 1; x < width; x++) {
      const di = rowStart + x * 3;
      const si = rgbaRowStart + x * 4;
      const pi = rgbaRowStart + (x - 1) * 4;
      raw[di] = (rgba[si] - rgba[pi]) & 0xff;
      raw[di + 1] = (rgba[si + 1] - rgba[pi + 1]) & 0xff;
      raw[di + 2] = (rgba[si + 2] - rgba[pi + 2]) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
/** 解码 RGB PNG（支持 filter 0-4）为像素访问器 */
function decodeRgbPng(buf) {
  assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, 'not a png');
  let width = 0, height = 0; const idat = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.strictEqual(data[9], 2, 'expect RGB'); }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rs = y * (stride + 1);
    const filter = raw[rs];
    const row = Buffer.from(raw.subarray(rs + 1, rs + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      switch (filter) {
        case 0: break;
        case 1: row[i] = (row[i] + a) & 0xff; break;
        case 2: row[i] = (row[i] + b) & 0xff; break;
        case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: row[i] = (row[i] + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`bad filter ${filter}`);
      }
    }
    rgb.set(row, y * stride);
    prev = row;
  }
  return { width, height, px: (x, y) => [rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2]] };
}

/* ---------- 测试夹具 ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-assetpack-'));
const srcA = path.join(tmp, 'a.png');
const srcB = path.join(tmp, 'b.png');
// A：x+y 渐变；B：固定色块 + x 通道
fs.writeFileSync(srcA, makeRgbPng(32, 24, (x, y) => [(x * 7) & 0xff, (y * 9) & 0xff, (x + y * 3) & 0xff]));
fs.writeFileSync(srcB, makeRgbPng(32, 24, (x, y) => [200, (x * 5) & 0xff, 30 + y]));

async function main() {
  /* -- 3. worker 直连：回包协议 + skipped 语义 -- */
  const missingPageOut = path.join(tmp, 'direct-missing.png');
  const directReply = await new Promise((resolve, reject) => {
    const w = new Worker(path.join(OUT, 'assetPackWorker.js'));
    w.on('message', (m) => { resolve(m); w.terminate(); });
    w.on('error', reject);
    w.postMessage({
      id: 1, W: 8, H: 8, outPath: missingPageOut,
      sources: [{ imagePath: path.join(tmp, 'no-such-file.png'), rects: [[0, 0, 4, 4]] }],
    });
  });
  assert.ok(!directReply.error, `direct worker error: ${directReply.error}`);
  assert.deepStrictEqual(directReply.skipped, ['no-such-file.png'], 'skipped 应包含缺失源图文件名');
  assert.ok(fs.existsSync(missingPageOut) && fs.statSync(missingPageOut).size > 0, '源图全失败也应产出白底 page');
  const whitePage = decodeRgbPng(fs.readFileSync(missingPageOut));
  assert.deepStrictEqual(whitePage.px(3, 3), [255, 255, 255], '缺失源的 page 保持白底');
  console.log('ok  worker 直连回包协议（bytes/skipped/白底降级）');

  /* -- 1/2/4. 池化渲染：字节级对齐 + 粘贴/裁剪正确性 + 进度 -- */
  assetPack.initAssetPackPool(ROOT, 2);
  assert.ok(assetPack.isAssetPackPoolInitialized(), '池应已初始化');

  const imagesDir = path.join(tmp, 'images');
  const page1Out = path.join(imagesDir, '1.png');
  const page2Out = path.join(imagesDir, '2.png');

  // page1：A 两块 + B 一块（B 后贴、覆盖 A 下缘区域）
  const page1 = {
    W: 32, H: 24, outPath: page1Out,
    sources: [
      { imagePath: srcA, rects: [[0, 0, 16, 16], [16, 8, 16, 16]] },
      { imagePath: srcB, rects: [[0, 16, 32, 8]] },
    ],
  };
  // page2：含越界 bbox（[28,20,8,8] 应裁剪到 28..31 × 20..23）
  const page2 = {
    W: 32, H: 24, outPath: page2Out,
    sources: [{ imagePath: srcA, rects: [[4, 4, 8, 8], [28, 20, 8, 8]] }],
  };

  const progressCalls = [];
  await assetPack.renderPagesViaPool([page1, page2], (done, total) => progressCalls.push([done, total]));

  assert.strictEqual(progressCalls.length, 2, `进度回调次数应为 2，实际 ${progressCalls.length}`);
  assert.deepStrictEqual(progressCalls[1], [2, 2], '最终进度应为 done=2/total=2');
  for (let i = 1; i < progressCalls.length; i++) {
    assert.ok(progressCalls[i][0] > progressCalls[i - 1][0], '进度 done 必须单调递增');
  }

  // 参考渲染：白底画布 + 同序粘贴，用相同编码器做字节级对比
  const refCanvas = (W, H, sources) => {
    const rgba = Buffer.alloc(W * H * 4, 255);
    for (const s of sources) {
      const dec = decodeRgbPng(fs.readFileSync(s.imagePath));
      // decodeRgbPng 输出 RGB，先扩成 RGBA
      const rgbaSrc = Buffer.alloc(dec.width * dec.height * 4, 255);
      for (let i = 0; i < dec.width * dec.height; i++) {
        rgbaSrc[i * 4] = dec.px(i % dec.width, (i / dec.width) | 0)[0];
        rgbaSrc[i * 4 + 1] = dec.px(i % dec.width, (i / dec.width) | 0)[1];
        rgbaSrc[i * 4 + 2] = dec.px(i % dec.width, (i / dec.width) | 0)[2];
      }
      for (const [bx, by, bw, bh] of s.rects) {
        const x1 = Math.max(0, bx), y1 = Math.max(0, by);
        const x2 = Math.min(W, bx + bw), y2 = Math.min(H, by + bh);
        for (let y = y1; y < y2; y++) {
          for (let x = x1; x < x2; x++) {
            const [r, g, b] = dec.px(x, y);
            const di = (y * W + x) * 4;
            rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = 255;
          }
        }
      }
    }
    return rgba;
  };

  const page1Buf = fs.readFileSync(page1Out);
  const page1Expected = referenceEncodePngRgb(32, 24, refCanvas(32, 24, page1.sources));
  assert.ok(page1Buf.equals(page1Expected), 'worker 输出必须与旧主线程 encodePngRgb 逐字节一致');

  const p1 = decodeRgbPng(page1Buf);
  assert.deepStrictEqual(p1.px(0, 0), [(0 * 7) & 0xff, 0, 0], 'A 区块 (0,0)');
  assert.deepStrictEqual(p1.px(20, 12), [(20 * 7) & 0xff, (12 * 9) & 0xff, (20 + 12 * 3) & 0xff], 'A 区块 (20,12)');
  assert.deepStrictEqual(p1.px(5, 20), [200, (5 * 5) & 0xff, 30 + 20], 'B 区块 (5,20)，后贴覆盖');
  assert.deepStrictEqual(p1.px(20, 3), [255, 255, 255], '未覆盖区域保持白底');

  const p2 = decodeRgbPng(fs.readFileSync(page2Out));
  assert.deepStrictEqual(p2.px(5, 5), [(5 * 7) & 0xff, (5 * 9) & 0xff, (5 + 5 * 3) & 0xff], 'page2 A 区块 (5,5)');
  assert.deepStrictEqual(p2.px(30, 22), [(30 * 7) & 0xff, (22 * 9) & 0xff, (30 + 22 * 3) & 0xff], '越界 bbox 裁剪后仍贴上 (30,22)');
  assert.deepStrictEqual(p2.px(0, 22), [255, 255, 255], '越界裁剪之外保持白底');
  console.log('ok  池化渲染：字节级对齐 + 原坐标粘贴/越界裁剪 + 进度单调');

  /* -- 5. 取消 -- */
  await assert.rejects(
    () => assetPack.renderPagesViaPool([page1], undefined, () => true),
    (err) => err instanceof assetPack.AssetPackCancelledError,
    'cancelled() 为 true 时应抛 AssetPackCancelledError',
  );
  console.log('ok  取消语义（AssetPackCancelledError）');

  /* -- 6. 池销毁后不可用 -- */
  assetPack.disposeAssetPackPool();
  assert.ok(!assetPack.isAssetPackPoolInitialized(), '销毁后应标记未初始化');
  await assert.rejects(
    () => assetPack.renderPagesViaPool([page1]),
    (err) => err instanceof assetPack.AssetPackUnavailableError,
    '池销毁后应抛 AssetPackUnavailableError（调用方据此回退内联渲染）',
  );
  console.log('ok  池销毁后不可用（AssetPackUnavailableError）');

  console.log('\nall asset pack worker tests passed');
}

main()
  .then(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });
