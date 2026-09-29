/**
 * 只读图片头的尺寸解析（PNG IHDR / JPEG SOF 扫描 / BMP DIB 头）。
 *
 * 独立成模块的原因：`boxResourceStore` 要在纯 Node 单测里被 require，而
 * `pngCrop` 还挂着 worker 池与 `featureData` 的导入链，一路会牵进
 * `projectConfig` → `vscode`，在 CI 的普通 node 进程里直接 `Cannot find module 'vscode'`。
 * 本模块只依赖 fs/path 级别的 Buffer 解析，谁都能安全引用。
 */

/** 只读图片头拿宽高，不解码像素；失败返回 undefined */
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
