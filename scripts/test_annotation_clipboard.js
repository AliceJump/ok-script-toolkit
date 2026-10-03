const fs = require('fs');
const path = require('path');
let jsdom;
try {
  jsdom = require('jsdom');
} catch {
  const jsdomRoot = process.env.OK_LANG_HINTS_JSDOM_ROOT || path.join(process.env.TEMP, 'ok-script-toolkit-jsdom');
  jsdom = require(path.join(jsdomRoot, 'node_modules', 'jsdom'));
}
const { JSDOM, VirtualConsole } = jsdom;

const root = path.resolve(__dirname, '..');
const componentRoot = path.join(root, 'media', 'annotationPanel');
const dictionary = {
  categoryLabel: 'Category:', widthLabel: 'Width:', heightLabel: 'Height:', cancel: 'Cancel',
  newBboxTitle: 'New Box', drawBbox: 'Draw (R)', drawBboxTooltip: 'Draw tip',
  copyCoords: 'Coords (C)', copyCoordsTooltip: 'Coords tip', coordLabel: 'Coords:',
  deleteMode: 'Delete (D)', deleteBboxTooltip: 'Delete tip', prevImage: 'Prev', nextImage: 'Next',
  noImageLoaded: 'No image', editBboxTitle: 'Edit Box', categoryRequired: 'Required',
  categoryExists: 'Exists in {file}', undo: 'Undo', redo: 'Redo',
  boxPathRequired: 'Path required', boxPathTwoSegments: 'Two segments: {path}',
  boxPathBadSegment: 'Bad segment: {segment}', boxPathExists: 'Path exists', boxPathRuleMissing: 'Rule missing',
};

let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');
html = html
  .replaceAll('__CSP_NONCE__', 'test')
  .replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary))
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', '')
  .replace('<script src="__APP_SCRIPT_URI__"></script>', `<script>${fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8')}</script>`);

const sent = [];
let webviewState = {};
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { throw error; });

function makeContext() {
  const noop = () => {};
  return {
    clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop,
    fill: noop, fillText: noop, drawImage: noop, setLineDash: noop,
    moveTo: noop, lineTo: noop, stroke: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
  };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({
      postMessage: message => sent.push(message),
      getState: () => webviewState,
      setState: state => { webviewState = state || {}; },
    });
    window.HTMLCanvasElement.prototype.getContext = function () { return makeContext(); };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
    const srcDesc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src');
    Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
      configurable: true,
      get() { return srcDesc.get.call(this); },
      set(value) {
        srcDesc.set.call(this, value);
        window.setTimeout(() => { if (typeof this.onload === 'function') this.onload(new window.Event('load')); }, 0);
      },
    });
    for (const prop of ['width', 'height']) {
      Object.defineProperty(window.HTMLImageElement.prototype, prop, {
        configurable: true,
        get() {
          const m = /(\d+)x(\d+)/.exec(this.getAttribute('src') || '');
          return m ? Number(prop === 'width' ? m[1] : m[2]) : 0;
        },
      });
    }
    Object.defineProperty(window.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return true; } });
  },
});

const { window } = dom;
const document = window.document;
const canvas = document.getElementById('canvas');
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const flush = () => new Promise(resolve => window.setTimeout(resolve, 0));
const posts = type => sent.filter(item => item?.type === type);
const last = type => posts(type).at(-1);
function mouse(type, x, y, init = {}) {
  canvas.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }));
}
function key(key, init = {}) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init }));
}
function message(data) { window.dispatchEvent(new window.MessageEvent('message', { data })); }
function nameOpenPaste(name) {
  document.getElementById('bboxCat').value = name;
  document.getElementById('bboxCat').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('bboxOk').click();
}

