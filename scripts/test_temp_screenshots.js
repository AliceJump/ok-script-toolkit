/**
 * 临时截图侧边栏 Webview 回归测试。
 *
 * 覆盖：
 *  - temps 消息渲染缩略图网格、选中帧
 *  - 0.1s 轮播的定时间隔与帧切换
 *  - 框选复制归一化坐标 x,y,tox,toy（含越界 clamp）
 *  - 拖拽 / 添加到标注管理 / 删除的消息载荷
 *
 * 用 jsdom 跑真实 app.js；由于 jsdom 不做布局与图片解码，
 * 这里对 getBoundingClientRect 与 naturalWidth/Height 做了确定性桩。
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
const componentRoot = path.join(root, 'media', 'tempScreenshots');

const dictionary = {
  tempPaste: 'Paste', tempPasteTooltip: 'Paste tip',
  tempCapture: 'Capture', tempCaptureTooltip: 'Capture tip',
  tempClear: 'Clear', tempClearConfirm: 'Clear all?',
  tempCarousel: 'Cycle 0.1s', tempCarouselTooltip: 'Cycle tip',
  tempCoordMode: 'Box coords', tempCoordTooltip: 'Box tip',
  tempEmpty: 'Empty', tempDelete: 'Delete',
  tempSendToAssets: 'Send', tempDragHint: 'Drag tip',
  tempCoordCopied: 'Copied: {text}', cancel: 'Cancel',
};

let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');
html = html
  .replaceAll('__CSP_NONCE__', 'test')
  .replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary))
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', '')
  .replace('<script src="__APP_SCRIPT_URI__"></script>', `<script>${fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8')}</script>`);

const sent = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => { throw error; });

let capturedInterval = null;
let capturedIntervalFn = null;

const STAGE = { width: 400, height: 300 };

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage: (message) => sent.push(message) });
    // 用确定性桩替换 setInterval，便于断言 0.1s 周期并手动推进帧
    const realSetInterval = window.setInterval.bind(window);
    window.setInterval = (fn, ms) => {
      capturedIntervalFn = fn;
      capturedInterval = ms;
      return realSetInterval(() => { /* 不真正触发，由测试手动推进 */ }, 1000000);
    };
    // jsdom 不解码图片：从 src 中解析 "1920x1080" 之类的尺寸
    for (const prop of ['naturalWidth', 'naturalHeight']) {
      Object.defineProperty(window.HTMLImageElement.prototype, prop, {
        configurable: true,
        get() {
          const src = this.getAttribute('src') || '';
          const m = /(\d+)x(\d+)/.exec(src);
          if (!m) return 0;
          return prop === 'naturalWidth' ? Number(m[1]) : Number(m[2]);
        },
      });
    }
  },
});

const { window } = dom;
const document = window.document;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height,
  });
}

function stubInnerRect() {
  const inner = document.getElementById('stageInner');
  inner.getBoundingClientRect = () => {
    const w = parseFloat(inner.style.width) || 0;
    const h = parseFloat(inner.style.height) || 0;
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\((-?[\d.]+)\)/.exec(inner.style.transform || '');
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    const s = m ? parseFloat(m[3]) : 1;
    return {
      left: tx, top: ty, right: tx + w * s, bottom: ty + h * s,
      width: w * s, height: h * s,
    };
  };
}

function post(type) {
  return sent.filter((m) => m && m.type === type);
}

function lastPost(type) {
  const list = post(type);
  return list[list.length - 1];
}

function mouse(type, target, x, y, button = 0) {
  target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button,
  }));
}

