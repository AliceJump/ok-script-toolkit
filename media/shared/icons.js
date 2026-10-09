/**
 * Codicon 小工具：所有面板的图标统一走 VS Code codicons（media/shared/codicons），
 * 不再用 emoji / Unicode 符号（字形随字体漂移、读屏会念出符号名）。
 *
 *   OkIcons.icon('play')                 → <span class="codicon codicon-play" aria-hidden="true">
 *   OkIcons.label(btn, 'play', '启动')    → 图标 + 文字（按钮文字即可访问名称）
 *   OkIcons.iconOnly(btn, 'refresh', '刷新') → 仅图标；title + aria-label 承担名称
 */
(function () {
  function icon(name) {
    const span = document.createElement('span');
    span.className = `codicon codicon-${name}`;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  function label(element, name, text) {
    element.replaceChildren(icon(name), document.createTextNode(` ${text}`));
    element.classList.add('has-codicon');
    return element;
  }
  function iconOnly(element, name, text) {
    element.replaceChildren(icon(name));
    element.classList.add('has-codicon', 'is-icon-only');
    element.title = text;
    element.setAttribute('aria-label', text);
    return element;
  }
  window.OkIcons = { icon, label, iconOnly };
})();
