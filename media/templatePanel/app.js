  const I18N = JSON.parse(document.getElementById('templatePanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const cards = new Map(); // name -> card element
  let metas = [];
  let loadedCount = 0;
  let failedCount = 0;
  document.documentElement.lang = navigator.language || 'en';
  document.title = t('templatesTitle');
  search.placeholder = t('templatesSearch');
  document.querySelector('.hint').textContent = t('templatesHint');

  function updateCount() {
    const base = t('templatesCount', { shown: shownCount(), total: metas.length });
    const stat = (loadedCount || failedCount)
      ? ' · ' + (failedCount
        ? t('thumbnailStatsWithFailures', { loaded: loadedCount, failed: failedCount })
        : t('thumbnailStats', { loaded: loadedCount }))
      : '';
    countEl.textContent = base + stat;
  }

  function shownCount() {
    let n = 0;
    for (const card of cards.values()) if (card.style.display !== 'none') n++;
    return n;
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
      ThumbnailActions.button('＋', t('insertExpression'), () => vscode.postMessage({ type: 'insert', text: meta.name })),
      ThumbnailActions.button('⧉', t('copyExpression'), () => vscode.postMessage({ type: 'copy', text: meta.name })),
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
    nm.title = meta.name;
    const sz = document.createElement('div');
    sz.className = 'size';
    sz.textContent = meta.width + '×' + meta.height;
    m.appendChild(nm);
    m.appendChild(sz);

    card.appendChild(box);
    card.appendChild(m);

    ThumbnailActions.bindClicks(card,
      () => vscode.postMessage({ type: 'insert', text: meta.name }),
      () => vscode.postMessage({ type: 'copy', text: meta.name }),
    );
    return card;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [name, card] of cards) {
      const ok = !q || name.toLowerCase().includes(q);
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    updateCount();
    emptyEl.style.display = 'none';
    emptyEl.textContent = '';
    if (metas.length === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('noTemplatesWithHint');
    } else if (shown === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('noTemplateMatch', { query: search.value.trim() });
    }
  }

  search.addEventListener('input', applyFilter);

  /** 给卡片挂上缩略图；成功/失败都会更新计数 */
  function attachThumb(name, url) {
    const card = cards.get(name);
    if (!card || card.dataset.thumbDone === '1') return;
    card.dataset.thumbDone = '1';
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    // 用内联样式隐藏（内联优先级高于样式表，onload 时才能可靠切回显示）
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
      // 把失败的 URI 记到卡片 tooltip，便于诊断（如 localResourceRoots 未放行）
      card.title += '\n[' + t('thumbnailLoadFailed') + '] ' + url;
      updateCount();
    });
    card.querySelector('.thumb-box').appendChild(img);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'templates': {
        grid.innerHTML = '';
        cards.clear();
        metas = msg.templates || [];
        loadedCount = 0;
        failedCount = 0;
        for (const meta of metas) {
          const card = makeCard(meta);
          cards.set(meta.name, card);
          grid.appendChild(card);
        }
        applyFilter();
        break;
      }
      case 'thumbs': {
        for (const it of (msg.items || [])) attachThumb(it.name, it.url);
        break;
      }
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