(async function run() {
  await flush();

  const stage = document.getElementById('stage');
  const overlay = document.getElementById('stageOverlay');
  const grid = document.getElementById('grid');
  const carouselBtn = document.getElementById('carouselBtn');
  const coordBtn = document.getElementById('coordBtn');

  stubRect(stage, { left: 0, top: 0, width: STAGE.width, height: STAGE.height });
  stubRect(overlay, { left: 0, top: 0, width: STAGE.width, height: STAGE.height });
  stubInnerRect();

  assert(post('ready').length === 1, 'app.js must announce readiness once');

  /* ---------- 1. 渲染网格 ---------- */
  const temps = [1, 2, 3].map((n) => ({
    id: 'shot_' + n + '.png',
    name: 'shot_' + n + '.png',
    url: 'https://x/preview-1920x1080-' + n + '.png',
    thumbUrl: 'https://x/thumb-96x54-' + n + '.png',
    width: 1920,
    height: 1080,
  }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'temps', items: temps, max: 10 } }));
  await flush();

  const cards = [...grid.querySelectorAll('.card')];
  assert(cards.length === 3, 'grid must render one card per temp screenshot');
  assert(document.getElementById('count').textContent === '3/10', 'count must show n/max');
  assert(grid.style.display !== 'none', 'grid must be visible when temps exist');
  assert(cards[0].draggable === true, 'cards must be draggable');

  const frameEls = [...document.getElementById('stageInner').querySelectorAll('img')];
  assert(frameEls.length === 3, 'one stage frame per temp screenshot');
  assert(frameEls[2].classList.contains('active'), 'last temp must be selected by default');

  /* ---------- 2. 0.1s 轮播 ---------- */
  carouselBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(capturedInterval === 100, 'carousel must tick every 100ms, got ' + capturedInterval);
  assert(carouselBtn.classList.contains('active'), 'carousel button must be active');

  const activeIndex = () => frameEls.findIndex((el) => el.classList.contains('active'));
  const before = activeIndex();
  capturedIntervalFn();
  assert(activeIndex() === (before + 1) % 3, 'carousel must advance to the next frame');
  capturedIntervalFn();
  assert(activeIndex() === (before + 2) % 3, 'carousel must keep advancing');

  carouselBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!carouselBtn.classList.contains('active'), 'clicking again must stop the carousel');

  /* ---------- 3. 框选复制归一化坐标 ---------- */
  cards[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(activeIndex() === 0, 'clicking a card must select its frame');

  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(coordBtn.classList.contains('active'), 'coord button must toggle on');

  // stage 400x300，图 1920x1080 → 适配后 inner = 400x225，垂直居中 top=37.5
  mouse('mousedown', overlay, 100, 82.5);
  mouse('mousemove', window, 300, 187.5);
  mouse('mouseup', window, 300, 187.5);
  await flush();

  const copy = lastPost('copyText');
  assert(copy, 'box-select must post a copyText message');
  assert(copy.text === '0.2500,0.2000,0.7500,0.6667',
    'normalized coords must be x,y,tox,toy with 4 decimals, got ' + copy.text);
  assert(document.getElementById('selBox').classList.contains('visible'),
    'the selection box must stay visible after copying so it can be compared against moving frames');

  /* ---------- 3a. 拖动框体整体移动并重新复制 ---------- */
  // 当前框屏幕矩形 (100,82.5)-(300,187.5)，(200,135) 落在框内
  let copyBefore = post('copyText').length;
  mouse('mousedown', overlay, 200, 135);
  mouse('mousemove', window, 250, 165);
  mouse('mouseup', window, 250, 165);
  await flush();
  assert(post('copyText').length === copyBefore + 1, 'moving the box must copy again');
  assert(lastPost('copyText').text === '0.3750,0.3333,0.8750,0.8000',
    'moved box must copy the updated coords, got ' + lastPost('copyText').text);

  /* ---------- 3b. 拖动手柄缩放并重新复制 ---------- */
  // 移动后框屏幕 (150,112.5)-(350,217.5)，右下角即 br 手柄
  copyBefore = post('copyText').length;
  mouse('mousedown', overlay, 350, 217.5);
  mouse('mousemove', window, 390, 247.5);
  mouse('mouseup', window, 390, 247.5);
  await flush();
  assert(post('copyText').length === copyBefore + 1, 'resizing the box must copy again');
  assert(lastPost('copyText').text === '0.3750,0.3333,0.9750,0.9333',
    'resized box must copy the updated coords, got ' + lastPost('copyText').text);

  /* ---------- 3c. 点击非交互部分清除坐标框 ---------- */
  // (30, 30) 在框与所有手柄之外
  copyBefore = post('copyText').length;
  mouse('mousedown', overlay, 30, 30);
  mouse('mouseup', window, 30, 30);
  await flush();
  assert(post('copyText').length === copyBefore,
    'clicking empty area must clear the box without copying');
  assert(!document.getElementById('selBox').classList.contains('visible'),
    'the box must disappear after clicking empty area');

  // 越界框选必须 clamp 到 0..1（放在清除之后，避免复用上一次留下的框）
  mouse('mousedown', overlay, -50, -50);
  mouse('mousemove', window, 900, 900);
  mouse('mouseup', window, 900, 900);
  await flush();
  assert(lastPost('copyText').text === '0.0000,0.0000,1.0000,1.0000',
    'out-of-range selection must clamp to 0..1, got ' + lastPost('copyText').text);

  // 误触（极小框）不应产生复制
  const copyCount = post('copyText').length;
  mouse('mousedown', overlay, 200, 150);
  mouse('mouseup', window, 200, 150);
  await flush();
  assert(post('copyText').length === copyCount, 'a degenerate box must not copy coordinates');

  /* ---------- 3d. 轮播与框选相互独立 ---------- */
  // 上一个越界用例留下的是「全图框」，此时图上没有空白可点，
  // 用退出 / 重进坐标模式来清除它
  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(coordBtn.classList.contains('active'), 'coord mode must be re-entered');
  assert(!document.getElementById('selBox').classList.contains('visible'),
    're-entering coord mode must start with no box');

  carouselBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(carouselBtn.classList.contains('active'), 'carousel must start for the independence check');
  const frameBeforeBox = activeIndex();

  mouse('mousedown', overlay, 120, 90);
  mouse('mousemove', window, 320, 195);
  assert(carouselBtn.classList.contains('active'),
    'starting a box-selection must NOT stop the carousel');
  capturedIntervalFn();
  assert(activeIndex() === (frameBeforeBox + 1) % 3,
    'the carousel must keep advancing frames while box-selecting');

  mouse('mouseup', window, 320, 195);
  await flush();
  assert(carouselBtn.classList.contains('active'),
    'the carousel must still be running after the box-selection completes');
  assert(lastPost('copyText').text === '0.3000,0.2333,0.8000,0.7000',
    'coords taken against a cycling frame must still normalize correctly, got ' + lastPost('copyText').text);

  carouselBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!carouselBtn.classList.contains('active'), 'carousel must stop when toggled off');

  coordBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!coordBtn.classList.contains('active'), 'coord button must toggle off');
  assert(!document.getElementById('selBox').classList.contains('visible'),
    'leaving coord mode must clear the retained selection box');

  /* ---------- 4. 拖拽 / 发送 / 删除 ---------- */
  const dragEv = new window.Event('dragstart', { bubbles: true, cancelable: true });
  dragEv.dataTransfer = {
    effectAllowed: '',
    setData(type, value) { this.payload = this.payload || {}; this.payload[type] = value; },
  };
  cards[1].dispatchEvent(dragEv);
  assert(dragEv.dataTransfer.payload['application/x-ok-temp-screenshot'] === '{"id":"shot_2.png"}',
    'dragstart must expose the temp id through the custom MIME');
  const dragStart = lastPost('dragStart');
  assert(dragStart && dragStart.id === 'shot_2.png', 'dragstart must notify the host with the temp id');
  cards[1].dispatchEvent(new window.Event('dragend', { bubbles: true }));
  assert(post('dragEnd').length === 1, 'dragend must notify the host');

  cards[0].querySelector('.actions button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(lastPost('sendToAssets').id === 'shot_1.png', 'send button must post sendToAssets with the temp id');

  const delButtons = cards[0].querySelectorAll('.actions button');
  delButtons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(lastPost('deleteTemp').id === 'shot_1.png', 'delete button must post deleteTemp with the temp id');

  /* ---------- 5. 清空需二次确认 ---------- */
  const clearBtn = document.getElementById('clearBtn');
  clearBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(post('clearAll').length === 0, 'clear must wait for confirmation');
  assert(document.getElementById('confirmBar').classList.contains('visible'), 'confirm bar must be shown');
  document.getElementById('confirmOk').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(post('clearAll').length === 1, 'confirming must post clearAll');

  /* ---------- 6. 清空后回到空态 ---------- */
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'temps', items: [], max: 10 } }));
  await flush();
  assert(document.getElementById('emptyHint').style.display === 'flex', 'empty hint must show when no temps');
  assert(grid.querySelectorAll('.card').length === 0, 'grid must be cleared');

  console.log('test_temp_screenshots: OK');
})().catch((error) => {
  console.error('test_temp_screenshots: FAILED');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
