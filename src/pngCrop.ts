import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { Worker } from 'worker_threads';
import { decode as jpegDecode } from 'jpeg-js';
import { findOkTemplateCocoEntry } from './featureData';

/** 模板缩略图统一高度（面板/缓存/worker 共用，消除 key 不匹配） */
export const THUMB_HEIGHT = 96;

/* ========================================================================
 *  性能日志
 * ======================================================================== */

let _log: ((msg: string) => void) | undefined;

/** 由 extension.ts 在激活时注入 */
export function setCropLogger(log: (msg: string) => void): void { _log = log; }

function log(msg: string): void { _log?.(`[pngCrop] ${msg}`); }
function logT(tag: string, t0: number): void { log(`${tag} ${(performance.now() - t0).toFixed(1)}ms`); }

/** 极简 PNG 解码/裁剪/编码：从原图按 bbox 裁出模板小图，返回 data URL。 */

interface PngMeta {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
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

/** 每像素字节数（仅 8-bit 及常见格式） */
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

/** 解码 PNG 为 RGBA8 像素 — 纯 JS 回退路径 */
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
export function decodeRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return decodePngRgba(buf);
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return decodeJpegRgba(buf);
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return decodeBmpRgba(buf);
  throw new Error('unsupported image format');
}

/** 只读图片头拿宽高（PNG IHDR / JPEG SOF 扫描 / BMP DIB 头），不解码像素 */
export function readImageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // 逐 marker 扫描到第一个 SOF；SOF 一定出现在 SOS 之前，不会进入熵编码数据
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; // 无长度的独立 marker
        continue;
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (offset + 9 > buf.length) return undefined;
        const width = buf.readUInt16BE(offset + 7);
        const height = buf.readUInt16BE(offset + 5);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      offset += 2 + segLen;
    }
    return undefined;
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const width = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22));
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

/** 把 RGBA 像素编码为 PNG Buffer — 纯 JS 回退 */
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

/**
 * 高效 RGB PNG 编码器（供 saveToAssets bin-packing 使用，非热路径）。
 */
