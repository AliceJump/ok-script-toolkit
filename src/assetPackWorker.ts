/**
 * assetPackWorker.ts — 独立 worker 线程，渲染 saveToAssets 的单个打包 page。
 *
 * 任务 = 一个 page：{ id, W, H, outPath, sources: [{ imagePath, rects }] }
 * 每个来源原图在任务内只 decode 一次，贴完即释放引用（4K 解码约 33MB RGBA，
 * 同一时刻内存里只有画布 + 一张解码图），随后 level-6 deflate 全画布编码并
 * 直接在 worker 内写盘。解码/滤波/deflate 全部离开扩展宿主主线程。
 *
 * 回包：{ id, bytes, skipped, error? } —— skipped 为解码失败的来源文件名
 * （对齐主线程旧行为：单张源图失败只跳过该图，page 照常产出）。
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
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

/**
 * RGBA 像素编码为 RGB PNG（Sub 滤波 + level-6 deflate，对齐 ok-script
 * compress_coco 的压缩效果）。与 pngCrop.ts 的 encodePngRgb 保持一致。
 */
function encodePngRgb(width: number, height: number, rgba: Buffer): Buffer {
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
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ==================== 消息处理 ==================== */

export interface AssetPackSourceMsg {
  imagePath: string;
  /** 原始 bbox [x, y, w, h]（贴到画布同坐标，越界部分裁掉） */
  rects: Array<[number, number, number, number]>;
}

export interface AssetPackPageTaskMsg {
  id: number;
  W: number;
  H: number;
  /** worker 直接把 PNG 写到这里（省一次大 Buffer 回传） */
  outPath: string;
  sources: AssetPackSourceMsg[];
}

export interface AssetPackPageReply {
  id: number;
  bytes: number;
  skipped: string[];
  error?: string;
}

parentPort?.on('message', (task: AssetPackPageTaskMsg) => {
  const skipped: string[] = [];
  try {
    // 白色画布（RGBA 255,255,255,255），对齐旧行为
    const canvasRgba = Buffer.alloc(task.W * task.H * 4, 255);

    // 逐来源：解码 → 贴全部 bbox → 释放解码引用，峰值内存 ≈ 画布 + 一张解码图
    for (const src of task.sources) {
      let decoded: { width: number; height: number; rgba: Buffer };
      try {
        decoded = decodeImage(fs.readFileSync(src.imagePath));
      } catch {
        skipped.push(path.basename(src.imagePath));
        continue;
      }
      for (const [bx, by, bw, bh] of src.rects) {
        const x1 = Math.max(0, bx);
        const y1 = Math.max(0, by);
        const x2 = Math.min(task.W, bx + bw);
        const y2 = Math.min(task.H, by + bh);
        if (x2 <= x1 || y2 <= y1) continue;
        for (let y = y1; y < y2; y++) {
          const srcStart = (y * decoded.width + x1) * 4;
          const dstStart = (y * task.W + x1) * 4;
          decoded.rgba.copy(canvasRgba, dstStart, srcStart, srcStart + (x2 - x1) * 4);
        }
      }
      decoded.rgba = Buffer.alloc(0); // 贴完即释放，encode 前腾出 ~33MB
    }

    const pagePng = encodePngRgb(task.W, task.H, canvasRgba);
    fs.mkdirSync(path.dirname(task.outPath), { recursive: true });
    fs.writeFileSync(task.outPath, pagePng);

    const reply: AssetPackPageReply = { id: task.id, bytes: pagePng.length, skipped };
    parentPort?.postMessage(reply);
  } catch (err) {
    const reply: AssetPackPageReply = { id: task.id, bytes: 0, skipped, error: String(err) };
    parentPort?.postMessage(reply);
  }
});
