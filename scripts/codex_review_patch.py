from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'{label} not found')
    return text.replace(old, new, 1)

# app.js: make native implementation the single source of truth for coordinates,
# block editing while an async mode load is pending, and avoid no-op saves.
p = Path('media/annotationPanel/app.js')
s = p.read_text(encoding='utf-8')
s = replace_once(s, "  let copyCoordsSpace = true;\n", """  let copyCoordsSpace = true;
  let modeLoading = false;
  let pendingMode = null;
  let coordPreferXywh = savedUi.coordPreferXywh === true;
  const COORD_EPS = 1e-6;

  function pairedZero(w, h) { return (Math.abs(w) <= COORD_EPS) === (Math.abs(h) <= COORD_EPS); }
  function asXywh(values) {
    if (!Array.isArray(values) || values.length !== 4) return null;
    const [x0, y0, w0, h0] = values.map(Number);
    if (![x0,y0,w0,h0].every(Number.isFinite) || x0 < -COORD_EPS || y0 < -COORD_EPS || w0 < -COORD_EPS || h0 < -COORD_EPS
      || x0 > 1 + COORD_EPS || y0 > 1 + COORD_EPS || x0 + w0 > 1 + COORD_EPS || y0 + h0 > 1 + COORD_EPS
      || !pairedZero(w0, h0)) return null;
    const x = clamp01(x0), y = clamp01(y0);
    const w = Math.abs(w0) <= COORD_EPS ? 0 : Math.min(clamp01(w0), 1 - x);
    const h = Math.abs(h0) <= COORD_EPS ? 0 : Math.min(clamp01(h0), 1 - y);
    return { x, y, w, h };
  }
  function asXyxy(values) {
    if (!Array.isArray(values) || values.length !== 4) return null;
    const [x10, y10, x20, y20] = values.map(Number);
    if (![x10,y10,x20,y20].every(Number.isFinite) || x10 < -COORD_EPS || y10 < -COORD_EPS || x20 < -COORD_EPS || y20 < -COORD_EPS
      || x10 > 1 + COORD_EPS || y10 > 1 + COORD_EPS || x20 > 1 + COORD_EPS || y20 > 1 + COORD_EPS
      || x20 + COORD_EPS < x10 || y20 + COORD_EPS < y10) return null;
    const x1 = clamp01(x10), y1 = clamp01(y10), x2 = clamp01(x20), y2 = clamp01(y20);
    const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
    if (!pairedZero(w, h)) return null;
    return { x: x1, y: y1, w: Math.abs(w) <= COORD_EPS ? 0 : w, h: Math.abs(h) <= COORD_EPS ? 0 : h };
  }
  function interpretBareCoordinates(values) {
    const xywh = asXywh(values), xyxy = asXyxy(values);
    if (xywh && !xyxy) return xywh;
    if (xyxy && !xywh) return xyxy;
    if (xywh && xyxy) return coordPreferXywh ? xywh : xyxy;
    return null;
  }
""", 'coordinate state insertion')

s = replace_once(s, """  function commitHistory(before) {
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
  }""", """  function commitHistory(before) {
    if (modeLoading) return false;
    const after = clone(annotations);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const tx = { id: history.nextId++, mode: historyKey(), before, after, applied: true };
    history.globalUndo.push(tx);
    history.byMode[tx.mode].push(tx);
    if (history.globalUndo.length > MAX_UNDO) history.globalUndo.shift();
    if (history.byMode[tx.mode].length > MAX_UNDO) history.byMode[tx.mode].shift();
    history.globalRedo.length = 0;
    history.redoByMode[tx.mode].length = 0;
    modeCache[tx.mode] = clone(after);
    updateUndoRedoButtons();
    return true;
  }""", 'commitHistory')

s = s.replace("  function undo() {\n", "  function undo() {\n    if (modeLoading) return;\n", 1)
s = s.replace("  function redo() {\n", "  function redo() {\n    if (modeLoading) return;\n", 1)
s = s.replace("  function saveAnnotations(mode = annotationMode, data = annotations) {\n", "  function saveAnnotations(mode = annotationMode, data = annotations) {\n    if (modeLoading) return;\n", 1)
s = s.replace("  function nudgeSelected(dx, dy) {\n", "  function nudgeSelected(dx, dy) {\n    if (modeLoading) return false;\n", 1)
s = replace_once(s, """    commitHistory(before);
    saveAnnotations();
    paint();
    return true;
  }

  function deleteSelected()""", """    if (!commitHistory(before)) { paint(); return false; }
    saveAnnotations();
    paint();
    return true;
  }

  function deleteSelected()""", 'nudge save')
s = s.replace("  function deleteSelected() {\n", "  function deleteSelected() {\n    if (modeLoading) return;\n", 1)

