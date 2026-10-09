(function () {
  /**
   * 缩略图卡片的统一交互（资源预览 / 标注管理 / 临时截图三处共用）：
   *
   *   单击 / Space   = 选中（无副作用；不再有 500ms 延迟提交）
   *   双击 / Enter   = 主操作（资源预览 = 插入引用；标注管理 = 打开标注编辑器）
   *   E              = 编辑（标注）
   *   Ctrl/Cmd + C   = 复制引用
   *   Delete         = 删除（宿主会弹确认）
   *   方向键 / Home / End = 在网格里移动选中
   *
   * 卡片是 role=option、tabindex 轮转（只有选中项 tabindex=0），网格是 role=listbox。
   */
  function visibleCards(grid) {
    return [...grid.querySelectorAll('.card')].filter((card) => card.style.display !== 'none');
  }

  function columnsOf(cards) {
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let columns = 0;
    for (const card of cards) {
      if (card.offsetTop !== top) break;
      columns++;
    }
    return Math.max(1, columns);
  }

  function select(card, focus) {
    const grid = card.parentElement;
    if (grid) {
      for (const other of grid.querySelectorAll('.card')) {
        if (other === card) continue;
        other.classList.remove('is-selected');
        other.setAttribute('aria-selected', 'false');
        other.tabIndex = -1;
      }
    }
    card.classList.add('is-selected');
    card.setAttribute('aria-selected', 'true');
    card.tabIndex = 0;
    if (focus) card.focus();
  }

  window.ThumbnailActions = {
    button(icon, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      // icon 是 codicon 名（如 'add' / 'trash'）；OkIcons 由 media/shared/icons.js 提供
      if (window.OkIcons && /^[a-z][a-z0-9-]*$/.test(icon)) window.OkIcons.iconOnly(button, icon, label);
      else button.textContent = icon;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
      button.addEventListener('dblclick', (event) => event.stopPropagation());
      return button;
    },

    /** 网格容器：listbox 语义 + 无障碍名称 */
    bindGrid(grid, label) {
      grid.setAttribute('role', 'listbox');
      if (label) grid.setAttribute('aria-label', label);
    },

    /**
     * handlers: { label, onPrimary, onEdit?, onCopy?, onDelete?, onSelect? }
     */
    bindCard(card, handlers) {
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', 'false');
      if (handlers.label) card.setAttribute('aria-label', handlers.label);
      // tab 轮转：先全部 -1，渲染/过滤后由 refreshTabStop 选出唯一入口
      card.tabIndex = -1;

      card.addEventListener('click', (event) => {
        if (event.button !== 0) return;
        select(card, true);
        handlers.onSelect?.();
      });
      card.addEventListener('dblclick', () => {
        select(card, false);
        handlers.onPrimary?.();
      });
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return;
        const key = event.key;
        if (key === 'Enter') {
          event.preventDefault();
          select(card, false);
          handlers.onPrimary?.();
        } else if (key === ' ') {
          event.preventDefault();
          select(card, false);
          handlers.onSelect?.();
        } else if ((key === 'e' || key === 'E') && !event.ctrlKey && !event.metaKey && !event.altKey && handlers.onEdit) {
          event.preventDefault();
          handlers.onEdit();
        } else if ((key === 'c' || key === 'C') && (event.ctrlKey || event.metaKey) && handlers.onCopy) {
          event.preventDefault();
          handlers.onCopy();
        } else if ((key === 'Delete' || (key === 'Backspace' && event.metaKey)) && handlers.onDelete) {
          event.preventDefault();
          handlers.onDelete();
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
          const parent = card.parentElement;
          if (!parent) return;
          const cards = visibleCards(parent);
          const index = cards.indexOf(card);
          if (index < 0) return;
          const columns = columnsOf(cards);
          const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[key];
          let next = index;
          if (key === 'Home') next = 0;
          else if (key === 'End') next = cards.length - 1;
          else next = Math.min(cards.length - 1, Math.max(0, index + delta));
          event.preventDefault();
          if (next !== index || key === 'Home' || key === 'End') {
            select(cards[next], true);
            cards[next].scrollIntoView?.({ block: 'nearest' });
          }
        }
      });
    },

    /** 渲染或过滤后调用：保证网格里恰好一张可见卡片能被 Tab 进入（优先选中项） */
    refreshTabStop(grid) {
      const cards = visibleCards(grid);
      const selected = cards.find((card) => card.classList.contains('is-selected'));
      const entry = selected || cards[0];
      for (const card of grid.querySelectorAll('.card')) card.tabIndex = card === entry ? 0 : -1;
    },

    select,
  };
})();