export function encodePngRgb(width: number, height: number, rgba: Buffer): Buffer {
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

/** 纯 JS 回退：从 RGBA 按 bbox 裁剪并缩放为 PNG data URL */
function cropAndEncodeSync(
  width: number, height: number, rgba: Buffer,
  bbox: [number, number, number, number], targetHeight: number,
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

/* ========================================================================
 *  Worker 线程池 — 纯 JS 处理，主线程零阻塞
 * ======================================================================== */

interface CropTask {
  id: number;
  imagePath: string;
  bboxes: Array<{ bbox: [number, number, number, number]; targetHeight: number }>;
  thumbDir: string;
  /** 原图内容 hash：与主线程共用，保证 worker 落盘文件名与主线程查找的文件名一致 */
  contentHash?: string;
}

/** worker 回包（单任务与批量共用：单任务 results 只有一个元素） */
interface WorkerReply {
  id: number;
  results: Array<{ bbox: number[]; dataUrl: string; filePath: string }>;
  error?: string;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  /** 已派发给该 worker、尚未回包的任务 id */
  inflight: Set<number>;
}

let poolWorkers: WorkerState[] = [];
let cropTaskQueue: CropTask[] = [];
/** 等待 worker 回包的任务：id -> resolve。worker 崩溃/退出/池销毁时统一置失败，避免调用方永久悬挂 */
const pendingReplies = new Map<number, (reply: WorkerReply) => void>();
let poolMax = 2;
let poolInitialized = false;
let poolExtPath = '';
let nextTaskId = 1;

function resolveReply(id: number, reply: WorkerReply): void {
  const resolve = pendingReplies.get(id);
  pendingReplies.delete(id);
  resolve?.(reply);
}

/** 初始化 worker 池（扩展激活时调用一次） */
export function initCropWorkerPool(extensionPath: string, maxWorkers = 2): void {
  if (poolInitialized) return;
  poolInitialized = true;
  poolExtPath = extensionPath;
  poolMax = maxWorkers;
}

function ensurePool(): void {
  if (!poolInitialized) return;
  while (poolWorkers.length < poolMax) {
    const worker = new Worker(path.join(poolExtPath, 'out', 'pngCropWorker.js'));
    const state: WorkerState = { worker, busy: false, inflight: new Set() };
    worker.on('message', (msg: WorkerReply) => {
      state.busy = false;
      state.inflight.delete(msg.id);
      if (msg.error) {
        log(`worker task #${msg.id} failed: ${msg.error}`);
      }
      resolveReply(msg.id, msg);
      drainQueue();
    });
    const fail = (error: string) => {
      // worker 崩溃/退出：把派发给它的任务统一置为失败，并从池中移除（drainQueue 会重建）
      const idx = poolWorkers.indexOf(state);
      if (idx >= 0) poolWorkers.splice(idx, 1);
      for (const id of state.inflight) resolveReply(id, { id, results: [], error });
      state.inflight.clear();
      state.busy = false;
    };
    worker.on('error', (err) => fail(String(err)));
    worker.on('exit', () => fail('worker exited'));
    poolWorkers.push(state);
  }
}

function postTask(state: WorkerState, task: CropTask): void {
  try {
    state.worker.postMessage({
      id: task.id,
      imagePath: task.imagePath,
      bboxes: task.bboxes,
      thumbDir: task.thumbDir,
      contentHash: task.contentHash,
    });
    state.busy = true;
    state.inflight.add(task.id);
  } catch (err) {
    // post 失败（如 worker 已退出）：任务立即失败，不悬挂
    resolveReply(task.id, { id: task.id, results: [], error: String(err) });
  }
}

function drainQueue(): void {
  if (!poolInitialized) return;
  ensurePool();
  for (const state of poolWorkers) {
    if (state.busy || cropTaskQueue.length === 0) continue;
    postTask(state, cropTaskQueue.shift()!);
  }
}

/** 提交单个裁剪任务到 worker */
function submitToWorker(
  imagePath: string, bbox: [number, number, number, number],
  targetHeight: number, thumbDir: string, contentHash?: string,
): Promise<{ dataUrl: string; filePath: string } | undefined> {
  return new Promise((resolve) => {
    const id = nextTaskId++;
    pendingReplies.set(id, (reply) => {
      if (reply.error || !reply.results?.length) {
        resolve(undefined);
      } else {
        resolve({ dataUrl: reply.results[0].dataUrl, filePath: reply.results[0].filePath });
      }
    });
    cropTaskQueue.push({ id, imagePath, bboxes: [{ bbox, targetHeight }], thumbDir, contentHash });
    drainQueue();
  });
}

/**
 * 批量提交同一原图的多个 bbox 到 worker（同一图只 decode 一次）。
 * 用 worker 的单条批量消息，避免多次 IPC。
 */
function submitBatchToWorker(
  imagePath: string,
  bboxes: Array<{ bbox: [number, number, number, number]; targetHeight: number }>,
  thumbDir: string,
  contentHash?: string,
): Promise<Array<{ bbox: [number, number, number, number]; dataUrl: string; filePath: string }>> {
  return new Promise((resolve) => {
    if (bboxes.length === 0) { resolve([]); return; }

    const batchId = nextTaskId++;
    ensurePool();

    pendingReplies.set(batchId, (reply) => {
      const results: Array<{ bbox: [number, number, number, number]; dataUrl: string; filePath: string }> = [];
      if (!reply.error) {
        for (const r of reply.results) {
          results.push({
            bbox: r.bbox as [number, number, number, number],
            dataUrl: r.dataUrl, filePath: r.filePath,
          });
        }
      }
      resolve(results);
      drainQueue();
    });

    const task: CropTask = {
      id: batchId, imagePath,
      bboxes: bboxes.map((b) => ({ bbox: b.bbox, targetHeight: b.targetHeight })),
      thumbDir, contentHash,
    };
    const freeWorker = poolWorkers.find((w) => !w.busy);
    if (freeWorker) {
      postTask(freeWorker, task);
    } else {
      // 所有 worker 忙：排队让 drainQueue 调度
      cropTaskQueue.unshift(task);
      drainQueue();
    }
  });
}

/** 销毁 worker 池：先失败所有等待中的任务，再终止线程 */
export function disposeCropWorkerPool(): void {
  for (const id of [...pendingReplies.keys()]) {
    resolveReply(id, { id, results: [], error: 'worker pool disposed' });
  }
  cropTaskQueue = [];
  for (const s of poolWorkers) {
    try { s.worker.terminate(); } catch { /* 忽略 */ }
  }
  poolWorkers = [];
  poolInitialized = false;
}

/* ========================================================================
 *  原图内容指纹 — 缓存 key 的唯一标识
 *
 *  背景：缓存 key 早先由 imagePath 参与哈希，同一路径的图片被替换后
 *  key 不变，旧缩略图被直接复用，导致面板里看到的图与点击打开的图不一致。
 *  现改为以「原图内容 sha1」为唯一标识：内容一变，key 与磁盘文件名同步变化。
 * ======================================================================== */

interface ContentHashEntry { size: number; mtimeMs: number; hash: string; }

/** path -> 内容指纹；仅当 size + mtimeMs 都未变时复用，保证内容替换一定被感知 */
const CONTENT_HASH_CACHE = new Map<string, ContentHashEntry>();
const CONTENT_HASH_CACHE_MAX = 2000;

function contentHashSet(imagePath: string, entry: ContentHashEntry): void {
  if (CONTENT_HASH_CACHE.size >= CONTENT_HASH_CACHE_MAX) {
    const oldest = CONTENT_HASH_CACHE.keys().next().value;
    if (oldest !== undefined) CONTENT_HASH_CACHE.delete(oldest);
  }
  CONTENT_HASH_CACHE.set(imagePath, entry);
}

/** 取已记录的内容指纹：不读盘、不校验 stat（删除旧缓存时要用旧值） */
export function knownImageContentHash(imagePath: string): string | undefined {
  return CONTENT_HASH_CACHE.get(imagePath)?.hash;
}

/** 丢弃指定图片的内容指纹记录，强制下次重新计算 */
export function invalidateImageContentHash(imagePath: string): void {
  CONTENT_HASH_CACHE.delete(imagePath);
}

/**
 * 原图内容 sha1（16 hex）——缩略图缓存的唯一标识。
 * stat 未变时复用上次结果，避免每次重复读盘。
 */
export function imageContentHash(imagePath: string): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(imagePath);
  } catch {
    CONTENT_HASH_CACHE.delete(imagePath);
    return undefined;
  }
  const prev = CONTENT_HASH_CACHE.get(imagePath);
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.hash;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(imagePath);
  } catch {
    CONTENT_HASH_CACHE.delete(imagePath);
    return undefined;
  }
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  contentHashSet(imagePath, { size: st.size, mtimeMs: st.mtimeMs, hash });
  return hash;
}

