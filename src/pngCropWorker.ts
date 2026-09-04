/**
 * pngCropWorker.ts — 独立 worker 线程，用纯 JS 处理图像裁剪与缩放。
 *
 * 每条任务 = 一张原图 + N 个 bbox：
 *   { id, imagePath, bboxes: [{ bbox, targetHeight }], thumbDir }
 *
 * 同一原图只 decode 一次，逐 bbox crop+resize+encode，返回：
 *   { id, results: [{ bbox, dataUrl, filePath }], error? }
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

interface PngMeta {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function parsePng(buf: Buffer): { meta: PngMeta; idat: Buffer } {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a png');
  }
  let meta: PngMeta | null = null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      meta = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!meta) throw new Error('missing IHDR');
  return { meta, idat: Buffer.concat(idat) };
}

function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0: return 1;
    case 2: return 3;
    case 3: return 1;
    case 4: return 2;
    case 6: return 4;
    default: throw new Error(`unsupported colorType ${colorType}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  const { meta, idat } = parsePng(buf);
  if (meta.bitDepth !== 8) throw new Error(`unsupported bitDepth ${meta.bitDepth}`);
  const { width, height, colorType } = meta;
  const bpp = bytesPerPixel(colorType);
  const raw = zlib.inflateSync(idat);
  const stride = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unsupported filter ${filter}`);
      }
      recon[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[di] = recon[si]; rgba[di + 1] = recon[si + 1];
        rgba[di + 2] = recon[si + 2]; rgba[di + 3] = recon[si + 3];
      } else if (colorType === 2) {
        rgba[di] = recon[si]; rgba[di + 1] = recon[si + 1];
        rgba[di + 2] = recon[si + 2]; rgba[di + 3] = 255;
      } else if (colorType === 0) {
        rgba[di] = recon[si]; rgba[di + 1] = recon[si];
        rgba[di + 2] = recon[si]; rgba[di + 3] = 255;
      } else if (colorType === 4) {
        rgba[di] = recon[si]; rgba[di + 1] = recon[si];
        rgba[di + 2] = recon[si]; rgba[di + 3] = recon[si + 1];
      } else {
        throw new Error('palette not supported');
      }
    }
    prev = recon;
  }
  return { width, height, rgba };
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function cropAndEncodeSync(
  rgba: Buffer,
  width: number,
  height: number,
  bbox: [number, number, number, number],
  targetHeight: number,
): string {
  const [bx, by, bw, bh] = bbox;
  const cx = Math.max(0, Math.min(bx, width));
  const cy = Math.max(0, Math.min(by, height));
  const cw = Math.max(1, Math.min(bw, width - cx));
  const ch = Math.max(1, Math.min(bh, height - cy));
  const cropped = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcStart = ((cy + y) * width + cx) * 4;
    rgba.copy(cropped, y * cw * 4, srcStart, srcStart + cw * 4);
  }
  const scale = targetHeight / ch;
  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));
  const pixels = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(ch - 1, Math.floor(y / scale));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(cw - 1, Math.floor(x / scale));
      cropped.copy(pixels, (y * outW + x) * 4, (sy * cw + sx) * 4, (sy * cw + sx) * 4 + 4);
    }
  }
  return `data:image/png;base64,${encodePng(outW, outH, pixels).toString('base64')}`;
}

/* ==================== 缩略图文件名 ==================== */

function thumbFileName(imagePath: string, bbox: [number, number, number, number], targetHeight: number): string {
  const key = `${imagePath}|${bbox.join(',')}|${targetHeight}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `t_${hash}.png`;
}

/* ==================== 消息处理 ==================== */

interface CropTask {
  id: number;
  imagePath: string;
  bboxes: Array<{
    bbox: [number, number, number, number];
    targetHeight: number;
  }>;
  thumbDir: string;
}

parentPort?.on('message', async (task: CropTask) => {
  const taskT0 = performance.now();
  try {
    // 读取原图文件（fs 在 worker 中也是同步的，但文件读取通常 <5ms）
    const buf = fs.readFileSync(task.imagePath);
    const readMs = performance.now() - taskT0;

    const decoded = decodeRgba(buf);
    const imgW = decoded.width;
    const imgH = decoded.height;
    if (imgW === 0 || imgH === 0) {
      parentPort?.postMessage({ id: task.id, results: [], error: 'invalid image' });
      return;
    }
    console.warn(`[pngCrop-worker] read ${path.basename(task.imagePath)} ${imgW}×${imgH} ${buf.length}B, ${readMs.toFixed(0)}ms`);

    const results: Array<{
      bbox: [number, number, number, number];
      dataUrl: string;
      filePath: string;
    }> = [];

    for (const item of task.bboxes) {
      const [bx, by, bw, bh] = item.bbox;
      // clamp 到图片边界
      const left = Math.max(0, Math.min(bx, imgW));
      const top = Math.max(0, Math.min(by, imgH));
      const extractW = Math.max(1, Math.min(bw, imgW - left));
      const extractH = Math.max(1, Math.min(bh, imgH - top));

      const dataUrl = cropAndEncodeSync(decoded.rgba, imgW, imgH, [left, top, extractW, extractH], item.targetHeight);
      const pngData = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

      // 写入缩略图文件
      const fileName = thumbFileName(task.imagePath, item.bbox, item.targetHeight);
      const filePath = path.join(task.thumbDir, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, pngData);

      results.push({ bbox: item.bbox, dataUrl, filePath });
    }

    console.warn(`[pngCrop-worker] done ${path.basename(task.imagePath)} ×${task.bboxes.length} crop(s) in ${(performance.now() - taskT0).toFixed(0)}ms`);
    parentPort?.postMessage({ id: task.id, results });
  } catch (err) {
    console.warn(`[pngCrop-worker] error ${path.basename(task.imagePath)}: ${err}`);
    parentPort?.postMessage({ id: task.id, results: [], error: String(err) });
  }
});
