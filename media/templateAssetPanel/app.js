  const I18N = JSON.parse(document.getElementById('assetPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const cards = new Map();
  /** name -> 缩略图 webview URI。交换目标选择器直接复用已加载的缩略图，不再问宿主要一遍。 */
  const thumbUrls = new Map();
  let metas = [];

  document.title = t('templateAssetsTitle');
  search.placeholder = t('templatesSearch');
  document.getElementById('importBtn').textContent = t('assetImport');
  document.getElementById('screenshotBtn').textContent = t('screenshot');
  const hardForegroundChk = document.getElementById('hardForegroundChk');
  document.getElementById('hardForegroundLabel').textContent = t('hardForeground');
  document.getElementById('fgCheck').title = t('hardForegroundHint');
  const savedState = vscode.getState() || {};
  hardForegroundChk.checked = !!savedState.hardForeground;
  hardForegroundChk.addEventListener('change', () => {
    vscode.setState(Object.assign({}, vscode.getState() || {}, { hardForeground: hardForegroundChk.checked }));
  });
  document.getElementById('saveBtn').textContent = t('publish');

  function updateCount() {
    const shown = shownCount();
    countEl.textContent = shown + '/' + metas.length;
  }
  function shownCount() {
    let n = 0;
    for (const card of cards.values()) if (card.style.display !== 'none') n++;
    return n;
  }

  function updateCardMeta(card, meta) {
    card.title = meta.name + '\n' + meta.width + 'x' + meta.height +
      (meta.categories.length ? '\n' + meta.categories.join(', ') : '');
    const name = card.querySelector('.name');
    const cats = card.querySelector('.cats');
    const size = card.querySelector('.size');
    if (name) name.textContent = meta.name;
    if (cats) cats.textContent = meta.categories.length ? meta.categories.join(', ') : '';
    if (size) size.textContent = meta.width + 'x' + meta.height;
  }

  function makeCard(meta) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.name = meta.name;

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = '...';
    box.appendChild(ph);

    const actDiv = document.createElement('div');
    actDiv.className = 'actions thumbnail-actions';
    actDiv.append(
      ThumbnailActions.button('👁', t('openSourceImage'), () => vscode.postMessage({ type: 'openSource', imagePath: meta.imagePath })),
      ThumbnailActions.button('⇄', t('assetSwapTooltip'), () => openSwapPicker(meta)),
      ThumbnailActions.button('×', t('assetDeleteTooltip'), () => vscode.postMessage({ type: 'deleteImage', imagePath: meta.imagePath })),
    );
    ['open', 'swap', 'delete'].forEach((action, index) => { actDiv.children[index].dataset.action = action; });
    box.appendChild(actDiv);

    const m = document.createElement('div');
    m.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    const cats = document.createElement('div');
    cats.className = 'cats';
    const sz = document.createElement('div');
    sz.className = 'size';
    m.appendChild(nm);
    m.appendChild(cats);
    m.appendChild(sz);

    card.appendChild(box);
    card.appendChild(m);
    updateCardMeta(card, meta);
    card.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAnnotation', imagePath: meta.imagePath });
    });
    return card;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [name, card] of cards) {
      const meta = metas.find(m => m.name === name);
      const ok = !q || name.toLowerCase().includes(q) ||
        (meta && meta.categories.some(c => c.toLowerCase().includes(q)));
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    updateCount();
    emptyEl.style.display = 'none';
    if (metas.length === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('noTemplatesWithHint');
    } else if (shown === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('assetNoMatch') + ': "' + search.value.trim() + '"';
    }
  }

  search.addEventListener('input', () => applyFilter());

  /**
   * 一张缩略图的**唯一落地口**：写缓存 + 落到网格卡片 + 落到打开中的交换选择器。
   *
   * 三处共用同一份 `thumbUrls` ⇒ 选择器里的缩略图就是网格里那一张，不必自己再要一遍。
   * 宿主是**分批异步**推缩略图的，所以这里也必须能处理"推过来时选择器已经开着"的情形：
   * 选择器的列表只在打开那一刻渲染一次，不补的话缺的那几张会永远停在占位符上。
   */
  function applyThumb(name, url) {
    thumbUrls.set(name, url);
    const card = cards.get(name);
    if (card) {
      const box = card.querySelector('.thumb-box');
      const current = box && box.querySelector('img');
      if (current) {
        if (current.src !== url) current.src = url;
      } else {
        fillThumbBox(box, url, name, t('loadFailed'));
      }
      card.dataset.thumbDone = '1';
    }
    for (const thumb of swapList.querySelectorAll('.swap-thumb')) {
      if (thumb.dataset.name === name) {
        const current = thumb.querySelector('img');
        if (current) {
          if (current.src !== url) current.src = url;
        } else {
          fillThumbBox(thumb, url, name, '');
        }
      }
    }
  }

  /** 把占位符换成真实缩略图（幂等：已经有 img 就不再插一张）。 */
  function fillThumbBox(box, url, name, failureText) {
    if (!box || box.querySelector('img')) return;
    const ph = box.querySelector('.placeholder');
    const img = document.createElement('img');
    img.alt = name;
    img.style.display = 'none';
    img.addEventListener('load', () => {
      if (ph) ph.remove();
      img.style.display = 'block';
    });
    img.addEventListener('error', () => {
      img.remove();
      if (ph && failureText) { ph.textContent = failureText; ph.style.opacity = '.8'; }
    });
    box.prepend(img);
    img.src = url;
  }

  /* ---------- 交换标注：选择目标图片 ----------
     只负责「选哪张图」，落盘与缩放都在宿主侧（那边才知道真实尺寸与磁盘状态）。
     选中的是**当前模板集里的另一张图**，不含自己。 */
  const swapModal = document.getElementById('swapModal');
  const swapList = document.getElementById('swapList');

  function openSwapPicker(source) {
    document.getElementById('swapTitle').textContent = t('assetSwapTitle');
    document.getElementById('swapHint').textContent = t('assetSwapHint');
    document.getElementById('swapCancel').textContent = t('cancel');
    swapList.innerHTML = '';

    const others = metas.filter((m) => m.name !== source.name);
    if (!others.length) {
      const empty = document.createElement('div');
      empty.className = 'swap-empty';
      empty.textContent = t('assetSwapEmpty');
      swapList.appendChild(empty);
    } else {
      for (const other of others) swapList.appendChild(makeSwapItem(source, other));
      requestMissingThumbs(others);
    }
    swapModal.classList.add('visible');
  }

  /**
   * 让宿主**现裁现推**还没有 URL 的那几张缩略图（走的是网格同一条管线）。
   *
   * 不主动要的话，缺的那几张会一直停在占位符上：网格的缩略图是分批异步推的，
   * 用户完全可能在推完之前就打开了选择器，而列表只在打开那一刻渲染一次。
   */
  function requestMissingThumbs(items) {
    const missing = items.filter((m) => !thumbUrls.has(m.name)).map((m) => m.imagePath);
    if (missing.length) vscode.postMessage({ type: 'requestThumbs', imagePaths: missing });
  }

  function makeSwapItem(source, other) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'swap-item';
    item.title = other.name;

    const thumb = document.createElement('div');
    thumb.className = 'swap-thumb';
    thumb.dataset.name = other.name;
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = '...';
    thumb.appendChild(ph);
    const url = thumbUrls.get(other.name);
    if (url) fillThumbBox(thumb, url, other.name, '');

    const name = document.createElement('div');
    name.className = 'swap-name';
    name.textContent = other.name;
    const metaLine = document.createElement('div');
    metaLine.className = 'swap-meta';
    metaLine.textContent = other.width + 'x' + other.height + ' · ' +
      (other.annotations ? t('assetSwapBoxes', { count: other.annotations }) : t('assetSwapNoBoxes'));

    item.appendChild(thumb);
    item.appendChild(name);
    item.appendChild(metaLine);
    item.addEventListener('click', () => {
      closeSwapPicker();
      vscode.postMessage({
        type: 'swapAnnotations',
        imagePath: source.imagePath,
        targetPath: other.imagePath,
      });
    });
    return item;
  }

  function closeSwapPicker() {
    swapModal.classList.remove('visible');
    swapList.innerHTML = '';
  }

  document.getElementById('swapCancel').addEventListener('click', closeSwapPicker);
  swapModal.addEventListener('mousedown', (e) => {
    if (e.target === swapModal) closeSwapPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && swapModal.classList.contains('visible')) closeSwapPicker();
  });

  document.getElementById('importBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'importFile' });
  });
  document.getElementById('screenshotBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'screenshot', hardForeground: hardForegroundChk.checked });
  });
  document.getElementById('saveBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveToAssets' });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'templates': {
        const incoming = msg.templates || [];
        const nextNames = new Set(incoming.map(meta => meta.name));
        for (const [name, card] of [...cards]) {
          if (nextNames.has(name)) continue;
          card.remove();
          cards.delete(name);
          thumbUrls.delete(name);
        }

        const nextMetas = [];
        for (const raw of incoming) {
          const existingMeta = metas.find(meta => meta.name === raw.name);
          const meta = existingMeta || raw;
          if (existingMeta) Object.assign(existingMeta, raw);
          let card = cards.get(meta.name);
          if (!card) {
            card = makeCard(meta);
            cards.set(meta.name, card);
          } else {
            updateCardMeta(card, meta);
          }
          // appendChild moves an existing node without recreating it. This keeps the
          // decoded thumbnail and hover state alive across annotation-only refreshes.
          grid.appendChild(card);
          nextMetas.push(meta);
        }
        metas = nextMetas;
        applyFilter();
        break;
      }
      case 'thumbs': {
        for (const it of (msg.items || [])) applyThumb(it.name, it.url);
        break;
      }
    }
  });

  /* ---------- 接收「临时截图」侧边栏的拖拽 ---------- */
  const dropHint = document.getElementById('dropHint');
  if (dropHint) dropHint.textContent = t('assetDropHint');
  let dragDepth = 0;

  const SHOT_ID_RE = /^shot_\d+_\d+\.png$/;

  function readTempId(dataTransfer) {
    if (!dataTransfer) return undefined;
    try {
      const raw = dataTransfer.getData('application/x-ok-temp-screenshot');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) return String(parsed.id);
      }
    } catch (err) { /* 跨源读取被拒，继续尝试 text/plain */ }
    try {
      const text = (dataTransfer.getData('text/plain') || '').trim();
      if (SHOT_ID_RE.test(text)) return text;
    } catch (err) { /* 同样可能被拒 */ }
    return undefined;
  }

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('drop-active');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('drop-active');
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-active');
    vscode.postMessage({ type: 'dropTemp', tempId: readTempId(e.dataTransfer) });
  });

  vscode.postMessage({ type: 'ready' });