/** 缓存标识：优先用传入/已缓存的内容 hash；算不出（文件不可读）时退回路径，保证 key 仍可用 */
function contentToken(imagePath: string, contentHash?: string): string {
  return contentHash ?? imageContentHash(imagePath) ?? `p:${imagePath}`;
}

/* ========================================================================
 *  缓存 — 内存 data URL 缓存 + 磁盘缩略图文件
 * ======================================================================== */

interface CropEntry {
  url: string;
  /** 反查用：key 里只放内容 hash，按图/按来源清理要靠它 */
  imagePath: string;
  source: string;
}

const CROP_CACHE = new Map<string, CropEntry>();
const CROP_CACHE_MAX = 600;

function cropKey(
  imagePath: string, bbox: [number, number, number, number],
  targetHeight: number, contentHash?: string,
): string {
  return `${contentToken(imagePath, contentHash)}|${bbox.join(',')}|${targetHeight}`;
}

/** 写入裁剪缓存；满时淘汰最早插入的条目（Map 保序），避免整表清空导致预热成果全部丢失 */
function cacheSet(key: string, entry: CropEntry): void {
  if (CROP_CACHE.size >= CROP_CACHE_MAX) {
    const oldest = CROP_CACHE.keys().next().value;
    if (oldest !== undefined) CROP_CACHE.delete(oldest);
  }
  CROP_CACHE.set(key, entry);
}

/** 模板标注/图片变化时清空裁剪缓存。 */
export function clearCropCache(): void {
  CROP_CACHE.clear();
}

/** 仅清空指定来源的内存裁剪缓存。 */
export function clearSourceCropCache(source: string): void {
  for (const [key, entry] of CROP_CACHE) {
    if (entry.source === source) {
      CROP_CACHE.delete(key);
    }
  }
}