s = replace_once(s, """  function requestAnnotationMode(next) {
    if (next === annotationMode) return;
    setToolMode('none');
    clearSelection();
    hoveredIdx = -1;
    annotationMode = next;
    pointMode = next === 'point';
    boxMode = next === 'rect';
    updateModeUi();
    vscode.postMessage({ type: 'switchAnnotationMode', mode: next });
  }""", """  function requestAnnotationMode(next) {
    if (next === annotationMode && !modeLoading) return;
    setToolMode('none');
    clearSelection();
    hoveredIdx = -1;
    pendingMode = next;
    modeLoading = true;
    annotationMode = next;
    pointMode = next === 'point';
    boxMode = next === 'rect';
    annotations = [];
    nextId = 1;
    listSignature = '';
    updateModeUi();
    paint();
    vscode.postMessage({ type: 'switchAnnotationMode', mode: next });
  }""", 'requestAnnotationMode')

s = replace_once(s, """  function formatNormalizedBox(box) {
    return [box.x, box.y, box.w, box.h].map(v => v.toFixed(COORD_DECIMALS)).join(copyCoordsSpace ? ', ' : ',');
  }""", """  function formatNormalizedBox(box) {
    const values = coordPreferXywh
      ? [box.x, box.y, box.w, box.h]
      : [box.x, box.y, box.x + box.w, box.y + box.h];
    return values.map(v => v.toFixed(COORD_DECIMALS)).join(copyCoordsSpace ? ', ' : ',');
  }""", 'formatNormalizedBox')

start = s.index('  function parseClipboardPayload(text) {')
end = s.index('\n  function pasteStatus(text) {', start)
s = s[:start] + """  function parseClipboardPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    let name;
    let box;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && Array.isArray(parsed.bbox)) {
      box = asXywh(parsed.bbox);
      if (typeof parsed.name === 'string' && parsed.name.trim()) name = parsed.name.trim();
    } else {
      let values;
      if (Array.isArray(parsed)) values = parsed;
      else if (parsed === undefined) {
        const plain = raw.replace(/[\\[\\](){}]/g, ' ').split(/[\\s,;]+/).filter(Boolean).map(Number);
        if (plain.length === 4 && plain.every(Number.isFinite)) values = plain;
      }
      box = interpretBareCoordinates(values);
    }
    return box ? { name, box } : null;
  }
""" + s[end:]

s = s.replace("  function addPastedAnnotation(name, pixel) {\n", "  function addPastedAnnotation(name, pixel) {\n    if (modeLoading) return;\n", 1)
s = s.replace("    if (!img || toolMode !== 'none') return;\n    const payload = parseClipboardPayload(text);", "    if (!img || toolMode !== 'none' || modeLoading) return;\n    const payload = parseClipboardPayload(text);", 1)
s = s.replace("Clipboard is not a normalized x, y, w, h annotation.", "Clipboard is not a valid normalized coordinate tuple.", 1)
s = replace_once(s, """    if (!zeroSize && annotationMode === 'point') {
      pasteStatus('Point mode only accepts zero-size coordinates.');
      return;
    }
    const pixel = {
      x: Math.round(payload.box.x * img.width),
      y: Math.round(payload.box.y * img.height),
      w: zeroSize ? 0 : Math.max(1, Math.round(payload.box.w * img.width)),
      h: zeroSize ? 0 : Math.max(1, Math.round(payload.box.h * img.height)),
    };""", """    let box = payload.box;
    if (!zeroSize && annotationMode === 'point') {
      box = { x: box.x + box.w / 2, y: box.y + box.h / 2, w: 0, h: 0 };
    }
    const finalZeroSize = box.w === 0 && box.h === 0;
    const pixel = {
      x: Math.round(box.x * img.width),
      y: Math.round(box.y * img.height),
      w: finalZeroSize ? 0 : Math.max(1, Math.round(box.w * img.width)),
      h: finalZeroSize ? 0 : Math.max(1, Math.round(box.h * img.height)),
    };""", 'point paste projection')

# Drag and resize no-ops no longer cause a save/write.
s = s.replace("      commitHistory(clone(before)); saveAnnotations(); paint();", "      if (commitHistory(clone(before))) saveAnnotations(); paint();", 2)

# Add checkbox ownership after shared-history handler.
anchor = "  document.getElementById('sharedHistoryChk').onchange = (e) => {\n"
i = s.index(anchor)
close = s.index("  };", i) + len("  };")
s = s[:close] + """
  const coordPreferXywhChk = document.getElementById('coordPreferXywhChk');
  coordPreferXywhChk.checked = coordPreferXywh;
  coordPreferXywhChk.onchange = (e) => {
    coordPreferXywh = e.target.checked;
    if (typeof vscode.setState === 'function') vscode.setState({ ...((typeof vscode.getState === 'function' && vscode.getState()) || {}), coordPreferXywh });
    if (coordBox) copyCoordBox(true);
    paint();
  };""" + s[close:]

