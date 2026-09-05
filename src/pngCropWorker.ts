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
import { decode as jpegDecode } from 'jpeg-js';

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

function decodePngRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
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

/** 解码 JPEG 为 RGBA8 像素（jpeg-js 纯 JS 实现，有损解码） */
function decodeJpegRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  const img = jpegDecode(buf, { useTArray: true });
  const data = img.data as Uint8Array;
  return {
    width: img.width,
    height: img.height,
    rgba: Buffer.from(data.buffer, data.byteOffset, data.length),
  };
}

/** 解码 BMP 为 RGBA8 像素（支持 24/32bpp BI_RGB 与 BI_BITFIELDS） */
function decodeBmpRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not a bmp');
  const pixelOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) throw new Error(`unsupported bmp header size ${headerSize}`);
  const width = buf.readInt32LE(18);
  const heightRaw = buf.readInt32LE(22);
  const height = Math.abs(heightRaw);
  const bottomUp = heightRaw > 0;
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (width <= 0 || height <= 0) throw new Error('invalid bmp dimensions');
  if (compression !== 0 && compression !== 3) throw new Error(`unsupported bmp compression ${compression}`);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bmp bpp ${bpp}`);
  // BITMAPV4HEADER（108 字节）起才有显式 alpha 掩码；BI_RGB 32bpp 第 4 字节视作不透明
  const alphaMask = bpp === 32 && compression === 3 && headerSize >= 108 ? buf.readUInt32LE(66) >>> 0 : 0;
  const maskShift = (mask: number) => {
    let m = mask;
    let s = 0;
    while (m > 0 && (m & 1) === 0) { m >>>= 1; s++; }
    return s;
  };
  const alphaShift = alphaMask ? maskShift(alphaMask) : 24;
  const rowBytes = (bpp * width + 7) >> 3;
  const rowSize = (rowBytes + 3) & ~3; // 每行按 4 字节对齐
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + (bottomUp ? height - 1 - y : y) * rowSize;
    if (srcRow + rowBytes > buf.length) throw new Error('truncated bmp');
    let src = srcRow;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++, src += bpp / 8, dst += 4) {
      rgba[dst] = buf[src + 2];     // BGR 内存序 → RGBA
      rgba[dst + 1] = buf[src + 1];
      rgba[dst + 2] = buf[src];
      rgba[dst + 3] = bpp === 24 ? 255 : alphaMask ? (buf.readUInt32LE(src) & alphaMask) >>> alphaShift : 255;
    }
  }
  return { width, height, rgba };
}

/** 按魔数分发解码：PNG / JPEG / BMP 统一输出 RGBA8 */
function decodeImage(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return decodePngRgba(buf);
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return decodeJpegRgba(buf);
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return decodeBmpRgba(buf);
  throw new Error('unsupported image format');
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
  try {
    // 读取原图文件（fs 在 worker 中也是同步的，但文件读取通常 <5ms）
    const buf = fs.readFileSync(task.imagePath);

    const decoded = decodeImage(buf);
    const imgW = decoded.width;
    const imgH = decoded.height;
    if (imgW === 0 || imgH === 0) {
      parentPort?.postMessage({ id: task.id, results: [], error: 'invalid image' });
      return;
    }

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

    parentPort?.postMessage({ id: task.id, results });
  } catch (err) {
    // 错误经回包传给主线程记录（主线程输出通道），worker 内不再走 console
    parentPort?.postMessage({ id: task.id, results: [], error: String(err) });
  }
});