/** 仅清空引用指定原图的内存裁剪缓存条目（精确到单张 PNG）。 */
export function clearCropCacheForImage(imagePath: string): void {
  for (const [key, entry] of CROP_CACHE) {
    if (entry.imagePath === imagePath) {
      CROP_CACHE.delete(key);
    }
  }
}

/**
 * 从 imagePath 判断来源子目录。
 * ok_tasks/assets/images/X.png → 'ok_tasks'
 * assets/images/X.png → 'assets'
 */
export function thumbSourceSubdir(imagePath: string): string {
  if (imagePath.includes('ok_tasks')) return 'ok_tasks';
  if (imagePath.includes('ok_templates')) return 'ok_templates';
  return 'assets';
}

/** 根据 basePath + 来源子目录，返回实际缩略图目录 */
export function thumbDirForSource(basePath: string, imagePath: string): string {
  return path.join(basePath, thumbSourceSubdir(imagePath));
}

/**
 * 选择性删除某个来源的全部缩略图（磁盘）。
 * 只扫描 basePath 下的子目录，不影响其他来源。
 */
export function clearSourceThumbs(basePath: string, source: string): void {
  const dir = path.join(basePath, source);
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  log(`clearSourceThumbs: ${source}/ cleared`);
}

/* ---------------- 缩略图文件路径 ---------------- */

/** 缩略图文件名前缀：t2 = 内容 hash 版本（旧版 t_ 基于路径，见 purgeLegacyThumbFiles） */
const THUMB_PREFIX = 't2';

/**
 * 缩略图文件名 = hash(内容 hash + bbox + 目标高度)。
 * 不含 imagePath：同一份内容的不同路径复用同一份缩略图；
 * 内容变化 → 内容 hash 变化 → 文件名变化 → 旧图不会被复用。
 */
function thumbFileName(contentHash: string, bbox: [number, number, number, number], targetHeight: number): string {
  const key = `${contentHash}|${bbox.join(',')}|${targetHeight}`;
  return `${THUMB_PREFIX}_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.png`;
}

/**
 * 返回模板缩略图的确定性绝对路径（自动路由到来源子目录）。
 * 原图不可读（无法计算内容 hash）时返回空串——调用方的 existsSync 会自然判为未命中。
 */
export function templateThumbFilePath(
  imagePath: string, bbox: [number, number, number, number],
  outDir: string, targetHeight = THUMB_HEIGHT, contentHash?: string,
): string {
  const hash = contentHash ?? imageContentHash(imagePath);
  if (!hash) return '';
  const srcDir = thumbDirForSource(outDir, imagePath);
  return path.join(srcDir, thumbFileName(hash, bbox, targetHeight));
}

/** 旧格式缩略图文件名：t_/a_ + 16 位 hex（基于路径命名，内容变化不感知） */
const LEGACY_THUMB_RE = /^[ta]_[0-9a-f]{16}\.png$/i;

/**
 * 清理旧格式（基于路径命名）的缩略图文件，避免切换为内容 hash 后残留垃圾。
 * 只删严格匹配旧命名的文件，新格式（t2_/a2_）与目录结构不受影响。
 */
export function purgeLegacyThumbFiles(outDir: string): void {
  let removed = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!LEGACY_THUMB_RE.test(e.name)) continue;
      try { fs.rmSync(full, { force: true }); removed++; } catch { /* 忽略 */ }
    }
  };
  try {
    if (!fs.existsSync(outDir)) return;
  } catch { return; }
  walk(outDir);
  if (removed > 0) log(`purgeLegacyThumbFiles: removed ${removed} legacy thumbs in ${outDir}`);
}

/* ========================================================================
 *  warmCropCache — 用 worker 批量裁剪，主线程完全不阻塞
 * ======================================================================== */

export interface CropRequest {
  imagePath: string;
  bbox: [number, number, number, number];
  targetHeight?: number;
  thumbDir?: string;  // 缩略图落盘目录，确保 worker 写入正确位置
}

/**
 * 后台预热：按原图分组提交 worker（同一 4K 原图只解码一次）。
 * worker 用纯 JS 处理，主线程只做 IPC 通信，完全不阻塞。
 */
