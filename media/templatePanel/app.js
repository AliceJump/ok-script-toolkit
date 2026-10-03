(function () {
  const I18N = JSON.parse(document.getElementById('templatePanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const publishBtn = document.getElementById('publishPositionsBtn');
  const cards = new Map();
  let metas = [];
  let currentMode = 'template';
  let loadedCount = 0;
  let failedCount = 0;

  document.documentElement.lang = navigator.language || 'en';
  document.title = 'Resource Preview';
  search.placeholder = t('templatesSearch');
  document.querySelector('.hint').textContent = t('templatesHint');

  function shownCount() {
    let n = 0;
    for (const card of cards.values()) if (card.style.display !== 'none') n++;
    return n;
  }

  function updateCount() {
    const base = t('templatesCount', { shown: shownCount(), total: metas.length });
    const stat = (loadedCount || failedCount)
      ? ' · ' + (failedCount
        ? t('thumbnailStatsWithFailures', { loaded: loadedCount, failed: failedCount })
        : t('thumbnailStats', { loaded: loadedCount }))
      : '';
    countEl.textContent = base + stat;
  }

  function updateModeButtons() {
    document.getElementById('templateModeBtn').classList.toggle('active', currentMode === 'template');
    document.getElementById('rectModeBtn').classList.toggle('active', currentMode === 'rect');
    document.getElementById('pointModeBtn').classList.toggle('active', currentMode === 'point');
    publishBtn.style.display = currentMode === 'template' ? 'none' : '';
  }

  function makeCard(meta) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.name = meta.name;
    card.title = meta.name + '\n' + t('templateSize', { width: meta.width, height: meta.height }) +
      '\nbbox: [' + meta.bbox.join(', ') + ']\n' + t('templateSource', { path: meta.imagePath });

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = '…';
    box.appendChild(ph);

    const actions = document.createElement('div');
    actions.className = 'actions thumbnail-actions';
    actions.append(
      ThumbnailActions.button('＋', t('insertExpression'), () => vscode.postMessage({ type: 'insert', expression: meta.expression })),
      ThumbnailActions.button('⧉', t('copyExpression'), () => vscode.postMessage({ type: 'copy', expression: meta.expression })),
      ThumbnailActions.button('👁', t('viewOriginal'), () => vscode.postMessage({
        type: 'open', imagePath: meta.imagePath, name: meta.name, bbox: JSON.stringify(meta.bbox),
      })),
    );
    box.appendChild(actions);

    const m = document.createElement('div');
    m.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = meta.name;
    nm.title = meta.expression || meta.name;
    const sz = document.createElement('div');
    sz.className = 'size';
    sz.textContent = meta.kind === 'point' ? 'point' : meta.width + '×' + meta.height;
    m.append(nm, sz);
    card.append(box, m);

    ThumbnailActions.bindClicks(
      card,
      () => vscode.postMessage({ type: 'insert', expression: meta.expression }),
      () => vscode.postMessage({ type: 'copy', expression: meta.expression }),
    );
    return card;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [name, card] of cards) {
      const meta = metas.find(item => item.name === name);
      const haystack = `${name} ${meta?.expression || ''}`.toLowerCase();
      const ok = !q || haystack.includes(q);
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    updateCount();
    emptyEl.style.display = 'none';
    emptyEl.textContent = '';
    if (metas.length === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = currentMode === 'template' ? t('noTemplatesWithHint') : 'No resources in this mode.';
    } else if (shown === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('noTemplateMatch', { query: search.value.trim() });
    }
  }

  function resetResources(resources) {
    grid.innerHTML = '';
    cards.clear();
    metas = resources || [];
    loadedCount = 0;
    failedCount = 0;
    for (const meta of metas) {
      const card = makeCard(meta);
      cards.set(meta.name, card);
      grid.appendChild(card);
    }
    applyFilter();
  }

  function attachThumb(name, url) {
    const card = cards.get(name);
    if (!card || card.dataset.thumbDone === '1') return;
    card.dataset.thumbDone = '1';
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    img.style.display = 'none';
    img.addEventListener('load', () => {
      loadedCount++;
      const ph = card.querySelector('.placeholder');
      if (ph) ph.remove();
      img.style.display = 'block';
      updateCount();
    });
    img.addEventListener('error', () => {
      failedCount++;
      const ph = card.querySelector('.placeholder');
      if (ph) { ph.textContent = t('loadFailed'); ph.style.opacity = '.8'; }
      card.title += '\n[' + t('thumbnailLoadFailed') + '] ' + url;
      updateCount();
    });
    card.querySelector('.thumb-box').appendChild(img);
  }

  function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    updateModeButtons();
    resetResources([]);
    vscode.postMessage({ type: 'switchMode', mode });
  }

  document.getElementById('templateModeBtn').onclick = () => switchMode('template');
  document.getElementById('rectModeBtn').onclick = () => switchMode('rect');
  document.getElementById('pointModeBtn').onclick = () => switchMode('point');
  publishBtn.onclick = () => vscode.postMessage({ type: 'publish' });
  search.addEventListener('input', applyFilter);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'resources':
        currentMode = msg.mode || currentMode;
        updateModeButtons();
        resetResources(msg.resources || []);
        break;
      case 'templates':
        // Compatibility with older hosts during extension reloads.
        currentMode = 'template';
        updateModeButtons();
        resetResources((msg.templates || []).map(meta => ({
          ...meta,
          kind: 'template',
          expression: meta.expression || meta.name,
        })));
        break;
      case 'thumbs':
        for (const item of (msg.items || [])) attachThumb(item.name, item.url);
        break;
      default:
        break;
    }
  });

  updateModeButtons();
  vscode.postMessage({ type: 'ready' });
})();
