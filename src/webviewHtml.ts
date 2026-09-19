import * as crypto from 'crypto';

/**
 * Webview HTML 组装的公共约定。
 *
 * 这个文件收拢了两条**看起来像样板、其实是安全边界**的规则。它们原先各自散在
 * 5 个 panel 文件里逐份复制，于是既出现了实现漂移（nonce 长度 24/32 混用），
 * 也出现了漏改（有的地方把错误消息直接拼进 HTML）。
 */

/** CSP nonce 的长度（字符数）。历史上有 24 与 32 两种，统一取 32。 */
const NONCE_LENGTH = 32;

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成 CSP nonce。
 *
 * 用 `crypto.randomBytes` 而不是 `Math.random()`：nonce 是 CSP 信任的**唯一凭据**，
 * 谁能预测它，谁就能注入脚本。`Math.random()` 是可预测的 PRNG（V8 下状态可被反推），
 * 对安全用途不成立。这里还做了取模偏置消除 —— 62 不整除 256，直接用
 * `byte % 62` 会让前 8 个字符出现概率偏高；用拒绝采样把每个字符拉回等概率。
 */
export function getNonce(): string {
  const chars: string[] = [];
  while (chars.length < NONCE_LENGTH) {
    // 多取一些，被拒绝的字节不会让循环跑太多次
    for (const byte of crypto.randomBytes(NONCE_LENGTH)) {
      // 256 - (256 % 62) = 248；>= 248 的字节会引入偏置，直接丢弃重采
      if (byte < 248) {
        chars.push(NONCE_ALPHABET.charAt(byte % NONCE_ALPHABET.length));
        if (chars.length === NONCE_LENGTH) break;
      }
    }
  }
  return chars.join('');
}

/**
 * 把一段文本转义成可安全嵌入 HTML 文本节点/属性值的形式。
 *
 * 用在**所有**把动态内容拼进 HTML 字符串的地方，尤其是错误消息 ——
 * 错误消息里常带文件路径，而路径可以合法包含 `<`、`>`、`&`、`"`。
 * 不转义时，一个名为 `a<script>.json` 的项目就能在错误页里执行脚本
 * （虽然 webview 有 CSP，但这是纵深防御的第一层，不能指望下一层兜住）。
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成"读不到视图文件"时的兜底错误页。
 *
 * 抽出来是因为这个 HTML 骨架在多个 panel 里被复制过，而**每一份都忘了转义**。
 * 放在这里，转义不可能再被漏掉。
 */
export function errorPage(title: string, message: string): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + `<title>${escapeHtml(title)}</title></head>`
    + '<body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px">'
    + escapeHtml(message)
    + '</body></html>';
}
