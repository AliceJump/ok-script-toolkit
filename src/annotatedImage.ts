import * as crypto from 'crypto';

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

export interface AnnotatedPixels { width: number; height: number; rgba: Buffer }

/** Context crop and red outline shared by synchronous viewing and the gallery worker. */
export function renderAnnotatedPixels(
  { width, height, rgba }: AnnotatedPixels, bbox: [number, number, number, number],
): AnnotatedPixels | undefined {
  if (!bbox.every(Number.isFinite) || bbox[2] <= 0 || bbox[3] <= 0) return undefined;
  const bx = Math.max(0, Math.round(bbox[0]));
  const by = Math.max(0, Math.round(bbox[1]));
  const bw = Math.min(width, Math.round(bbox[0] + bbox[2])) - bx;
  const bh = Math.min(height, Math.round(bbox[1] + bbox[3])) - by;
  if (bw <= 0 || bh <= 0) return undefined;
  const pad = 200;
  const cropX = Math.max(0, bx - pad), cropY = Math.max(0, by - pad);
  const cropW = Math.min(width, bx + bw + pad) - cropX;
  const cropH = Math.min(height, by + bh + pad) - cropY;

  // 归一化：缩放到目标分辨率内，保证不同原图输出视觉效果一致
  const TARGET = 400;
  const scale = Math.min(1, TARGET / Math.max(cropW, cropH));
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));

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
    Math.max(1, Math.round(bw * scale)), Math.max(1, Math.round(bh * scale)), thickness);
  return { width: outW, height: outH, rgba: outRgba };
}

export function annotatedFileName(contentHash: string, bbox: [number, number, number, number]): string {
  const key = crypto.createHash('sha1').update(`v3|${contentHash}|${bbox.join(',')}`).digest('hex').slice(0, 16);
  return `a2_${key}.png`;
}
