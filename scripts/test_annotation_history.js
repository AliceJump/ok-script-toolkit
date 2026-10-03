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
const dictionary = new Proxy({}, { get: (_, key) => String(key) });
let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');
html = html
  .replaceAll('__CSP_NONCE__', 'test')
  .replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary))
  .replace('<link rel="stylesheet" href="__SHARED_TOKENS_URI__">', '')
  .replace('<link rel="stylesheet" href="__SHARED_CONTROLS_URI__">', '')
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', '')
  .replace('<script src="__APP_SCRIPT_URI__"></script>', `<script>${fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8')}</script>`);

const sent = [];
let webviewState = {};
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { throw error; });

function makeContext() {
  const noop = () => {};
  return {
    clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
    arc: noop, fill: noop, fillText: noop, drawImage: noop, setLineDash: noop,
    moveTo: noop, lineTo: noop, stroke: noop, save: noop, restore: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    measureText: () => ({ width: 0 }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
  };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
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
          const match = /(\d+)x(\d+)/.exec(this.getAttribute('src') || '');
          return match ? Number(prop === 'width' ? match[1] : match[2]) : 0;
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
const writes = () => sent.filter(item => item?.type === 'save' || item?.type === 'saveMode');
function message(data) { window.dispatchEvent(new window.MessageEvent('message', { data })); }
function key(keyValue, init = {}) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyValue, ...init }));
}
function load(mode, annotations) {
  message({
    type: 'load', annotationMode: mode, imagePath: 'x/a.png', imageBase64: 'data:image/png;base64,FAKE-1000x1000',
    filename: 'a.png', currentIndex: 0, totalImages: 1, allCategories: {}, annotations,
  });
}

(async () => {
  await flush();
  message({
    type: 'config', annotationMode: 'rect', boxPathRule: { segment: '^[A-Za-z_][A-Za-z0-9_]*$' },
    keybindings: {
      copy: 'ctrl+c', paste: 'ctrl+v', modeTemplate: '1', modeRect: '2', modePoint: '3',
      undo: 'ctrl+z', redo: 'ctrl+y', drawBbox: 'r', copyCoords: 'c', deleteMode: 'd',
      deleteSelected: 'Delete', prevImage: 'ArrowLeft', nextImage: 'ArrowRight',
    },
  });

  // Build one transaction in Rect and one in Point by driving the real clipboard handler.
  load('rect', []);
  await flush(); await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.rect_one","bbox":[0.1,0.1,0.2,0.2]}' });
  await flush();
  const rectOne = last('save').annotations;
  assert(rectOne.length === 1 && rectOne[0].category === 'screen.rect_one', 'rect paste creates a real editor transaction');

  load('point', []);
  await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.point_one","bbox":[0.5,0.5,0,0]}' });
  await flush();
  const pointOne = last('save').annotations;
  assert(pointOne.length === 1 && pointOne[0].w === 0 && pointOne[0].h === 0, 'point paste creates a real editor transaction');

  // Shared history is default: undo follows actual chronology even across inactive modes.
  key('z', { ctrlKey: true });
  await flush();
  let saveMode = last('saveMode');
  assert(saveMode.mode === 'point' && saveMode.annotations.length === 0, 'shared undo removes the latest point transaction first');
  key('z', { ctrlKey: true });
  await flush();
  saveMode = last('saveMode');
  assert(saveMode.mode === 'rect' && saveMode.annotations.length === 0, 'shared undo then crosses modes to the rect transaction');

  key('y', { ctrlKey: true });
  await flush();
  saveMode = last('saveMode');
  assert(saveMode.mode === 'rect' && saveMode.annotations.length === 1, 'shared redo restores rect in reverse-undo order');
  key('y', { ctrlKey: true });
  await flush();
  saveMode = last('saveMode');
  assert(saveMode.mode === 'point' && saveMode.annotations.length === 1, 'shared redo restores point without applying any transaction twice');

  // Independent mode: only the current mode's history is eligible.
  const shared = document.getElementById('sharedHistoryChk');
  shared.checked = false;
  shared.dispatchEvent(new window.Event('change', { bubbles: true }));

  load('rect', rectOne);
  await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.rect_two","bbox":[0.4,0.4,0.1,0.1]}' });
  await flush();
  const rectTwo = last('save').annotations;
  assert(rectTwo.length === 2, 'second rect transaction created');

  load('point', pointOne);
  await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.point_two","bbox":[0.7,0.7,0,0]}' });
  await flush();
  key('z', { ctrlKey: true });
  await flush();
  saveMode = last('saveMode');
  assert(saveMode.mode === 'point' && saveMode.annotations.length === 1, 'independent undo stays inside Point');

  load('rect', rectTwo);
  await flush();
  key('z', { ctrlKey: true });
  await flush();
  saveMode = last('saveMode');
  assert(saveMode.mode === 'rect' && saveMode.annotations.length === 1, 'independent undo stays inside Rect');

  // Mode-switch barrier: after requesting Point, old Rect data cannot be edited/saved while the
  // host is still asynchronously loading Point. A stale Rect response must not unlock editing.
  load('rect', rectOne);
  await flush();
  const beforeSwitchWrites = writes().length;
  document.getElementById('pointModeBtn').click();
  assert(last('switchAnnotationMode').mode === 'point', 'point mode request is posted to host');
  message({ type: 'clipboardText', text: '{"name":"screen.blocked","bbox":[0.2,0.2,0,0]}' });
  await flush();
  assert(writes().length === beforeSwitchWrites, 'paste is blocked while requested mode is loading');

  load('rect', rectOne); // stale response for the previous mode
  await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.still_blocked","bbox":[0.2,0.2,0,0]}' });
  await flush();
  assert(writes().length === beforeSwitchWrites, 'stale load is ignored and does not unlock editing');

  load('point', pointOne); // matching response unlocks the editor
  await flush();
  message({ type: 'clipboardText', text: '{"name":"screen.after_load","bbox":[0.2,0.2,0,0]}' });
  await flush();
  assert(writes().length === beforeSwitchWrites + 1, 'matching mode load unlocks editing exactly once');
  assert(last('save').annotations.some(item => item.category === 'screen.after_load'), 'post-load point paste is saved in Point mode');

  console.log('annotation history runtime tests passed');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
