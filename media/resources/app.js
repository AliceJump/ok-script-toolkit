(function () {
  const vscode = acquireVsCodeApi();
  const I18N = JSON.parse(document.getElementById('resourcesI18n')?.textContent || '{}');
  const t = (k, a = {}) => (I18N[k] || k).replace(/\{(\w+)\}/g, (_, n) => String(a[n] ?? '{' + n + '}'));

  const state = {
    mode: 'draft',
    kind: 'template',
    inbox: [],
    items: [],
    thumbs: {},
    statuses: {},
    unpublished: 0,
    query: '',
  };

  const els = {
    inboxTitle: document.getElementById('inboxTitle'),
    inboxMeta: document.getElementById('inboxMeta'),
    inboxStrip: document.getElementById('inboxStrip'),
    inboxEmpty: document.getElementById('inboxEmpty'),
    tabDraft: document.getElementById('tabDraft'),
    tabPublished: document.getElementById('tabPublished'),
    libMeta: document.getElementById('libMeta'),
    search: document.getElementById('search'),
    hint: document.getElementById('hint'),
    grid: document.getElementById('grid'),
    libEmpty: document.getElementById('libEmpty'),
    unpubText: document.getElementById('unpubText'),
    publishBtn: document.getElementById('publishBtn'),
    kindTemplate: document.getElementById('kindTemplate'),
    kindRect: document.getElementById('kindRect'),
    kindPoint: document.getElementById('kindPoint'),
  };

  els.inboxTitle.textContent = t('inboxTitle');
  els.tabDraft.textContent = t('modeDraft');
  els.tabPublished.textContent = t('modePublished');
  els.kindTemplate.textContent = t('kindTemplate');
  els.kindRect.textContent = t('kindRect');
  els.kindPoint.textContent = t('kindPoint');
  els.search.placeholder = t('resourcesSearch');
  els.publishBtn.textContent = t('publishEllipsis');
  els.hint.textContent = t('resourcesHint');
  els.inboxEmpty.textContent = t('inboxEmpty');

  function setSeg(container, attr, value) {
    container.querySelectorAll('.seg__btn').forEach((b) => {
      b.classList.toggle('is-active', b.getAttribute(attr) === value);
    });
  }

  function renderInbox() {
    els.inboxMeta.textContent = t('inboxCount', { n: state.inbox.length, max: 10 });
    els.inboxStrip.replaceChildren();
    els.inboxEmpty.hidden = state.inbox.length > 0;
    for (const shot of state.inbox) {
      const card = document.createElement('div');
      card.className = 'res-inbox__card';
      card.role = 'option';
      card.tabIndex = 0;
      card.dataset.id = shot.id;
      const img = document.createElement('img');
      img.alt = '';
      img.src = shot.url || '';
      const cap = document.createElement('span');
      cap.textContent = shot.name || shot.id;
      card.append(img, cap);
      card.addEventListener('dblclick', () => vscode.postMessage({ type: 'annotateInbox', id: shot.id }));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'e' || e.key === 'E') {
          e.preventDefault();
          vscode.postMessage({ type: 'annotateInbox', id: shot.id });
        }
        if (e.key === 'Delete') vscode.postMessage({ type: 'deleteInbox', id: shot.id });
      });
      els.inboxStrip.appendChild(card);
    }
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.items.filter((it) => {
      if (state.kind !== 'template' && it.kind && it.kind !== state.kind) return false;
      if (!q) return true;
      return (it.name || '').toLowerCase().includes(q) || (it.expression || '').toLowerCase().includes(q);
    });
  }

  function renderGrid() {
    const items = filtered();
    els.libMeta.textContent = t('libCount', { n: items.length });
    els.grid.replaceChildren();
    els.libEmpty.hidden = items.length > 0;
    if (!items.length) {
      els.libEmpty.hidden = false;
      els.libEmpty.textContent = state.mode === 'draft' ? t('draftEmpty') : t('publishedEmpty');
    }
    ThumbnailActions.bindGrid(els.grid, t('resourcesTitle'));
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'res-card';
      card.dataset.name = it.name;
      const dot = document.createElement('span');
      const st = state.statuses[it.name] || (state.mode === 'published' ? 'published' : 'draft-only');
      dot.className = 'res-dot is-' + st;
      dot.title = st;
      const thumb = document.createElement('div');
      thumb.className = 'res-card__thumb';
      const url = state.thumbs[it.name];
      if (url) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;
        thumb.appendChild(img);
      }
      const meta = document.createElement('div');
      meta.className = 'res-card__meta';
      const name = document.createElement('div');
      name.className = 'res-card__name';
      name.textContent = it.name;
      const sub = document.createElement('div');
      sub.className = 'res-card__sub';
      sub.textContent = it.expression || `${it.width || '?'}×${it.height || '?'}`;
      meta.append(name, sub);
      card.append(dot, thumb, meta);
      ThumbnailActions.bindCard(card, {
        primary: () => vscode.postMessage({
          type: state.mode === 'draft' ? 'openAnnotation' : 'insert',
          name: it.name,
          expression: it.expression,
          imagePath: it.imagePath,
        }),
        edit: () => vscode.postMessage({ type: 'openAnnotation', name: it.name, imagePath: it.imagePath }),
        copy: () => vscode.postMessage({ type: 'copy', expression: it.expression || it.name }),
      });
      els.grid.appendChild(card);
    }
    ThumbnailActions.refreshTabStop(els.grid);
    els.unpubText.textContent = state.unpublished
      ? t('unpublishedCount', { n: state.unpublished })
      : t('allPublished');
  }

  document.getElementById('modeTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.mode = btn.getAttribute('data-mode');
    setSeg(document.getElementById('modeTabs'), 'data-mode', state.mode);
    vscode.postMessage({ type: 'setMode', mode: state.mode });
  });
  document.getElementById('kindTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kind]');
    if (!btn) return;
    state.kind = btn.getAttribute('data-kind');
    setSeg(document.getElementById('kindTabs'), 'data-kind', state.kind);
    renderGrid();
  });
  els.search.addEventListener('input', () => { state.query = els.search.value; renderGrid(); });
  els.publishBtn.addEventListener('click', () => vscode.postMessage({ type: 'publish' }));

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'inbox') {
      state.inbox = msg.items || [];
      renderInbox();
    }
    if (msg.type === 'library') {
      state.mode = msg.mode || state.mode;
      state.items = msg.items || [];
      state.statuses = msg.statuses || {};
      state.unpublished = msg.unpublished || 0;
      setSeg(document.getElementById('modeTabs'), 'data-mode', state.mode);
      renderGrid();
    }
    if (msg.type === 'thumbs') {
      for (const it of (msg.items || [])) state.thumbs[it.name] = it.url;
      renderGrid();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