export async function warmCropCache(requests: CropRequest[]): Promise<void> {
  const t0 = performance.now();
  const groups = new Map<string, CropRequest[]>();
  for (const r of requests) {
    const arr = groups.get(r.imagePath);
    if (arr) arr.push(r);
    else groups.set(r.imagePath, [r]);
  }
  log(`warmCropCache: ${requests.length} requests, ${groups.size} images, pool=${poolInitialized}`);

  if (!poolInitialized) {
    // 纯 JS 回退：分批让出事件循环
    for (const [imagePath, items] of groups) {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        // 每张图只算一次内容 hash，后续 bbox 复用，避免重复 stat / 读盘
        const hash = imageContentHash(imagePath);
        const buf = fs.readFileSync(imagePath);
        const { width, height, rgba } = decodeRgba(buf);
        for (const it of items) {
          const th = it.targetHeight ?? THUMB_HEIGHT;
          const key = cropKey(it.imagePath, it.bbox, th, hash);
          if (CROP_CACHE.has(key)) continue;
          cacheSet(key, {
            url: cropAndEncodeSync(width, height, rgba, it.bbox, th),
            imagePath: it.imagePath,
            source: thumbSourceSubdir(it.imagePath),
          });
        }
      } catch { /* 忽略 */ }
    }
    return;
  }

  // Worker 路径：按图片分组批量提交
  let workerHits = 0; let workerMisses = 0; let workerErrors = 0;
  for (const [imagePath, items] of groups) {
    const targetHeight = items[0]?.targetHeight ?? THUMB_HEIGHT;
    const hash = imageContentHash(imagePath);
    const missing = items.filter((it) => !CROP_CACHE.has(cropKey(it.imagePath, it.bbox, it.targetHeight ?? targetHeight, hash)));
    if (missing.length === 0) { workerHits += items.length; continue; }
    workerMisses += missing.length;

    await new Promise((resolve) => setImmediate(resolve));

    // 每张图使用自己的 thumbDir（按来源子目录隔离）
    const thumbDir = items[0]?.thumbDir ?? requests[0]?.thumbDir;
    if (!thumbDir) { log(`warmCropCache: no thumbDir for ${path.basename(imagePath)}, skip`); continue; }
    const imgT0 = performance.now();
    const results = await submitBatchToWorker(
      imagePath,
      missing.map((it) => ({ bbox: it.bbox, targetHeight: it.targetHeight ?? targetHeight })),
      thumbDir,
      hash,
    );
    if (results.length === 0) workerErrors += missing.length;
    log(`  worker batch: ${path.basename(imagePath)} ×${missing.length} → ${results.length} ok, ${(performance.now() - imgT0).toFixed(0)}ms`);

    for (const r of results) {
      const key = cropKey(imagePath, r.bbox, targetHeight, hash);
      if (!CROP_CACHE.has(key)) {
        cacheSet(key, {
          url: r.dataUrl,
          imagePath,
          source: thumbSourceSubdir(imagePath),
        });
      }
    }
  }
  logT(`warmCropCache done [hit=${workerHits} miss=${workerMisses} err=${workerErrors}]`, t0);
}

/* ========================================================================
 *  同步 API — 供 providers.ts hover/completion 使用
 * ======================================================================== */

/**
 * 带缓存的裁剪（同步）：先查内存缓存，miss 则纯 JS 回退。
 * warmCropCache 完成后均命中缓存，不阻塞主线程。
 */
export function cropTemplateToDataUrlCached(
  imagePath: string, bbox: [number, number, number, number], targetHeight = THUMB_HEIGHT,
): string | undefined {
  const key = cropKey(imagePath, bbox, targetHeight);
  const hit = CROP_CACHE.get(key);
  if (hit !== undefined) { log(`sync hit: ${path.basename(imagePath)}`); return hit.url; }
  const t0 = performance.now();
  let url: string | undefined;
  try {
    const buf = fs.readFileSync(imagePath);
    const { width, height, rgba } = decodeRgba(buf);
    url = cropAndEncodeSync(width, height, rgba, bbox, targetHeight);
  } catch {
    return undefined;
  }
  if (url !== undefined) {
    cacheSet(key, { url, imagePath, source: thumbSourceSubdir(imagePath) });
    logT(`sync fallback (miss→JS decode): ${path.basename(imagePath)}`, t0);
    return url;
  }
  return undefined;
}

