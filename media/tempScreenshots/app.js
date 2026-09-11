(function () {
  const I18N = JSON.parse(document.getElementById('tempPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();

  const stage = document.getElementById('stage');
  const stageInner = document.getElementById('stageInner');
  const overlay = document.getElementById('stageOverlay');
  const selBox = document.getElementById('selBox');
  const stageEmpty = document.getElementById('stageEmpty');
  const grid = document.getElementById('grid');
  const emptyHint = document.getElementById('emptyHint');
  const countEl = document.getElementById('count');
  const coordInfo = document.getElementById('coordInfo');
  const toastEl = document.getElementById('toast');
  const carouselBtn = document.getElementById('carouselBtn');
  const coordBtn = document.getElementById('coordBtn');
  const confirmBar = document.getElementById('confirmBar');
  const confirmText = document.getElementById('confirmText');
  const confirmOk = document.getElementById('confirmOk');
  const confirmCancel = document.getElementById('confirmCancel');

  /* ---------- 本地化静态文案 ---------- */
  document.getElementById('pasteBtn').textContent = t('tempPaste');
  document.getElementById('pasteBtn').title = t('tempPasteTooltip');
  document.getElementById('captureBtn').textContent = t('tempCapture');
  document.getElementById('captureBtn').title = t('tempCaptureTooltip');
  document.getElementById('clearBtn').textContent = t('tempClear');
  carouselBtn.textContent = t('tempCarousel');
  carouselBtn.title = t('tempCarouselTooltip');
  coordBtn.textContent = t('tempCoordMode');
  coordBtn.title = t('tempCoordTooltip');
  stageEmpty.textContent = t('tempEmpty');
  confirmCancel.textContent = t('cancel');
  confirmOk.textContent = t('tempClear');

  /** webview 中 window.confirm 行为不稳定，使用内联确认条。 */
  function askConfirm(text, okLabel, onOk) {
    confirmText.textContent = text;
    confirmOk.textContent = okLabel;
    confirmBar.classList.add('visible');
    confirmOk.onclick = () => {
      confirmBar.classList.remove('visible');
      onOk();
    };
    confirmCancel.onclick = () => confirmBar.classList.remove('visible');
  }

  /* ---------- 常量 ---------- */
  const CAROUSEL_INTERVAL_MS = 100;   // 需求：0.1s 轮播
  const COORD_DECIMALS = 4;           // 归一化坐标小数位
  const MIN_BOX_PX = 3;
  const MAX_ZOOM = 20;

  /* ---------- 状态 ---------- */
  let temps = [];        // [{ id, name, url, thumbUrl, width, height }]
  let frames = [];       // HTMLImageElement[]，与 temps 同序
  let cards = new Map();
  let maxCount = 10;
  let activeId = '';
  let activeIndex = -1;

  let carouselOn = false;
  let carouselTimer = null;
  let carouselIndex = 0;

  let coordMode = false;

  let innerW = 0, innerH = 0;
  let zoom = 1, panX = 0, panY = 0;

  let panning = false, panStart = null, panStartPan = null;
  let boxDragging = false, boxStart = null, boxCurrent = null;

  let toastTimer = null;

  /* ---------- 小工具 ---------- */
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function toast(text, isError) {
    if (!text) return;
    toastEl.textContent = text;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2400);
  }

  function formatCoords(x1, y1, x2, y2) {
    return [x1, y1, x2, y2].map((v) => v.toFixed(COORD_DECIMALS)).join(',');
  }

  function activeFrame() {
    return activeIndex >= 0 && activeIndex < frames.length ? frames[activeIndex] : null;
  }

  /* ---------- 舞台布局 ---------- */
  function applyTransform() {
    stageInner.style.transform =
      'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  }

  function clampPan() {
    const st = stage.getBoundingClientRect();
    if (!st.width || !st.height || !innerW || !innerH) return;
    const sw = innerW * zoom, sh = innerH * zoom;
    if (sw <= st.width) panX = (st.width - sw) / 2;
    else panX = Math.min(0, Math.max(st.width - sw, panX));
    if (sh <= st.height) panY = (st.height - sh) / 2;
    else panY = Math.min(0, Math.max(st.height - sh, panY));
  }

  /** 重新计算适配尺寸；reset 为真时重置缩放与平移。 */
  function relayout(reset) {
    const st = stage.getBoundingClientRect();
    if (!st.width || !st.height) return;

    let nw = 0, nh = 0;
    const meta = temps[0];
    if (meta && meta.width > 0 && meta.height > 0) {
      nw = meta.width; nh = meta.height;
    } else {
      const f = frames.find((x) => x.naturalWidth > 0);
      if (f) { nw = f.naturalWidth; nh = f.naturalHeight; }
    }
    if (!nw || !nh) {
      innerW = 0; innerH = 0;
      stageInner.style.width = '0px';
      stageInner.style.height = '0px';
      return;
    }

    const s = Math.min(st.width / nw, st.height / nh);
    const newW = nw * s, newH = nh * s;
    const basePanX = (st.width - newW) / 2;
    const basePanY = (st.height - newH) / 2;

    if (reset || innerW === 0) {
      zoom = 1; panX = basePanX; panY = basePanY;
    } else {
      // 保留用户相对于居中位置的偏移
      const offX = panX - (st.width - innerW) / 2;
      const offY = panY - (st.height - innerH) / 2;
      panX = basePanX + offX;
      panY = basePanY + offY;
    }

    innerW = newW; innerH = newH;
    stageInner.style.width = innerW + 'px';
    stageInner.style.height = innerH + 'px';
    clampPan();
    applyTransform();
  }

  /**
   * 当前帧在屏幕上的实际绘制区域。
   * 帧使用 object-fit: contain，因此需要按自然尺寸换算 letterbox 后的内容矩形。
   */
  function contentRect() {
    const f = activeFrame();
    if (!f || !f.naturalWidth || !f.naturalHeight) return null;
    const inner = stageInner.getBoundingClientRect();
    if (inner.width <= 0 || inner.height <= 0) return null;
    const s = Math.min(inner.width / f.naturalWidth, inner.height / f.naturalHeight);
    const cw = f.naturalWidth * s, ch = f.naturalHeight * s;
    return {
      left: inner.left + (inner.width - cw) / 2,
      top: inner.top + (inner.height - ch) / 2,
      width: cw,
      height: ch,
    };
  }

  /** 把屏幕矩形换算为归一化坐标（clamp 到内容区内），过小返回 null。 */
  function normalizeScreenRect(r, cr) {
    if (!cr) return null;
    const l = Math.max(cr.left, Math.min(r.left, cr.left + cr.width));
    const tt = Math.max(cr.top, Math.min(r.top, cr.top + cr.height));
    const rr = Math.max(cr.left, Math.min(r.right, cr.left + cr.width));
    const bb = Math.max(cr.top, Math.min(r.bottom, cr.top + cr.height));
    if (rr - l < MIN_BOX_PX || bb - tt < MIN_BOX_PX) return null;
    return {
      x1: clamp01((l - cr.left) / cr.width),
      y1: clamp01((tt - cr.top) / cr.height),
      x2: clamp01((rr - cr.left) / cr.width),
      y2: clamp01((bb - cr.top) / cr.height),
    };
  }

  /* ---------- 帧渲染 ---------- */
  function rebuildFrames() {
    stageInner.innerHTML = '';
    frames = temps.map((meta) => {
      const img = document.createElement('img');
      img.decoding = 'async';
      img.alt = meta.name;
      img.src = meta.url;
      img.addEventListener('load', () => {
        if (innerW === 0) relayout(true);
        updateStageEmpty();
      });
      stageInner.appendChild(img);
      return img;
    });
    activeIndex = -1;
    relayout(true);
  }

  function showFrame(index) {
    if (!frames.length) { activeIndex = -1; activeId = ''; updateStageEmpty(); return; }
    const i = ((index % frames.length) + frames.length) % frames.length;
    frames.forEach((f, k) => f.classList.toggle('active', k === i));
    activeIndex = i;
    activeId = temps[i] ? temps[i].id : '';
    highlightCard(activeId);
    updateStageEmpty();
  }

  function highlightCard(id) {
    for (const [cardId, card] of cards) card.classList.toggle('active', cardId === id);
  }

  function updateStageEmpty() {
    const has = temps.length > 0 && !!activeFrame();
    stageEmpty.style.display = has ? 'none' : 'flex';
  }

  /* ---------- 轮播 ---------- */
  function startCarousel() {
    if (!temps.length) { toast(t('tempEmpty')); return; }
    if (carouselOn) return;
    carouselOn = true;
    carouselIndex = activeIndex >= 0 ? activeIndex : 0;
    carouselBtn.classList.add('active');
    carouselTimer = setInterval(() => {
      if (!frames.length) return;
      carouselIndex = (carouselIndex + 1) % frames.length;
      showFrame(carouselIndex);
    }, CAROUSEL_INTERVAL_MS);
  }

  function stopCarousel() {
    if (carouselTimer) { clearInterval(carouselTimer); carouselTimer = null; }
    carouselOn = false;
    carouselBtn.classList.remove('active');
  }

  /* ---------- 网格 ---------- */
  function renderGrid() {
    grid.innerHTML = '';
    cards = new Map();

    temps.forEach((meta, index) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.draggable = true;
      card.dataset.id = meta.id;
      card.title = meta.name + (meta.width ? '\n' + meta.width + '×' + meta.height : '') + '\n' + t('tempDragHint');

      const img = document.createElement('img');
      img.src = meta.thumbUrl || meta.url;
      img.alt = meta.name;
      card.appendChild(img);

      const actions = document.createElement('div');
      actions.className = 'actions';

      const sendBtn = document.createElement('button');
      sendBtn.textContent = '→';
      sendBtn.title = t('tempSendToAssets');
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'sendToAssets', id: meta.id });
      });

      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.title = t('tempDelete');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteTemp', id: meta.id });
      });

      actions.appendChild(sendBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = meta.name;
      card.appendChild(name);

      card.addEventListener('click', () => {
        stopCarousel();
        showFrame(index);
      });
      card.addEventListener('dragstart', (e) => onCardDragStart(e, meta, card));
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        vscode.postMessage({ type: 'dragEnd' });
      });

      grid.appendChild(card);
      cards.set(meta.id, card);
    });

    updateCount();
    updateEmpty();
  }

  function updateCount() {
    countEl.textContent = temps.length + '/' + maxCount;
  }

  function updateEmpty() {
    const empty = temps.length === 0;
    emptyHint.style.display = empty ? 'flex' : 'none';
    grid.style.display = empty ? 'none' : 'grid';
    if (empty) emptyHint.textContent = t('tempEmpty');
  }

  function onCardDragStart(e, meta, card) {
    card.classList.add('dragging');
    // 首选通道：自定义 MIME（同源 webview 可直接读取）
    try {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-ok-temp-screenshot', JSON.stringify({ id: meta.id }));
      e.dataTransfer.setData('text/plain', meta.name);
    } catch { /* 跨源时可能被拒，走宿主中继 */ }
    // 回退通道：通知宿主记录待放置的临时截图
    vscode.postMessage({ type: 'dragStart', id: meta.id });
  }

  /* ---------- 鼠标交互：平移 / 框选 ---------- */
  overlay.addEventListener('mousedown', (e) => {
    if (!activeFrame()) return;

    // 中键始终为平移；非坐标模式下左键也是平移
    if (e.button === 1 || (e.button === 0 && !coordMode)) {
      e.preventDefault();
      panning = true;
      panStart = { x: e.clientX, y: e.clientY };
      panStartPan = { x: panX, y: panY };
      overlay.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0 && coordMode) {
      e.preventDefault();
      boxDragging = true;
      boxStart = { x: e.clientX, y: e.clientY };
      boxCurrent = { x: e.clientX, y: e.clientY };
      // 轮播与框选相互独立：轮播持续播放，框选对着运动中的画面进行，
      // 便于比对带有移动界限的目标并反复微调。
      drawBox();
    }
  });

  overlay.addEventListener('wheel', (e) => {
    if (!activeFrame()) return;
    e.preventDefault();
    const st = stage.getBoundingClientRect();
    const px = e.clientX - st.left, py = e.clientY - st.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextZoom = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
    if (nextZoom === zoom) return;
    const ux = (px - panX) / zoom;
    const uy = (py - panY) / zoom;
    zoom = nextZoom;
    panX = px - ux * zoom;
    panY = py - uy * zoom;
    clampPan();
    applyTransform();
  }, { passive: false });

  overlay.addEventListener('contextmenu', (e) => {
    if (!activeFrame()) return;
    e.preventDefault();
    zoom = 1;
    relayout(true);
  });

  window.addEventListener('mousemove', (e) => {
    if (panning && panStart && panStartPan) {
      panX = panStartPan.x + (e.clientX - panStart.x);
      panY = panStartPan.y + (e.clientY - panStart.y);
      clampPan();
      applyTransform();
      return;
    }
    if (boxDragging) {
      boxCurrent = { x: e.clientX, y: e.clientY };
      drawBox();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (panning) {
      panning = false; panStart = null; panStartPan = null;
      overlay.style.cursor = '';
      return;
    }
    if (boxDragging && e.button === 0) {
      boxDragging = false;
      finishBox();
    }
  });

  function screenRect() {
    const a = boxStart, b = boxCurrent;
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    };
  }

  function drawBox() {
    const r = screenRect();
    const o = overlay.getBoundingClientRect();
    selBox.style.left = (r.left - o.left) + 'px';
    selBox.style.top = (r.top - o.top) + 'px';
    selBox.style.width = (r.right - r.left) + 'px';
    selBox.style.height = (r.bottom - r.top) + 'px';
    selBox.classList.add('visible');

    const norm = normalizeScreenRect(r, contentRect());
    coordInfo.textContent = norm ? formatCoords(norm.x1, norm.y1, norm.x2, norm.y2) : '';
  }

  function finishBox() {
    const r = screenRect();
    boxStart = null;
    boxCurrent = null;

    const norm = normalizeScreenRect(r, contentRect());
    if (norm) {
      // 保留选框：轮播继续播放，选框留在原位便于持续对照运动中的目标微调
      selBox.classList.add('visible');
      const text = formatCoords(norm.x1, norm.y1, norm.x2, norm.y2);
      coordInfo.textContent = text;
      vscode.postMessage({ type: 'copyText', text });
      toast(t('tempCoordCopied', { text }));
    } else {
      selBox.classList.remove('visible');
      coordInfo.textContent = '';
    }
  }

  /* ---------- 工具栏 ---------- */
  document.getElementById('pasteBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'pasteClipboard' });
  });
  document.getElementById('captureBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'capture' });
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (!temps.length) return;
    askConfirm(t('tempClearConfirm'), t('tempClear'), () => {
      stopCarousel();
      vscode.postMessage({ type: 'clearAll' });
    });
  });
  carouselBtn.addEventListener('click', () => {
    if (carouselOn) stopCarousel();
    else startCarousel();
  });
  coordBtn.addEventListener('click', () => {
    coordMode = !coordMode;
    coordBtn.classList.toggle('active', coordMode);
    overlay.style.cursor = coordMode ? 'crosshair' : 'grab';
    if (!coordMode) { selBox.classList.remove('visible'); coordInfo.textContent = ''; }
  });
  overlay.style.cursor = 'grab';

  /* ---------- 粘贴截图（Ctrl+V） ---------- */
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type || item.type.indexOf('image/') !== 0) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      readImageFile(file);
      return;
    }
  });

  function readImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      vscode.postMessage({ type: 'pastePng', data: String(reader.result || '') });
    };
    reader.readAsDataURL(file);
  }

  /* ---------- 拖入图片文件 ---------- */
  document.addEventListener('dragover', (e) => {
    // 只接管来自操作系统的文件拖入，避免影响卡片自身拖出到标注管理
    const types = e.dataTransfer && e.dataTransfer.types;
    if (types && Array.prototype.indexOf.call(types, 'Files') !== -1) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    for (const file of files) {
      if (file.type && file.type.indexOf('image/') === 0) readImageFile(file);
    }
  });

  /* ---------- 宿主消息 ---------- */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'temps') {
      const prevId = activeId;
      temps = msg.items || [];
      maxCount = msg.max || maxCount;

      // 列表变化后适配尺寸会重算，旧的屏幕选框不再对应，清掉避免误读
      selBox.classList.remove('visible');
      coordInfo.textContent = '';

      rebuildFrames();
      renderGrid();

      if (!temps.length) {
        stopCarousel();
        showFrame(-1);
      } else if (carouselOn) {
        carouselIndex = carouselIndex % temps.length;
        showFrame(carouselIndex);
      } else {
        let idx = temps.findIndex((m) => m.id === prevId);
        if (idx < 0) idx = temps.length - 1;
        showFrame(idx);
      }
      return;
    }
    if (msg.type === 'notice') {
      toast(msg.text, msg.level === 'error');
    }
  });

  /* ---------- 初始化 ---------- */
  window.addEventListener('resize', () => relayout(false));
  if (typeof ResizeObserver !== 'undefined') {
    // 侧边栏宽度变化时同步重算适配尺寸
    new ResizeObserver(() => relayout(false)).observe(stage);
  }
  relayout(true);
  vscode.postMessage({ type: 'ready' });
})();