(async () => {
  await flush();
  const formatChk = document.getElementById('coordPreferXywhChk');
  assert(formatChk && !formatChk.checked, 'bare coordinate preference defaults to XYXY');

  message({ type: 'config', annotationMode: 'rect', boxPathRule: { segment: '^[A-Za-z_][A-Za-z0-9_]*$' }, keybindings: {
    copy: 'ctrl+c', paste: 'ctrl+v', modeTemplate: '1', modeRect: '2', modePoint: '3',
    undo: 'ctrl+z', redo: 'ctrl+y', drawBbox: 'r', copyCoords: 'c', deleteMode: 'd',
    deleteSelected: 'Delete', prevImage: 'ArrowLeft', nextImage: 'ArrowRight',
  } });
  message({
    type: 'load', annotationMode: 'rect', imagePath: 'x/a.png', imageBase64: 'data:image/png;base64,FAKE-1000x1000',
    filename: 'a.png', currentIndex: 0, totalImages: 1, allCategories: {},
    annotations: [
      { id: 1, category: 'screen.a', x: 100, y: 100, w: 200, h: 200 },
      { id: 2, category: 'screen.b', x: 500, y: 500, w: 100, h: 100 },
    ],
  });
  await flush(); await flush();

  // Single selection is explicit plugin JSON and is always XYWH regardless of preference.
  mouse('mousedown', 220, 120); mouse('mouseup', 220, 120);
  key('c', { ctrlKey: true });
  assert(last('copyText').text === '{"name":"screen.a","bbox":[0.1,0.1,0.2,0.2]}', 'single copy keeps explicit named XYWH');

  // Unnamed copies follow the user's raw four-number preference so they round-trip through ambiguous paste.
  mouse('mousedown', 430, 330, { ctrlKey: true }); mouse('mouseup', 430, 330, { ctrlKey: true });
  key('c', { ctrlKey: true });
  assert(last('copyText').text === '0.1000, 0.1000, 0.6000, 0.6000', 'default multi-copy emits unnamed XYXY outer union');

  const copiesBeforeClear = posts('copyText').length;
  mouse('mousedown', 650, 500); mouse('mouseup', 650, 500);
  key('c', { ctrlKey: true });
  assert(posts('copyText').length === copiesBeforeClear, 'empty click clears multi-selection');

  message({ type: 'clipboardText', text: '{"name":"screen.a","bbox":[0.7,0.7,0.1,0.1]}' });
  await flush();
  let save = last('save');
  assert(save.annotations.some(a => a.category === 'screen.a2' && a.x === 700 && a.y === 700 && a.w === 100 && a.h === 100),
    'named bbox is explicit XYWH and duplicate gets numeric suffix');

  // Only XYWH is valid here because interpreting c,d as x2,y2 would reverse both axes.
  const saveCount = posts('save').length;
  message({ type: 'clipboardText', text: '0.2, 0.2, 0.1, 0.1' });
  await flush();
  assert(document.getElementById('bboxModal').classList.contains('visible'), 'unnamed paste opens the naming dialog');
  assert(posts('save').length === saveCount, 'unnamed paste does not write before naming');
  assert(Number(document.getElementById('bboxW').value) === 100 && Number(document.getElementById('bboxH').value) === 100,
    'XYWH-only tuple is auto-detected independent of preference');
  nameOpenPaste('screen.unnamed');
  await flush();

  // Ambiguous tuple: both XYWH and XYXY are valid. Default preference is XYXY.
  message({ type: 'clipboardText', text: '0.1, 0.1, 0.2, 0.2' });
  await flush();
  assert(Number(document.getElementById('bboxX').value) === 100 && Number(document.getElementById('bboxY').value) === 100
    && Number(document.getElementById('bboxW').value) === 100 && Number(document.getElementById('bboxH').value) === 100,
    'ambiguous tuple defaults to XYXY');
  nameOpenPaste('screen.amb_xyxy');
  await flush();

  formatChk.checked = true;
  formatChk.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(webviewState.coordPreferXywh === true, 'XYWH preference is persisted');
  message({ type: 'clipboardText', text: '0.1, 0.1, 0.2, 0.2' });
  await flush();
  assert(Number(document.getElementById('bboxW').value) === 200 && Number(document.getElementById('bboxH').value) === 200,
    'same ambiguous tuple follows XYWH when checked');
  nameOpenPaste('screen.amb_xywh');
  await flush();

  // Only XYXY is valid because XYWH would exceed the normalized image bounds.
  message({ type: 'clipboardText', text: '0.1, 0.1, 0.9, 0.9' });
  await flush();
  assert(Number(document.getElementById('bboxW').value) === 800 && Number(document.getElementById('bboxH').value) === 800,
    'XYXY-only tuple is auto-detected even while XYWH is preferred');
  document.getElementById('bboxCancel').click();
  await flush();

  // Only XYWH is valid because XYXY would have x2/y2 before x1/y1.
  message({ type: 'clipboardText', text: '0.8, 0.8, 0.1, 0.1' });
  await flush();
  assert(Number(document.getElementById('bboxX').value) === 800 && Number(document.getElementById('bboxY').value) === 800
    && Number(document.getElementById('bboxW').value) === 100 && Number(document.getElementById('bboxH').value) === 100,
    'XYWH-only tuple remains auto-detected while XYWH is preferred');
  document.getElementById('bboxCancel').click();
  await flush();

  // Restore default preference before point-mode copy assertions.
  formatChk.checked = false;
  formatChk.dispatchEvent(new window.Event('change', { bubbles: true }));

  const beforeZeroRect = posts('save').length;
  message({ type: 'clipboardText', text: '0.3, 0.3, 0, 0' });
  await flush();
  assert(posts('save').length === beforeZeroRect, 'zero-size XYWH point is rejected in rect mode');
  assert(/Point mode/i.test(document.getElementById('colorInfo').textContent), 'zero-size rejection explains point-only rule');

  message({
    type: 'load', annotationMode: 'point', imagePath: 'x/a.png', imageBase64: 'data:image/png;base64,FAKE-1000x1000',
    filename: 'a.png', currentIndex: 0, totalImages: 1, allCategories: {},
    annotations: [
      { id: 1, category: 'screen.a', x: 100, y: 100, w: 0, h: 0 },
      { id: 2, category: 'screen.b', x: 500, y: 500, w: 0, h: 0 },
    ],
  });
  await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.a","bbox":[0.4,0.5,0,0]}' });
  await flush();
  save = last('save');
  assert(save.annotations.some(a => a.category === 'screen.a2' && a.x === 400 && a.y === 500 && a.w === 0 && a.h === 0),
    'point duplicate is renamed inside point namespace and remains zero-size');

  mouse('mousedown', 160, 60); mouse('mouseup', 160, 60);
  mouse('mousedown', 400, 300, { ctrlKey: true }); mouse('mouseup', 400, 300, { ctrlKey: true });
  key('c', { ctrlKey: true });
  assert(last('copyText').text === '0.1000, 0.1000, 0.5000, 0.5000', 'multi-point copy follows default XYXY preference');

  const beforeAreaPoint = posts('save').length;
  message({ type: 'clipboardText', text: '{"name":"screen.centered","bbox":[0.4,0.4,0.2,0.1]}' });
  await flush();
  save = last('save');
  assert(posts('save').length === beforeAreaPoint + 1, 'named box paste is accepted in point mode');
  assert(save.annotations.some(a => a.category === 'screen.centered' && a.x === 500 && a.y === 450 && a.w === 0 && a.h === 0),
    'point mode projects explicit XYWH bbox to its center');

  // This tuple is only valid as XYWH; point mode therefore projects its center regardless of the XYXY preference.
  const beforeUnnamedAreaPoint = posts('save').length;
  message({ type: 'clipboardText', text: '0.2,0.3,0.2,0.2' });
  await flush();
  assert(document.getElementById('bboxModal').classList.contains('visible'), 'unnamed box paste in point mode still asks for a name');
  assert(posts('save').length === beforeUnnamedAreaPoint, 'unnamed point conversion does not save before naming');
  assert(Number(document.getElementById('bboxX').value) === 300 && Number(document.getElementById('bboxY').value) === 400,
    'XYWH-only box is converted to its center before the naming dialog');
  nameOpenPaste('screen.centered_unnamed');
  await flush();
  save = last('save');
  assert(save.annotations.some(a => a.category === 'screen.centered_unnamed' && a.x === 300 && a.y === 400 && a.w === 0 && a.h === 0),
    'named result of an unnamed box paste is stored as a point at the center');

  console.log('annotation clipboard tests passed');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
