(function() {
  const I18N = JSON.parse(document.getElementById('annotationPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const emptyMsg = document.getElementById('emptyMsg');
  const POINT_RADIUS = 6;
  const MAX_UNDO = 100;
  const COORD_DECIMALS = 4;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  let imageData = null;
  let annotationMode = 'template';
  let pointMode = false;
  let boxMode = false;
  let boxPathRule = null;
  let img = null;
  let imgData = null;
  let scale = 1;
  let fitScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let annotations = [];
  let selectedIdx = -1;
  let hoveredIdx = -1;
  let nextId = 1;
  let listSignature = '';
  let toolMode = 'none';
  let drawStart = null;
  let drawPreview = null;
  let drawDragging = false;
  let clipboard = null;
  let coordBox = null;
  let coordDrag = null;
  let lastCoords = '';
  let dragging = false;
  let dragStartPos = null;
  let dragOrigRect = null;
  let resizing = false;
  let resizeHandle = null;
  let resizeStartPos = null;
  let resizeOrigRect = null;
  let panning = false;
  let panStartPos = null;
  let panStartOffset = null;
  let currentImageKey = '';
  const hiddenByFileAndMode = new Map();
  const modeCache = { template: [], rect: [], point: [] };

  const savedUi = vscode.getState() || {};
  let sharedHistory = savedUi.sharedHistory !== false;
  const history = {
    nextId: 1,
    globalUndo: [],
    globalRedo: [],
    byMode: { template: [], rect: [], point: [] },
    redoByMode: { template: [], rect: [], point: [] },
  };

  let keybindings = {
    drawBbox: 'r',
    copyCoords: 'c',
    deleteMode: 'd',
    undo: 'ctrl+z',
    redo: 'ctrl+y',
    copy: 'ctrl+c',
    paste: 'ctrl+v',
    deleteSelected: 'Delete',
    prevImage: 'ArrowLeft',
    nextImage: 'ArrowRight',
    modeTemplate: '1',
    modeRect: '2',
    modePoint: '3',
  };
  let copyCoordsSpace = true;

  function isPositionMode() { return annotationMode === 'rect' || annotationMode === 'point'; }
  function historyKey() { return annotationMode; }

  function clearHistory() {
    history.globalUndo.length = 0;
    history.globalRedo.length = 0;
    for (const mode of ['template', 'rect', 'point']) {
      history.byMode[mode].length = 0;
      history.redoByMode[mode].length = 0;
      modeCache[mode] = [];
    }
    history.nextId = 1;
  }

  function commitHistory(before) {
    const after = clone(annotations);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const tx = { id: history.nextId++, mode: historyKey(), before, after, applied: true };
    history.globalUndo.push(tx);
    history.byMode[tx.mode].push(tx);
    if (history.globalUndo.length > MAX_UNDO) history.globalUndo.shift();
    if (history.byMode[tx.mode].length > MAX_UNDO) history.byMode[tx.mode].shift();
    history.globalRedo.length = 0;
    history.redoByMode[tx.mode].length = 0;
    modeCache[tx.mode] = clone(after);
    updateUndoRedoButtons();
  }

  function popMatching(stack, predicate) {
    while (stack.length) {
      const item = stack.pop();
      if (predicate(item)) return item;
    }
    return null;
  }

  function applyHistorySnapshot(tx, snapshot) {
    modeCache[tx.mode] = clone(snapshot);
    if (tx.mode === annotationMode) {
      annotations = clone(snapshot);
      nextId = annotations.length ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
      selectedIdx = -1;
      hoveredIdx = -1;
      listSignature = '';
      paint();
    }
    vscode.postMessage({ type: 'saveMode', mode: tx.mode, annotations: clone(snapshot) });
  }

  function undo() {
    const source = sharedHistory ? history.globalUndo : history.byMode[annotationMode];
    const tx = popMatching(source, item => item.applied && (sharedHistory || item.mode === annotationMode));
    if (!tx) return;
    tx.applied = false;
    history.globalRedo.push(tx);
    history.redoByMode[tx.mode].push(tx);
    applyHistorySnapshot(tx, tx.before);
    updateUndoRedoButtons();
  }

  function redo() {
    const source = sharedHistory ? history.globalRedo : history.redoByMode[annotationMode];
    const tx = popMatching(source, item => !item.applied && (sharedHistory || item.mode === annotationMode));
    if (!tx) return;
    tx.applied = true;
    history.globalUndo.push(tx);
    history.byMode[tx.mode].push(tx);
    applyHistorySnapshot(tx, tx.after);
    updateUndoRedoButtons();
  }

  function canUndo() {
    const source = sharedHistory ? history.globalUndo : history.byMode[annotationMode];
    return source.some(item => item.applied && (sharedHistory || item.mode === annotationMode));
  }

  function canRedo() {
    const source = sharedHistory ? history.globalRedo : history.redoByMode[annotationMode];
    return source.some(item => !item.applied && (sharedHistory || item.mode === annotationMode));
  }

  function updateUndoRedoButtons() {
    document.getElementById('undoBtn').disabled = !canUndo();
    document.getElementById('redoBtn').disabled = !canRedo();
    document.getElementById('undoBtn').title = t('undo') + ' (' + keybindings.undo + ')';
    document.getElementById('redoBtn').title = t('redo') + ' (' + keybindings.redo + ')';
  }

  function parseKeybinding(kb) {
    const parts = String(kb || '').toLowerCase().split('+');
    const key = parts.pop();
    return {
      key,
      needCtrl: parts.includes('ctrl'),
      needShift: parts.includes('shift'),
      needAlt: parts.includes('alt'),
      needMeta: parts.includes('meta') || parts.includes('cmd'),
    };
  }

  function matchKeybinding(e, bindingStr) {
    if (!bindingStr) return false;
    const kb = parseKeybinding(bindingStr);
    const keyMatch = e.key.toLowerCase() === kb.key || e.code.toLowerCase() === kb.key;
    return keyMatch &&
      !!(e.ctrlKey || e.metaKey) === kb.needCtrl &&
      !!e.shiftKey === kb.needShift &&
      !!e.altKey === kb.needAlt;
  }

  function hiddenSet() {
    const key = (imageData?.filename || '') + '|' + annotationMode;
    if (!hiddenByFileAndMode.has(key)) hiddenByFileAndMode.set(key, new Set());
    return hiddenByFileAndMode.get(key);
  }

  function isShown(ann) { return !hiddenSet().has(ann.category); }

  function imgToWidget(ix, iy) { return [ix * scale + offsetX, iy * scale + offsetY]; }
  function widgetToImg(wx, wy) { return [(wx - offsetX) / scale, (wy - offsetY) / scale]; }

  function annWidgetRect(ann) {
    const [wx, wy] = imgToWidget(ann.x, ann.y);
    if (pointMode) return { x: wx - POINT_RADIUS, y: wy - POINT_RADIUS, w: POINT_RADIUS * 2, h: POINT_RADIUS * 2 };
    return { x: wx, y: wy, w: ann.w * scale, h: ann.h * scale };
  }

  function rectContains(r, px, py) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }

  function detectHandle(px, py, r) {
    if (pointMode) return null;
    const m = 8;
    const nearL = Math.abs(px - r.x) <= m && py >= r.y - m && py <= r.y + r.h + m;
    const nearR = Math.abs(px - (r.x + r.w)) <= m && py >= r.y - m && py <= r.y + r.h + m;
    const nearT = Math.abs(py - r.y) <= m && px >= r.x - m && px <= r.x + r.w + m;
    const nearB = Math.abs(py - (r.y + r.h)) <= m && px >= r.x - m && px <= r.x + r.w + m;
    if (nearT && nearL) return 'tl';
    if (nearT && nearR) return 'tr';
    if (nearB && nearL) return 'bl';
    if (nearB && nearR) return 'br';
    if (nearT) return 'top';
    if (nearB) return 'bottom';
    if (nearL) return 'left';
    if (nearR) return 'right';
    return null;
  }

  function handleCursor(h) {
    if (h === 'tl' || h === 'br') return 'nwse-resize';
    if (h === 'tr' || h === 'bl') return 'nesw-resize';
    if (h === 'top' || h === 'bottom') return 'ns-resize';
    if (h === 'left' || h === 'right') return 'ew-resize';
    return 'default';
  }

  function findAnnAt(px, py) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (!isShown(annotations[i])) continue;
      const r = annWidgetRect(annotations[i]);
      if (rectContains(r, px, py)) return i;
    }
    return -1;
  }

  function findHandleAt(px, py) {
    if (pointMode) return { idx: -1, handle: null };
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (!isShown(annotations[i])) continue;
      const h = detectHandle(px, py, annWidgetRect(annotations[i]));
      if (h) return { idx: i, handle: h };
    }
    return { idx: -1, handle: null };
  }

  function pathOccupied(value, originalPath) {
    const occupied = imageData?.positionPaths || {};
    const trimmed = String(value || '').trim();
    if (originalPath != null && trimmed === String(originalPath).trim()) return undefined;
    if (occupied[trimmed]) return { code: 'duplicate' };
    return undefined;
  }

  function pathProblem(value) {
    const raw = String(value || '').trim();
    if (!raw) return { code: 'empty' };
    const parts = raw.split('.');
    if (parts.length < 2) return { code: 'shallow', bad: raw };
    if (!boxPathRule?.segment) return { code: 'rule' };
    const segment = new RegExp(boxPathRule.segment);
    const bad = parts.find(part => !segment.test(part));
    if (bad !== undefined) return { code: 'segment', bad };
    return undefined;
  }

  function pathMessage(problem) {
    if (!problem) return '';
    if (problem.code === 'empty') return t('boxPathRequired');
    if (problem.code === 'shallow') return t('boxPathTwoSegments', { path: problem.bad || '' });
    if (problem.code === 'segment') return t('boxPathBadSegment', { segment: problem.bad || '' });
    if (problem.code === 'duplicate') return t('boxPathExists');
    if (problem.code === 'rule') return t('boxPathRuleMissing');
    return t('generateBoxFailed');
  }

  function syncAnnotationList() {
    const rows = document.getElementById('annotationRows');
    const hidden = hiddenSet();
    const sig = annotationMode + '#' + selectedIdx + '#' + annotations.map(ann => `${ann.id}\t${ann.category}\t${hidden.has(ann.category) ? 0 : 1}`).join('\n');
    document.getElementById('onlyCurrentBtn').disabled = selectedIdx < 0;
    if (sig === listSignature) return;
    listSignature = sig;
    rows.replaceChildren();
    if (!annotations.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-hint';
      empty.textContent = t('annotationListEmpty');
      rows.append(empty);
      return;
    }
    annotations.forEach((ann, index) => {
      const row = document.createElement('div');
      row.className = 'annotation-row' + (index === selectedIdx ? ' is-selected' : '');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !hidden.has(ann.category);
      check.onclick = (event) => event.stopPropagation();
      check.onchange = () => {
        if (check.checked) hidden.delete(ann.category); else hidden.add(ann.category);
        listSignature = '';
        paint();
      };
      const text = document.createElement('button');
      text.type = 'button';
      text.className = 'annotation-name';
      text.textContent = ann.category;
      text.onclick = () => { selectedIdx = index; listSignature = ''; paint(); };
      row.append(check, text);
      rows.append(row);
    });
  }

  function paintPoint(ann, index) {
    const [wx, wy] = imgToWidget(ann.x, ann.y);
    const isSel = index === selectedIdx;
    const isHov = index === hoveredIdx;
    const color = isSel ? '#0078d4' : isHov ? '#ffa500' : '#ff3c3c';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = isSel ? 2.5 : 2;
    ctx.beginPath(); ctx.arc(wx, wy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(wx - 9, wy); ctx.lineTo(wx + 9, wy); ctx.moveTo(wx, wy - 9); ctx.lineTo(wx, wy + 9); ctx.stroke();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(ann.category, wx + 8, wy - 8);
  }

  function paintRect(ann, index) {
    const r = annWidgetRect(ann);
    const isSel = index === selectedIdx;
    const isHov = index === hoveredIdx;
    const color = isSel ? '#0078d4' : isHov ? '#ffa500' : '#ff3c3c';
    ctx.strokeStyle = color;
    ctx.fillStyle = isSel ? 'rgba(0,120,212,0.15)' : isHov ? 'rgba(255,165,0,0.12)' : 'rgba(255,60,60,0.08)';
    ctx.lineWidth = isSel ? 2.5 : 2;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (isHov) {
      ctx.fillStyle = '#00c800';
      for (const [hx, hy] of [[r.x,r.y],[r.x+r.w,r.y],[r.x,r.y+r.h],[r.x+r.w,r.y+r.h]]) {
        ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = color;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(ann.category, r.x + 2, r.y - 4);
  }

  function paint() {
    if (!canvas.width || !canvas.height) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (img) ctx.drawImage(img, offsetX, offsetY, img.width * scale, img.height * scale);
    syncAnnotationList();
    annotations.forEach((ann, index) => {
      if (!isShown(ann)) return;
      if (pointMode) paintPoint(ann, index); else paintRect(ann, index);
    });
    if ((toolMode === 'draw' || toolMode === 'copycoord') && !pointMode && drawStart && drawPreview) {
      const [ix1, iy1] = widgetToImg(drawStart.x, drawStart.y);
      const [ix2, iy2] = widgetToImg(drawPreview.x, drawPreview.y);
      const px = Math.min(ix1, ix2), py = Math.min(iy1, iy2);
      const pw = Math.abs(ix2 - ix1), ph = Math.abs(iy2 - iy1);
      const [wx, wy] = imgToWidget(px, py);
      ctx.strokeStyle = toolMode === 'copycoord' ? '#e8a33d' : '#00c800';
      ctx.fillStyle = toolMode === 'copycoord' ? 'rgba(232,163,61,0.12)' : 'rgba(0,200,0,0.1)';
      ctx.setLineDash([6, 3]);
      ctx.fillRect(wx, wy, pw * scale, ph * scale);
      ctx.strokeRect(wx, wy, pw * scale, ph * scale);
      ctx.setLineDash([]);
    }
    if (toolMode === 'copycoord') paintCoordBox();
  }

  function recalcFit() {
    if (!img) { fitScale = 1; return; }
    fitScale = Math.min(canvas.width / img.width, canvas.height / img.height);
  }

  function recalcOffset() {
    if (!img) { offsetX = 0; offsetY = 0; return; }
    const sw = img.width * scale, sh = img.height * scale;
    if (sw <= canvas.width) offsetX = (canvas.width - sw) / 2;
    else offsetX = Math.min(0, Math.max(canvas.width - sw, offsetX));
    if (sh <= canvas.height) offsetY = (canvas.height - sh) / 2;
    else offsetY = Math.min(0, Math.max(canvas.height - sh, offsetY));
  }

  function isZoomed() { return img && (img.width * scale > canvas.width || img.height * scale > canvas.height); }

  function resize() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    if (img) { recalcFit(); if (scale < fitScale) scale = fitScale; recalcOffset(); }
    paint();
  }

  function saveAnnotations(mode = annotationMode, data = annotations) {
    modeCache[mode] = clone(data);
    vscode.postMessage({ type: mode === annotationMode ? 'save' : 'saveMode', mode, annotations: clone(data) });
  }

  function nudgeSelected(dx, dy) {
    const ann = annotations[selectedIdx];
    if (!ann || !isShown(ann)) return false;
    const before = clone(annotations);
    const maxX = pointMode ? img?.width ?? ann.x + dx : (img?.width ?? ann.x + ann.w) - ann.w;
    const maxY = pointMode ? img?.height ?? ann.y + dy : (img?.height ?? ann.y + ann.h) - ann.h;
    ann.x = Math.round(Math.max(0, Math.min(ann.x + dx, maxX)));
    ann.y = Math.round(Math.max(0, Math.min(ann.y + dy, maxY)));
    commitHistory(before);
    saveAnnotations();
    paint();
    return true;
  }

  function deleteSelected() {
    if (selectedIdx < 0 || !annotations[selectedIdx]) return;
    const before = clone(annotations);
    annotations.splice(selectedIdx, 1);
    selectedIdx = -1;
    hoveredIdx = -1;
    commitHistory(before);
    saveAnnotations();
    paint();
  }

  function setToolMode(next) {
    toolMode = next;
    drawStart = null;
    drawPreview = null;
    drawDragging = false;
    if (next !== 'copycoord') { coordBox = null; coordDrag = null; lastCoords = ''; }
    document.getElementById('drawBtn').classList.toggle('active', next === 'draw');
    document.getElementById('coordBtn').classList.toggle('active', next === 'copycoord');
    document.getElementById('deleteBtn').classList.toggle('active', next === 'delete');
    canvas.style.cursor = next === 'draw' || next === 'copycoord' ? 'crosshair' : next === 'delete' ? 'default' : (isZoomed() ? 'grab' : 'crosshair');
    paint();
  }

  function requestAnnotationMode(next) {
    if (next === annotationMode) return;
    setToolMode('none');
    selectedIdx = -1;
    hoveredIdx = -1;
    annotationMode = next;
    pointMode = next === 'point';
    boxMode = next === 'rect';
    updateModeUi();
    vscode.postMessage({ type: 'switchAnnotationMode', mode: next });
  }

  function updateModeUi() {
    document.getElementById('templateModeBtn').classList.toggle('active', annotationMode === 'template');
    document.getElementById('rectModeBtn').classList.toggle('active', annotationMode === 'rect');
    document.getElementById('pointModeBtn').classList.toggle('active', annotationMode === 'point');
    document.getElementById('generateBoxBtn').style.display = annotationMode === 'template' ? '' : 'none';
    document.getElementById('drawBtn').textContent = pointMode ? 'Point (' + keybindings.drawBbox.toUpperCase() + ')' : t('drawBbox');
    document.getElementById('bboxWRow').style.display = pointMode ? 'none' : '';
    document.getElementById('bboxHRow').style.display = pointMode ? 'none' : '';
    updateUndoRedoButtons();
  }

  function showShapeDialog(category, x, y, w, h, callback) {
    const modal = document.getElementById('bboxModal');
    const catInput = document.getElementById('bboxCat');
    const errorEl = document.getElementById('bboxError');
    const xInput = document.getElementById('bboxX');
    const yInput = document.getElementById('bboxY');
    const wInput = document.getElementById('bboxW');
    const hInput = document.getElementById('bboxH');
    const ok = document.getElementById('bboxOk');
    document.getElementById('bboxTitle').textContent = category ? (pointMode ? 'Edit point' : t('editBboxTitle')) : (pointMode ? 'New point' : t('newBboxTitle'));
    catInput.value = category;
    catInput.placeholder = isPositionMode() ? t('generatePathPlaceholder') : t('categoryLabel');
    xInput.value = x;
    yInput.value = y;
    wInput.value = w;
    hInput.value = h;
    document.getElementById('bboxWRow').style.display = pointMode ? 'none' : '';
    document.getElementById('bboxHRow').style.display = pointMode ? 'none' : '';
    errorEl.textContent = '';
    modal.classList.add('visible');
    catInput.focus();

    function validate() {
      const name = catInput.value.trim();
      if (isPositionMode()) {
        const problem = pathProblem(name) || pathOccupied(name, category);
        errorEl.textContent = problem ? pathMessage(problem) : '';
        ok.disabled = !!problem;
        return !problem;
      }
      if (!name) { errorEl.textContent = t('categoryRequired'); ok.disabled = true; return false; }
      const existing = imageData?.allCategories || {};
      if (name !== category && existing[name]) {
        errorEl.textContent = t('categoryExists', { file: existing[name] }); ok.disabled = true; return false;
      }
      errorEl.textContent = '';
      ok.disabled = false;
      return true;
    }
    catInput.oninput = validate;
    validate();
    ok.onclick = () => {
      if (!validate()) return;
      modal.classList.remove('visible');
      callback(catInput.value.trim(), +xInput.value, +yInput.value, pointMode ? 1 : +wInput.value, pointMode ? 1 : +hInput.value);
    };
    document.getElementById('bboxCancel').onclick = () => { modal.classList.remove('visible'); callback(null); };
  }

  function showEditDialog(idx) {
    const ann = annotations[idx];
    showShapeDialog(ann.category, ann.x, ann.y, ann.w, ann.h, (cat, x, y, w, h) => {
      if (!cat) return;
      const before = clone(annotations);
      const previous = ann.category;
      ann.category = cat;
      ann.x = Math.round(x);
      ann.y = Math.round(y);
      ann.w = pointMode ? 1 : Math.round(w);
      ann.h = pointMode ? 1 : Math.round(h);
      if (previous !== cat && hiddenSet().has(previous)) { hiddenSet().delete(previous); hiddenSet().add(cat); }
      commitHistory(before);
      saveAnnotations();
      paint();
    });
  }

  function finishRect(px, py) {
    const [ix1, iy1] = widgetToImg(drawStart.x, drawStart.y);
    const [ix2, iy2] = widgetToImg(px, py);
    const x = Math.round(Math.min(ix1, ix2)), y = Math.round(Math.min(iy1, iy2));
    const w = Math.round(Math.abs(ix2 - ix1)), h = Math.round(Math.abs(iy2 - iy1));
    drawStart = null; drawPreview = null;
    if (w < 3 || h < 3) { paint(); return; }
    showShapeDialog('', x, y, w, h, (cat, bx, by, bw, bh) => {
      if (cat) {
        const before = clone(annotations);
        annotations.push({ id: nextId++, category: cat, x: bx, y: by, w: bw, h: bh });
        commitHistory(before);
        saveAnnotations();
      }
      setToolMode('none');
      paint();
    });
  }

  function finishPoint(px, py) {
    const [ix, iy] = widgetToImg(px, py);
    const x = Math.round(Math.max(0, Math.min(ix, img?.width ?? ix)));
    const y = Math.round(Math.max(0, Math.min(iy, img?.height ?? iy)));
    showShapeDialog('', x, y, 1, 1, (cat, bx, by) => {
      if (cat) {
        const before = clone(annotations);
        annotations.push({ id: nextId++, category: cat, x: Math.round(bx), y: Math.round(by), w: 1, h: 1 });
        commitHistory(before);
        saveAnnotations();
      }
      setToolMode('none');
      paint();
    });
  }

  function doResize(px, py) {
    if (pointMode) return;
    const ann = annotations[selectedIdx];
    const orig = resizeOrigRect;
    const dx = (px - resizeStartPos.x) / scale;
    const dy = (py - resizeStartPos.y) / scale;
    let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
    const h = resizeHandle;
    if (['left','tl','bl'].includes(h)) { nx = orig.x + dx; nw = orig.w - dx; }
    if (['right','tr','br'].includes(h)) nw = orig.w + dx;
    if (['top','tl','tr'].includes(h)) { ny = orig.y + dy; nh = orig.h - dy; }
    if (['bottom','bl','br'].includes(h)) nh = orig.h + dy;
    nw = Math.max(5, nw); nh = Math.max(5, nh);
    if (img) {
      nx = Math.max(0, nx); ny = Math.max(0, ny);
      nw = Math.min(nw, img.width - nx); nh = Math.min(nh, img.height - ny);
    }
    ann.x = Math.round(nx); ann.y = Math.round(ny); ann.w = Math.round(nw); ann.h = Math.round(nh);
  }

  function normalizedBox(wx1, wy1, wx2, wy2) {
    if (!img) return null;
    const [ix1, iy1] = widgetToImg(wx1, wy1);
    const [ix2, iy2] = widgetToImg(wx2, wy2);
    return {
      x: clamp01(Math.min(ix1, ix2) / img.width),
      y: clamp01(Math.min(iy1, iy2) / img.height),
      tox: clamp01(Math.max(ix1, ix2) / img.width),
      toy: clamp01(Math.max(iy1, iy2) / img.height),
    };
  }

  function formatNormalizedBox(box) {
    return [box.x, box.y, box.tox, box.toy].map(v => v.toFixed(COORD_DECIMALS)).join(copyCoordsSpace ? ', ' : ',');
  }

  function finishCoord(px, py) {
    const box = drawStart ? normalizedBox(drawStart.x, drawStart.y, px, py) : null;
    drawStart = null; drawPreview = null; drawDragging = false;
    if (!box || box.tox - box.x <= 0.002 || box.toy - box.y <= 0.002) { coordBox = null; paint(); return; }
    coordBox = {
      x: Math.round(box.x * img.width), y: Math.round(box.y * img.height),
      w: Math.round((box.tox - box.x) * img.width), h: Math.round((box.toy - box.y) * img.height),
    };
    copyCoordBox(false);
  }

  function coordWidgetRect() {
    if (!coordBox) return null;
    const [wx, wy] = imgToWidget(coordBox.x, coordBox.y);
    return { x: wx, y: wy, w: coordBox.w * scale, h: coordBox.h * scale };
  }

  function coordContains(px, py) { const r = coordWidgetRect(); return !!r && rectContains(r, px, py); }
  function findCoordHandleAt(px, py) { const r = coordWidgetRect(); return r ? detectHandle(px, py, r) : null; }

  function copyCoordBox(silent) {
    if (!coordBox || !img) return;
    lastCoords = formatNormalizedBox({
      x: clamp01(coordBox.x / img.width), y: clamp01(coordBox.y / img.height),
      tox: clamp01((coordBox.x + coordBox.w) / img.width), toy: clamp01((coordBox.y + coordBox.h) / img.height),
    });
    document.getElementById('colorInfo').textContent = t('coordLabel') + ' ' + lastCoords;
    if (!silent) vscode.postMessage({ type: 'copyText', text: lastCoords });
    paint();
  }

  function applyCoordDrag(px, py) {
    const d = coordDrag;
    if (!d || !img) return;
    const dx = (px - d.startPos.x) / scale, dy = (py - d.startPos.y) / scale;
    const o = d.origRect;
    let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
    if (d.kind === 'move') { nx += dx; ny += dy; }
    else {
      const h = d.handle;
      const left = ['left','tl','bl'].includes(h), right = ['right','tr','br'].includes(h);
      const top = ['top','tl','tr'].includes(h), bottom = ['bottom','bl','br'].includes(h);
      if (left) { nx += dx; nw -= dx; } if (right) nw += dx;
      if (top) { ny += dy; nh -= dy; } if (bottom) nh += dy;
      nw = Math.max(5, nw); nh = Math.max(5, nh);
    }
    nx = Math.max(0, Math.min(nx, img.width - Math.max(1, nw)));
    ny = Math.max(0, Math.min(ny, img.height - Math.max(1, nh)));
    nw = Math.max(1, Math.min(nw, img.width - nx)); nh = Math.max(1, Math.min(nh, img.height - ny));
    coordBox = { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
  }

  function paintCoordBox() {
    const r = coordWidgetRect();
    if (!r) return;
    ctx.strokeStyle = '#e8a33d'; ctx.fillStyle = 'rgba(232,163,61,0.12)'; ctx.lineWidth = 2;
    ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#00c800';
    for (const [hx,hy] of [[r.x,r.y],[r.x+r.w,r.y],[r.x,r.y+r.h],[r.x+r.w,r.y+r.h]]) { ctx.beginPath(); ctx.arc(hx,hy,4,0,Math.PI*2); ctx.fill(); }
    if (lastCoords) { ctx.fillStyle = '#e8a33d'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(lastCoords, r.x + 1, r.y > 14 ? r.y - 6 : r.y + 14); }
  }

  function loadImgData() {
    if (!img?.complete) { imgData = null; return; }
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d'); cx.drawImage(img, 0, 0); imgData = cx.getImageData(0, 0, img.width, img.height);
  }

  function updateColorAt(px, py) {
    if (!img || !imgData || toolMode === 'copycoord') return;
    const [ix, iy] = widgetToImg(px, py);
    const x = Math.round(ix), y = Math.round(iy);
    const info = document.getElementById('colorInfo');
    const swatch = document.getElementById('swatch');
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) { info.textContent = `Abs: (${x}, ${y})`; swatch.style.background = 'transparent'; return; }
    const i = (y * img.width + x) * 4;
    const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2];
    info.textContent = `R:${r} G:${g} B:${b}  Abs:(${x},${y}) Rel:(${(ix/img.width).toFixed(3)},${(iy/img.height).toFixed(3)})`;
    swatch.style.background = `rgb(${r},${g},${b})`;
  }

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (e.button === 2) {
      const idx = findAnnAt(px, py);
      if (idx >= 0) { selectedIdx = idx; vscode.postMessage({ type: 'copyColor', category: annotations[idx].category }); paint(); }
      return;
    }
    if (e.button !== 0) return;

    if (toolMode === 'copycoord') {
      const handle = findCoordHandleAt(px, py);
      if (handle) { coordDrag = { kind:'resize', handle, startPos:{x:px,y:py}, origRect:clone(coordBox) }; return; }
      if (coordContains(px, py)) { coordDrag = { kind:'move', handle:null, startPos:{x:px,y:py}, origRect:clone(coordBox) }; return; }
      drawStart = { x:px, y:py }; drawDragging = true; return;
    }
    if (toolMode === 'draw') {
      if (pointMode) { finishPoint(px, py); return; }
      if (!drawStart) { drawStart = { x:px, y:py }; drawDragging = true; }
      else finishRect(px, py);
      return;
    }
    if (toolMode === 'delete') {
      const idx = findAnnAt(px, py); if (idx >= 0) { selectedIdx = idx; deleteSelected(); }
      return;
    }

    const { idx:hIdx, handle } = findHandleAt(px, py);
    if (handle && hIdx >= 0) {
      selectedIdx = hIdx; resizing = true; resizeHandle = handle; resizeStartPos = {x:px,y:py}; resizeOrigRect = clone(annotations[hIdx]); paint(); return;
    }
    const idx = findAnnAt(px, py);
    selectedIdx = idx;
    if (idx >= 0) {
      dragging = true; dragStartPos = {x:px,y:py}; dragOrigRect = clone(annotations[idx]);
    } else if (isZoomed()) {
      panning = true; panStartPos = {x:px,y:py}; panStartOffset = {x:offsetX,y:offsetY}; canvas.style.cursor = 'grabbing';
    }
    paint();
  });

  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const idx = findAnnAt(e.clientX - rect.left, e.clientY - rect.top);
    if (idx < 0) return;
    if (dragging && dragOrigRect) Object.assign(annotations[idx], dragOrigRect);
    dragging = false; resizing = false; dragOrigRect = null; resizeOrigRect = null;
    selectedIdx = idx; paint(); showEditDialog(idx);
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (coordDrag) { applyCoordDrag(px, py); copyCoordBox(true); return; }
    if ((toolMode === 'draw' || toolMode === 'copycoord') && !pointMode && drawStart) { drawPreview = {x:px,y:py}; paint(); return; }
    if (resizing && selectedIdx >= 0) { doResize(px, py); paint(); return; }
    if (dragging && selectedIdx >= 0) {
      const ann = annotations[selectedIdx];
      const dx = (px - dragStartPos.x) / scale, dy = (py - dragStartPos.y) / scale;
      const maxX = pointMode ? img.width : img.width - ann.w;
      const maxY = pointMode ? img.height : img.height - ann.h;
      ann.x = Math.round(Math.max(0, Math.min(dragOrigRect.x + dx, maxX)));
      ann.y = Math.round(Math.max(0, Math.min(dragOrigRect.y + dy, maxY)));
      paint(); return;
    }
    if (panning) { offsetX = panStartOffset.x + (px - panStartPos.x); offsetY = panStartOffset.y + (py - panStartPos.y); recalcOffset(); paint(); return; }

    if (toolMode === 'none') {
      const { idx:hIdx, handle } = findHandleAt(px, py);
      if (handle) { hoveredIdx = hIdx; canvas.style.cursor = handleCursor(handle); }
      else { const idx = findAnnAt(px, py); hoveredIdx = idx; canvas.style.cursor = idx >= 0 ? 'move' : isZoomed() ? 'grab' : 'crosshair'; }
      paint();
    } else if (toolMode === 'delete') {
      hoveredIdx = findAnnAt(px, py); canvas.style.cursor = hoveredIdx >= 0 ? 'pointer' : 'default'; paint();
    } else canvas.style.cursor = 'crosshair';
    updateColorAt(px, py);
  });

  canvas.addEventListener('mouseup', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (coordDrag) { const before = coordDrag.origRect; applyCoordDrag(px, py); coordDrag = null; if (JSON.stringify(before) !== JSON.stringify(coordBox)) copyCoordBox(false); return; }
    if ((toolMode === 'draw' || toolMode === 'copycoord') && !pointMode && drawDragging && drawStart) {
      const dist = Math.hypot(px - drawStart.x, py - drawStart.y); drawDragging = false;
      if (dist > 5) { if (toolMode === 'draw') finishRect(px, py); else finishCoord(px, py); return; }
      if (toolMode === 'copycoord') { drawStart = null; drawPreview = null; coordBox = null; paint(); }
      return;
    }
    if (dragging && selectedIdx >= 0) {
      const before = annotations.map((ann, i) => i === selectedIdx ? dragOrigRect : ann);
      dragging = false; dragStartPos = null; dragOrigRect = null;
      commitHistory(clone(before)); saveAnnotations(); paint();
    }
    if (resizing && selectedIdx >= 0) {
      const before = annotations.map((ann, i) => i === selectedIdx ? resizeOrigRect : ann);
      resizing = false; resizeHandle = null; resizeOrigRect = null; resizeStartPos = null;
      commitHistory(clone(before)); saveAnnotations(); paint();
    }
    if (panning) { panning = false; panStartPos = null; panStartOffset = null; }
  });

  canvas.addEventListener('wheel', (e) => {
    if (!img) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const [ix, iy] = widgetToImg(px, py);
    scale = Math.max(fitScale, Math.min(50, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    offsetX = px - ix * scale; offsetY = py - iy * scale; recalcOffset(); e.preventDefault(); paint();
  }, { passive:false });

  function openGenerateBox() {
    if (annotationMode !== 'template') return;
    const choices = document.getElementById('generateChoices'); choices.replaceChildren();
    annotations.forEach((ann, index) => {
      const label = document.createElement('label'); label.className = 'annotation-row';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selectedIdx < 0 || selectedIdx === index; input.dataset.index = String(index);
      const text = document.createElement('span'); text.textContent = ann.category; label.append(input, text); choices.append(label);
    });
    const selected = annotations[selectedIdx];
    const seed = selected?.category || annotations[0]?.category || 'region';
    document.getElementById('generatePath').value = 'screen.' + String(seed).replace(/[^A-Za-z0-9_]/g, '_');
    document.getElementById('generateError').textContent = '';
    document.getElementById('generateModal').classList.add('visible');
  }

  function refreshGeneratePathState() {
    const input = document.getElementById('generatePath');
    const problem = pathProblem(input.value) || pathOccupied(input.value, null);
    document.getElementById('generateError').textContent = problem ? pathMessage(problem) : '';
    document.getElementById('generateOk').disabled = !!problem;
    return problem;
  }

  function navigate(delta) {
    if (!imageData) return;
    const target = imageData.currentIndex + delta;
    if (target < 0 || target >= imageData.totalImages) return;
    clearHistory();
    setToolMode('none');
    selectedIdx = -1;
    hoveredIdx = -1;
    vscode.postMessage({ type:'navigate', index:target });
  }

  document.addEventListener('keydown', (e) => {
    if (document.getElementById('bboxModal').classList.contains('visible')) return;
    if (document.getElementById('generateModal').classList.contains('visible')) {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('generateOk').click(); }
      return;
    }
    if (matchKeybinding(e, keybindings.modeTemplate)) { e.preventDefault(); requestAnnotationMode('template'); return; }
    if (matchKeybinding(e, keybindings.modeRect)) { e.preventDefault(); requestAnnotationMode('rect'); return; }
    if (matchKeybinding(e, keybindings.modePoint)) { e.preventDefault(); requestAnnotationMode('point'); return; }
    if (matchKeybinding(e, keybindings.undo)) { e.preventDefault(); undo(); return; }
    if (matchKeybinding(e, keybindings.redo)) { e.preventDefault(); redo(); return; }
    if (matchKeybinding(e, keybindings.copy) && selectedIdx >= 0 && toolMode === 'none') { clipboard = clone(annotations[selectedIdx]); return; }
    if (matchKeybinding(e, keybindings.paste) && clipboard && toolMode === 'none') {
      const before = clone(annotations);
      const copy = { ...clone(clipboard), id: nextId++, x: clipboard.x + 10, y: clipboard.y + 10 };
      if (img) { copy.x = Math.max(0, Math.min(copy.x, pointMode ? img.width : img.width - copy.w)); copy.y = Math.max(0, Math.min(copy.y, pointMode ? img.height : img.height - copy.h)); }
      annotations.push(copy); selectedIdx = annotations.length - 1; commitHistory(before); saveAnnotations(); paint(); return;
    }
    if (matchKeybinding(e, keybindings.drawBbox)) { setToolMode(toolMode === 'draw' ? 'none' : 'draw'); return; }
    if (matchKeybinding(e, keybindings.copyCoords)) { setToolMode(toolMode === 'copycoord' ? 'none' : 'copycoord'); return; }
    if (matchKeybinding(e, keybindings.deleteMode)) { setToolMode(toolMode === 'delete' ? 'none' : 'delete'); return; }
    if (matchKeybinding(e, keybindings.deleteSelected) && selectedIdx >= 0 && toolMode === 'none') { deleteSelected(); return; }
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) && selectedIdx >= 0 && toolMode === 'none' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (nudgeSelected(dx, dy)) { e.preventDefault(); return; }
    }
    if (matchKeybinding(e, keybindings.prevImage)) navigate(-1);
    else if (matchKeybinding(e, keybindings.nextImage)) navigate(1);
  });

  document.getElementById('templateModeBtn').onclick = () => requestAnnotationMode('template');
  document.getElementById('rectModeBtn').onclick = () => requestAnnotationMode('rect');
  document.getElementById('pointModeBtn').onclick = () => requestAnnotationMode('point');
  document.getElementById('sharedHistoryChk').checked = sharedHistory;
  document.getElementById('sharedHistoryChk').onchange = (e) => {
    sharedHistory = e.target.checked;
    vscode.setState({ ...(vscode.getState() || {}), sharedHistory });
    updateUndoRedoButtons();
  };
  document.getElementById('drawBtn').onclick = () => setToolMode(toolMode === 'draw' ? 'none' : 'draw');
  document.getElementById('coordBtn').onclick = () => setToolMode(toolMode === 'copycoord' ? 'none' : 'copycoord');
  document.getElementById('deleteBtn').onclick = () => setToolMode(toolMode === 'delete' ? 'none' : 'delete');
  document.getElementById('undoBtn').onclick = undo;
  document.getElementById('redoBtn').onclick = redo;
  document.getElementById('prevBtn').onclick = () => navigate(-1);
  document.getElementById('nextBtn').onclick = () => navigate(1);
  document.getElementById('showAllBtn').onclick = () => { hiddenSet().clear(); listSignature=''; paint(); };
  document.getElementById('hideAllBtn').onclick = () => { const hidden=hiddenSet(); hidden.clear(); annotations.forEach(a=>hidden.add(a.category)); listSignature=''; paint(); };
  document.getElementById('onlyCurrentBtn').onclick = () => { const hidden=hiddenSet(), current=annotations[selectedIdx]; hidden.clear(); annotations.forEach(a=>{ if (!current || a.category!==current.category) hidden.add(a.category); }); listSignature=''; paint(); };
  document.getElementById('generateBoxBtn').onclick = openGenerateBox;
  document.getElementById('generateCancel').onclick = () => document.getElementById('generateModal').classList.remove('visible');
  document.getElementById('generatePath').oninput = refreshGeneratePathState;
  document.getElementById('generateOk').onclick = () => {
    if (refreshGeneratePathState()) return;
    const chosen = [];
    document.querySelectorAll('#generateChoices input').forEach(input => { if (input.checked) chosen.push(annotations[Number(input.dataset.index)]); });
    if (!chosen.length) { document.getElementById('generateError').textContent = t('generateNeedSelection'); return; }
    vscode.postMessage({ type:'generateBox', path:document.getElementById('generatePath').value.trim(), boxes:chosen.map(a=>({x:a.x,y:a.y,w:a.w,h:a.h})) });
  };

  function updateStaticText() {
    document.getElementById('bboxCatLabel').textContent = t('categoryLabel');
    document.getElementById('bboxCancel').textContent = t('cancel');
    document.getElementById('coordBtn').textContent = t('copyCoords');
    document.getElementById('deleteBtn').textContent = t('deleteMode');
    document.getElementById('annotationListTitle').textContent = t('annotationListTitle');
    document.getElementById('showAllBtn').textContent = t('showAllAnnotations');
    document.getElementById('hideAllBtn').textContent = t('hideAllAnnotations');
    document.getElementById('onlyCurrentBtn').textContent = t('showOnlyCurrent');
    document.getElementById('generateBoxBtn').textContent = t('generateBox');
    document.getElementById('generateTitle').textContent = t('generateBoxTitle');
    document.getElementById('generatePathLabel').textContent = t('generatePath');
    document.getElementById('generateCancel').textContent = t('cancel');
    document.getElementById('generateOk').textContent = t('ok');
    document.getElementById('prevBtn').title = t('prevImage');
    document.getElementById('nextBtn').title = t('nextImage');
    document.getElementById('emptyMsg').textContent = t('noImageLoaded');
    updateModeUi();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'config') {
      if (msg.keybindings) Object.assign(keybindings, msg.keybindings);
      if (typeof msg.copyCoordsSpace === 'boolean') copyCoordsSpace = msg.copyCoordsSpace;
      if (msg.boxPathRule) boxPathRule = msg.boxPathRule;
      if (msg.annotationMode) annotationMode = msg.annotationMode;
      pointMode = annotationMode === 'point';
      boxMode = annotationMode === 'rect';
      updateStaticText();
      return;
    }
    if (msg.type === 'positionPaths') {
      if (imageData) imageData.positionPaths = msg.positionPaths || {};
      return;
    }
    if (msg.type === 'generateBoxResult') {
      if (msg.ok) document.getElementById('generateModal').classList.remove('visible');
      else document.getElementById('generateError').textContent = pathMessage(msg.error === 'duplicate' ? {code:'duplicate'} : {code:msg.error || 'unknown'});
      return;
    }
    if (msg.type !== 'load') return;

    const incomingMode = msg.annotationMode || annotationMode;
    const newImageKey = msg.filename || '';
    const imageChanged = currentImageKey && currentImageKey !== newImageKey;
    if (imageChanged) clearHistory();
    currentImageKey = newImageKey;
    annotationMode = incomingMode;
    pointMode = incomingMode === 'point';
    boxMode = incomingMode === 'rect';
    imageData = msg;
    annotations = clone(msg.annotations || []);
    modeCache[annotationMode] = clone(annotations);
    nextId = annotations.length ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
    selectedIdx = -1;
    hoveredIdx = -1;
    listSignature = '';
    updateModeUi();

    const needImageLoad = !img || imageChanged;
    if (msg.imageBase64 && needImageLoad) {
      img = new Image();
      img.onload = () => {
        emptyMsg.style.display = 'none'; canvas.style.display = 'block';
        recalcFit(); scale = fitScale; recalcOffset(); loadImgData(); paint();
      };
      img.src = msg.imageBase64;
    } else if (msg.imageBase64 && img) {
      emptyMsg.style.display = 'none'; canvas.style.display = 'block'; paint();
    } else {
      img = null; imgData = null; canvas.style.display = 'none'; emptyMsg.style.display = 'flex'; syncAnnotationList();
    }
    document.getElementById('navInfo').textContent = `${msg.filename} (${msg.currentIndex + 1}/${msg.totalImages})`;
    document.getElementById('prevBtn').disabled = msg.currentIndex <= 0;
    document.getElementById('nextBtn').disabled = msg.currentIndex >= msg.totalImages - 1;
    updateUndoRedoButtons();
  });

  window.addEventListener('resize', resize);
  resize();
  updateStaticText();
  vscode.postMessage({ type:'ready' });
})();
