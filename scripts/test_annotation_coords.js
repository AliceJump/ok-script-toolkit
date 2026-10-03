/**
 * 标注编辑器「框选复制归一化坐标」回归测试。
 *
 * 默认沿用旧习惯 x1,y1,x2,y2；勾选 XYWH 后改为 x,y,w,h。
 */
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
virtualConsole.on('jsdomError', (error) => { throw error; });

const CANVAS_W = 800;
const CANVAS_H = 600;

function makeContext() {
  const noop = () => { };
  return {
    clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop,
    fill: noop, fillText: noop, drawImage: noop, setLineDash: noop,
    moveTo: noop, lineTo: noop, stroke: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
  };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => sent.push(message),
      getState: () => webviewState,
      setState: (state) => { webviewState = state || {}; },
    });

    window.HTMLCanvasElement.prototype.getContext = function () { return makeContext(); };
    for (const prop of ['clientWidth', 'clientHeight']) {
      Object.defineProperty(window.HTMLElement.prototype, prop, {
        configurable: true,
        get() { return prop === 'clientWidth' ? CANVAS_W : CANVAS_H; },
      });
    }

    const srcDesc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src');
    Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
      configurable: true,
      get() { return srcDesc.get.call(this); },
      set(value) {
        srcDesc.set.call(this, value);
        window.setTimeout(() => {
          if (typeof this.onload === 'function') this.onload(new window.Event('load'));
        }, 0);
      },
    });
    for (const prop of ['width', 'height']) {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, prop);
      Object.defineProperty(window.HTMLImageElement.prototype, prop, {
        configurable: true,
        get() {
          const m = /(\d+)x(\d+)/.exec(this.getAttribute('src') || '');
          if (!m) return 0;
          return prop === 'width' ? Number(m[1]) : Number(m[2]);
        },
        set(value) { if (desc && desc.set) desc.set.call(this, value); },
      });
    }
    Object.defineProperty(window.HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get() { return true; },
    });
  },
});

const { window } = dom;
const document = window.document;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

function post(type) { return sent.filter((m) => m && m.type === type); }
function lastPost(type) { const list = post(type); return list[list.length - 1]; }

function mouse(type, target, x, y, button = 0) {
  target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button,
  }));
}

(async function run() {
  await flush();

  const canvas = document.getElementById('canvas');
  const coordBtn = document.getElementById('coordBtn');
  const formatChk = document.getElementById('coordPreferXywhChk');

  assert(post('ready').length === 1, 'app.js must announce readiness once');
  assert(coordBtn.textContent === 'Coords (C)', 'coord button must be localized');
  assert(formatChk && !formatChk.checked, 'XYXY must remain the default coordinate preference');

  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: CANVAS_W, bottom: CANVAS_H, width: CANVAS_W, height: CANVAS_H,
  });

  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'load',
      imagePath: 'x/a.png',
      imageBase64: 'data:image/png;base64,FAKE-1920x1080',
      annotations: [],
      allCategories: {},
      currentIndex: 0,
      totalImages: 1,
      filename: 'a.png',
    },
  }));
  await flush();
  await flush();

  assert(canvas.style.display === 'block', 'image load must reveal the canvas');

  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(coordBtn.classList.contains('active'), 'coord mode must toggle on');

  mouse('mousedown', canvas, 100, 120);
  mouse('mousemove', canvas, 500, 345);
  mouse('mouseup', canvas, 500, 345);
  await flush();

  let copy = lastPost('copyText');
  assert(copy, 'box-select in coord mode must post a copyText message');
  assert(copy.text === '0.1250, 0.1000, 0.6250, 0.6000',
    'default coordinate copy must be x1,y1,x2,y2, got ' + copy.text);
  assert(document.getElementById('colorInfo').textContent.includes('0.1250, 0.1000, 0.6250, 0.6000'),
    'coordinate readout must use the same XYXY preference');

  let before = post('copyText').length;
  mouse('mousedown', canvas, 300, 230);
  mouse('mousemove', canvas, 350, 260);
  mouse('mouseup', canvas, 350, 260);
  await flush();
  assert(post('copyText').length === before + 1, 'moving the box must copy again');
  assert(lastPost('copyText').text === '0.1875, 0.1667, 0.6875, 0.6667',
    'moved box must copy updated XYXY coords, got ' + lastPost('copyText').text);

  before = post('copyText').length;
  mouse('mousedown', canvas, 550, 375);
  mouse('mousemove', canvas, 610, 405);
  mouse('mouseup', canvas, 610, 405);
  await flush();
  assert(post('copyText').length === before + 1, 'resizing the box must copy again');
  assert(lastPost('copyText').text === '0.1875, 0.1667, 0.7625, 0.7334',
    'resized box must copy updated XYXY coords, got ' + lastPost('copyText').text);

  before = post('copyText').length;
  mouse('mousedown', canvas, 700, 520);
  mouse('mouseup', canvas, 700, 520);
  await flush();
  assert(post('copyText').length === before, 'clicking empty area must clear the box without copying');

  mouse('mousedown', canvas, 100, 120);
  mouse('mousemove', canvas, 500, 345);
  mouse('mouseup', canvas, 500, 345);
  await flush();
  assert(lastPost('copyText').text === '0.1250, 0.1000, 0.6250, 0.6000',
    'fresh coord box must still use XYXY by default');

  assert(post('save').length === 0, 'coord box must never be written to annotations/COCO');

  mouse('mousedown', canvas, 700, 520);
  mouse('mouseup', canvas, 700, 520);
  await flush();
  mouse('mousedown', canvas, 500, 345);
  mouse('mousemove', canvas, 100, 120);
  mouse('mouseup', canvas, 100, 120);
  await flush();
  assert(lastPost('copyText').text === '0.1250, 0.1000, 0.6250, 0.6000',
    'reverse drag must normalize to the same XYXY box');

  mouse('mousedown', canvas, -400, -400);
  mouse('mousemove', canvas, 5000, 5000);
  mouse('mouseup', canvas, 5000, 5000);
  await flush();
  assert(lastPost('copyText').text === '0.0000, 0.0000, 1.0000, 1.0000',
    'out-of-range selection must clamp to 0..1');

  // User preference: checked means coordinate copy/readout becomes XYWH.
  formatChk.checked = true;
  formatChk.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(webviewState.coordPreferXywh === true, 'coordinate format preference must persist in webview state');

  mouse('mousedown', canvas, 700, 520);
  mouse('mouseup', canvas, 700, 520);
  await flush();
  mouse('mousedown', canvas, 100, 120);
  mouse('mousemove', canvas, 500, 345);
  mouse('mouseup', canvas, 500, 345);
  await flush();
  copy = lastPost('copyText');
  assert(copy.text === '0.1250, 0.1000, 0.5000, 0.5000',
    'checked coordinate preference must emit XYWH, got ' + copy.text);
  assert(document.getElementById('colorInfo').textContent.includes('0.1250, 0.1000, 0.5000, 0.5000'),
    'coordinate readout must switch to XYWH with the checkbox');

  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!coordBtn.classList.contains('active'), 'coord button must toggle off');
  assert(window.document.getElementById('colorInfo').textContent.trim() === '',
    'leaving coord mode must clear the readout');

  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const count = post('copyText').length;
  mouse('mousedown', canvas, 300, 300);
  mouse('mouseup', canvas, 300, 300);
  await flush();
  assert(post('copyText').length === count, 'a degenerate box must not copy coordinates');

  console.log('test_annotation_coords: OK');
})().catch((error) => {
  console.error('test_annotation_coords: FAILED');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
