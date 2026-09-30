/** Shared pixel geometry for COCO annotations. */
/** 非整数输入按四舍五入收进像素格（编辑器画布本来就只产生整数）。 */
export function roundPixelBbox(bbox: readonly number[]): [number, number, number, number] {
  return [Math.round(bbox[0]), Math.round(bbox[1]), Math.round(bbox[2]), Math.round(bbox[3])];
}

/**
 * Authoring 的 bbox 校验。`size` 缺失时退回"只查正性"（图片尺寸未知不能造出假边界），
 * 尺寸可用时必须完整落在 `0,0,width,height` 之内。返回 `undefined` 表示合法。
 */
export function pixelBboxError(
  bbox: readonly number[],
  size?: { width: number; height: number },
): 'rect' | undefined {
  if (bbox.length !== 4 || !bbox.every((item) => Number.isFinite(item))) return 'rect';
  const [x, y, w, h] = roundPixelBbox(bbox);
  if (x < 0 || y < 0 || w < 1 || h < 1) return 'rect';
  if (size && size.width > 0 && size.height > 0) {
    if (x + w > size.width || y + h > size.height) return 'rect';
  }
  return undefined;
}
