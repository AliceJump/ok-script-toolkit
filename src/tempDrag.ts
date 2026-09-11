/**
 * 跨 Webview 拖拽中介。
 *
 * VS Code 的多个 Webview 运行在不同 origin 的 iframe 中，HTML5 拖拽的
 * `dataTransfer` 数据在跨 origin 时会被浏览器屏蔽（只有 dragover/drop 事件
 * 仍然会派发）。因此拖拽「临时截图 → 标注管理」时，除了在 dataTransfer 里
 * 写入自定义 MIME 作为首选通道外，还需要扩展宿主做一次中继：
 *
 *   拖拽源 dragstart  → postMessage('dragStart', {id}) → setPendingDrag(id)
 *   拖拽源 dragend    → postMessage('dragEnd')        → clearPendingDrag()
 *   放置目标 drop     → 先读 dataTransfer，读不到则 takePendingDrag()
 *
 * pending 带时间戳，避免残留状态被后续无关的 drop 误消费。
 */

const MAX_AGE_MS = 20000;

let pending: { id: string; at: number } | undefined;

export function setPendingDrag(id: string): void {
  pending = { id, at: Date.now() };
}

export function clearPendingDrag(): void {
  pending = undefined;
}

/** 取出并消费 pending 的拖拽 id（过期或不存在返回 undefined）。 */
export function takePendingDrag(): string | undefined {
  const current = pending;
  pending = undefined;
  if (!current) return undefined;
  if (Date.now() - current.at > MAX_AGE_MS) return undefined;
  return current.id;
}