s = s.replace("  function finishRect(px, py) {\n", "  function finishRect(px, py) {\n    if (modeLoading) return;\n", 1)
s = s.replace("  function finishPoint(px, py) {\n", "  function finishPoint(px, py) {\n    if (modeLoading) return;\n", 1)
s = s.replace("    if (matchKeybinding(e, keybindings.copy) && hasSelection()", "    if (!modeLoading && matchKeybinding(e, keybindings.copy) && hasSelection()", 1)
s = s.replace("    if (matchKeybinding(e, keybindings.paste) && toolMode === 'none')", "    if (!modeLoading && matchKeybinding(e, keybindings.paste) && toolMode === 'none')", 1)

marker = "    const incomingMode = msg.annotationMode || annotationMode;\n"
s = replace_once(s, marker, marker + "    if (pendingMode && incomingMode !== pendingMode) return;\n    if (pendingMode === incomingMode) { pendingMode = null; modeLoading = false; }\n", 'stale load guard')
p.write_text(s, encoding='utf-8')

# Remove the inline coordinate bridge. The normal app now owns the full protocol.
p = Path('media/annotationPanel/index.html')
s = p.read_text(encoding='utf-8')
marker = '  <div id="annotationPanelI18n" hidden>__I18N_JSON__</div>'
i = s.index(marker)
p.write_text(s[:i] + marker + '\n  <script src="__APP_SCRIPT_URI__"></script>\n</body>\n</html>\n', encoding='utf-8')

# Resource preview: tag thumbnail batches with their originating mode, and bypass
# template-name lookup when opening rect/point source images.
p = Path('src/templatePanel.ts')
s = p.read_text(encoding='utf-8')
s = replace_once(s, "import { cropTemplateThumbFileAsync, openAnnotatedImage, THUMB_HEIGHT } from './pngCrop';", "import { annotatedImageFile, cropTemplateThumbFileAsync, openAnnotatedImage, THUMB_HEIGHT } from './pngCrop';", 'pngCrop import')
s = s.replace("await this.webview.postMessage({ type: 'thumbs', items });", "await this.webview.postMessage({ type: 'thumbs', mode: this.mode, items });")
s = replace_once(s, "await this.openOriginalWithMarker(msg.imagePath, msg.name, msg.bbox);", "await this.openOriginalWithMarker(msg.imagePath, msg.name, msg.bbox, this.mode);", 'open marker call')
s = replace_once(s, "private async openOriginalWithMarker(imagePath: string, name: string, bboxJson: string): Promise<void> {", "private async openOriginalWithMarker(imagePath: string, name: string, bboxJson: string, mode: ResourcePreviewMode): Promise<void> {", 'open marker signature')
s = replace_once(s, "async () => openAnnotatedImage(imagePath, name, bbox!, this.thumbDir, this.features.root),", "async () => mode === 'template'\n          ? openAnnotatedImage(imagePath, name, bbox!, this.thumbDir, this.features.root)\n          : annotatedImageFile(imagePath, bbox!, this.thumbDir),", 'direct annotated open')
p.write_text(s, encoding='utf-8')

p = Path('media/templatePanel/app.js')
s = p.read_text(encoding='utf-8')
s = replace_once(s, "      case 'thumbs': {\n        for (const it of (msg.items || []))", "      case 'thumbs': {\n        if (msg.mode && msg.mode !== currentMode) break;\n        for (const it of (msg.items || []))", 'thumb mode guard')
p.write_text(s, encoding='utf-8')

# One unified AnnotationPanel singleton exists at runtime; do not branch through a declaration-only property.
p = Path('src/templateAssetPanel.ts')
s = p.read_text(encoding='utf-8')
s = replace_once(s, "(this.boxes ? AnnotationPanel.currentBoxes : AnnotationPanel.current)?.controller.reloadIfShowing([sourcePath, targetPath]);", "AnnotationPanel.current?.controller.reloadIfShowing([sourcePath, targetPath]);", 'currentBoxes removal')
p.write_text(s, encoding='utf-8')

# Collision-safe generated Python class names.
p = Path('src/positionResourcePure.ts')
s = p.read_text(encoding='utf-8')
s = re.sub(r'\nfunction pascalCase\(value: string\): string \{.*?\n\}\n', '\n', s, count=1, flags=re.S)
s = replace_once(s, """function classNameForPath(parts: string[]): string {
  if (parts.length === 1 && parts[0] === 'screen') return 'ScreenPosition';
  return parts.map(pascalCase).join('') + 'Position';
}""", """function classNameForPath(parts: string[]): string {
  if (parts.length === 1 && parts[0] === 'screen') return 'ScreenPosition';
  return 'Position_' + parts.map(part => `${part.length}_${part}`).join('__');
}""", 'classNameForPath')
p.write_text(s, encoding='utf-8')