/* ========================================================================
 *  异步缩略图文件 — 供面板使用，主线程不阻塞
 * ======================================================================== */

/**
 * 异步裁剪缩略图文件：文件缓存 → 内存缓存 → worker 裁剪。
 */
export async function cropTemplateThumbFileAsync(
  imagePath: string, bbox: [number, number, number, number],
  outDir: string, targetHeight = THUMB_HEIGHT,
): Promise<string | undefined> {
  // 内容 hash 决定缓存文件名：图片被替换后 hash 变化 → 自然落到新文件，不会复用旧缩略图
  const contentHash = imageContentHash(imagePath);
  if (!contentHash) return undefined;
  // 按来源自动路由到子目录（srcDir 供 worker 使用）
  const srcDir = thumbDirForSource(outDir, imagePath);
  // 注意：outDir 而非 srcDir —— templateThumbFilePath 内部会再调一次 thumbDirForSource
  const file = templateThumbFilePath(imagePath, bbox, outDir, targetHeight, contentHash);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  } catch { /* 重写 */ }

  // 内存缓存命中：写入磁盘后返回
  const cached = cropTemplateToDataUrlCached(imagePath, bbox, targetHeight);
  if (cached) {
    log(`thumb async: ${path.basename(imagePath)} from memcache → write disk`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(cached.slice(cached.indexOf(',') + 1), 'base64'));
      return file;
    } catch { return undefined; }
  }

  // 无 worker 池：同步纯 JS 回退（仅在 worker 未初始化时）
  if (!poolInitialized) {
    log(`thumb async: ${path.basename(imagePath)} NO WORKER → sync JS fallback`);
    try {
      const buf = fs.readFileSync(imagePath);
      const { width, height, rgba } = decodeRgba(buf);
      const url = cropAndEncodeSync(width, height, rgba, bbox, targetHeight);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      return file;
    } catch { return undefined; }
  }

  // 有 worker：提交异步任务（主线程不阻塞）
  const t0 = performance.now();
  const result = await submitToWorker(imagePath, bbox, targetHeight, srcDir, contentHash);
  if (result) {
    logT(`thumb async: ${path.basename(imagePath)} via worker`, t0);
    const key = cropKey(imagePath, bbox, targetHeight, contentHash);
    if (!CROP_CACHE.has(key)) {
      cacheSet(key, { url: result.dataUrl, imagePath, source: thumbSourceSubdir(imagePath) });
    }
    return result.filePath;
  }
  return undefined;
}

/**
 * 删除一个确定性模板缩略图。
 * 优先用已记录的内容 hash（文件被替换时指向的是旧缩略图），
 * 没有记录才现算——这样「图片改动后清理旧缓存」才删得对。
 */
export function removeTemplateThumbFile(
  imagePath: string, bbox: [number, number, number, number],
  outDir: string, targetHeight = THUMB_HEIGHT,
): void {
  const hash = knownImageContentHash(imagePath) ?? imageContentHash(imagePath);
  const file = templateThumbFilePath(imagePath, bbox, outDir, targetHeight, hash);
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
}

/** 清空缩略图目录内容（含所有子目录）。 */
export function clearThumbDir(outDir: string): void {
  try {
    if (!fs.existsSync(outDir)) return;
    for (const f of fs.readdirSync(outDir)) {
      try { fs.rmSync(path.join(outDir, f), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

/* ========================================================================
 *  原始分辨率裁剪落盘（供 saveToAssets 使用，非热路径）
 * ======================================================================== */

export function cropTemplateOriginalFile(
  imagePath: string, bbox: [number, number, number, number],
  outDir: string, fileName: string,
): string | undefined {
  try {
    const buf = fs.readFileSync(imagePath);
    const { width, height, rgba } = decodeRgba(buf);
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
    const png = encodePng(cw, ch, cropped);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, fileName);
    fs.writeFileSync(outPath, png);
    return outPath;
  } catch { return undefined; }
}

/* ========================================================================
 *  原图标注查看（非热路径）
 * ======================================================================== */

function strokeRectInward(
  rgba: Buffer, imgW: number, imgH: number,
  x: number, y: number, w: number, h: number, thickness: number,
  r: number, g: number, b: number,
): void {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(imgW - 1, x + w - 1), y1 = Math.min(imgH - 1, y + h - 1);
  if (x1 < x0 || y1 < y0) return;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      if (px < x0 + thickness || px > x1 - thickness || py < y0 + thickness || py > y1 - thickness) {
        const i = (py * imgW + px) * 4;
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    }
  }
}

function drawRectOutline(
  rgba: Buffer, imgW: number, imgH: number,
  x: number, y: number, w: number, h: number, thickness: number,
): void {
  const halo = Math.max(2, thickness >> 1);
  strokeRectInward(rgba, imgW, imgH, x - halo, y - halo, w + 2 * halo, h + 2 * halo, thickness + halo, 255, 255, 255);
  strokeRectInward(rgba, imgW, imgH, x, y, w, h, thickness, 255, 40, 40);
}

export function writeAnnotatedImage(
  imagePath: string, bbox: [number, number, number, number], outPath: string,
): string | undefined {
  try {
    const buf = fs.readFileSync(imagePath);
    const { width, height, rgba } = decodeRgba(buf);
    const bx = Math.max(0, Math.min(bbox[0], width - 1));
    const by = Math.max(0, Math.min(bbox[1], height - 1));
    const bw = Math.max(1, Math.min(bbox[2], width - Math.max(0, bbox[0])));
    const bh = Math.max(1, Math.min(bbox[3], height - Math.max(0, bbox[1])));
    const pad = 200;
    const cropX = Math.max(0, bx - pad), cropY = Math.max(0, by - pad);
    const cropW = Math.min(width - cropX, bw + 2 * pad + Math.min(pad, bx));
    const cropH = Math.min(height - cropY, bh + 2 * pad + Math.min(pad, by));

    // 归一化：缩放到目标分辨率内，保证不同原图输出视觉效果一致
    const TARGET = 400;
    const scale = Math.min(1, TARGET / Math.max(cropW, cropH));
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    // 缩放裁剪区域（最近邻）
    const outRgba = Buffer.alloc(outW * outH * 4);
    for (let oy = 0; oy < outH; oy++) {
      const sy = Math.min(Math.round(oy / scale), cropH - 1);
      const srcRow = ((cropY + sy) * width + cropX) * 4;
      for (let ox = 0; ox < outW; ox++) {
        const sx = Math.min(Math.round(ox / scale), cropW - 1);
        const srcIdx = srcRow + sx * 4;
        const dstIdx = (oy * outW + ox) * 4;
        outRgba[dstIdx] = rgba[srcIdx];
        outRgba[dstIdx + 1] = rgba[srcIdx + 1];
        outRgba[dstIdx + 2] = rgba[srcIdx + 2];
        outRgba[dstIdx + 3] = rgba[srcIdx + 3];
      }
    }

    const thickness = Math.max(2, Math.round(2 * scale));
    drawRectOutline(outRgba, outW, outH,
      Math.round((bx - cropX) * scale), Math.round((by - cropY) * scale),
      Math.round(bw * scale), Math.round(bh * scale), thickness);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, encodePng(outW, outH, outRgba));
    return outPath;
  } catch { return undefined; }
}

export function openAnnotatedImage(
  imagePath: string, name: string, bbox: [number, number, number, number],
  thumbDir: string, rootDir: string,
): string | undefined {
  // 按模板名从 ok_templates/coco_annotations.json 反查原图 + 标注 bbox
  const entry = findOkTemplateCocoEntry(rootDir, name);
  if (!entry) return undefined;
  const src = entry.imagePath;
  const srcBbox = entry.bbox;
  try { if (!fs.existsSync(src)) return undefined; } catch { return undefined; }
  // a2 = 内容 hash 版本：原图被替换后标注图同步重绘，不会停留在旧图
  const contentHash = imageContentHash(src);
  if (!contentHash) return undefined;
  const key = crypto.createHash('sha1').update(`v2|${contentHash}|${srcBbox.join(',')}`).digest('hex').slice(0, 16);
  const out = path.join(thumbDir, 'annotated', `a2_${key}.png`);
  try { if (fs.existsSync(out) && fs.statSync(out).size > 0) return out; } catch { /* 重新生成 */ }
  return writeAnnotatedImage(src, srcBbox, out);
}
