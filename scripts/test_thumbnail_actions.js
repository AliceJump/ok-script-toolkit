/** Run both gallery scripts and asset cards to verify their shared interaction contract. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let jsdom;
try { jsdom = require('jsdom'); } catch {
  const jsdomRoot = process.env.OK_LANG_HINTS_JSDOM_ROOT || path.join(process.env.TEMP, 'ok-script-toolkit-jsdom');
  jsdom = require(path.join(jsdomRoot, 'node_modules', 'jsdom'));
}
const { JSDOM } = jsdom;
const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'media/shared/thumbnailActions.js'), 'utf8');

function gallery(panel, message) {
  const html = fs.readFileSync(path.join(root, 'media', panel, 'index.html'), 'utf8')
    .replaceAll('__I18N_JSON__', '{}').replaceAll('__MODE__', 'gallery');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  const sent = [];
  const timers = new Map();
  let nextTimer = 0;
  w.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  w.clearTimeout = id => timers.delete(id);
  w.acquireVsCodeApi = () => ({ postMessage: data => sent.push(JSON.parse(JSON.stringify(data))), getState: () => ({}), setState() {} });
  w.eval(shared);
  w.eval(fs.readFileSync(path.join(root, 'media', panel, 'app.js'), 'utf8'));
  w.dispatchEvent(new w.MessageEvent('message', { data: message }));
  sent.length = 0;
  return { dom, w, sent, flush: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

for (const panel of ['templatePanel', 'boxPanel']) {
  const message = panel === 'templatePanel'
    ? { type: 'templates', templates: [{ name: 'button', width: 20, height: 30, bbox: [1, 2, 20, 30], imagePath: 'source.png' }] }
    : { type: 'rows', rows: [{ id: 'screen.button', label: 'self.pos.screen.button.to_box()', bbox: [1, 2, 20, 30], imagePath: 'source.png' }] };
  const { dom, w, sent, flush } = gallery(panel, message);
  const card = w.document.querySelector('.card');
  const buttons = [...card.querySelectorAll('.thumbnail-actions button')];
  assert.strictEqual(buttons.length, 3, `${panel} exposes insert, copy and view`);
  assert(buttons.every(button => button.title && button.getAttribute('aria-label') === button.title));
  const click = detail => card.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail }));
  click(1);
  flush();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(panel === 'templatePanel' ? sent[0].type : sent[0].clicks, panel === 'templatePanel' ? 'insert' : 1);
  sent.length = 0;
  click(1); click(2); click(3);
  card.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  flush();
  assert.strictEqual(sent.length, 1, 'double-click never inserts before copying');
  assert.strictEqual(panel === 'templatePanel' ? sent[0].type : sent[0].clicks, panel === 'templatePanel' ? 'copy' : 2);
  sent.length = 0;
  // Some systems still emit a native double-click after our gesture window expired.
  // That second click must use the same commit window, never insert and then copy.
  click(1); flush();
  click(2);
  card.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  flush();
  assert.strictEqual(sent.length, 2, 'expired clicks commit as independent single gestures');
  assert(sent.every(message => panel === 'templatePanel' ? message.type === 'insert' : message.clicks === 1),
    'a late native dblclick cannot copy an already committed gesture');
  sent.length = 0;
  click(1); buttons[2].click();
  buttons[2].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  flush();
  assert.strictEqual(sent.length, 1, 'source button cancels pending insertion and never copies the card');
  assert.strictEqual(sent[0].type, 'open');
  sent.length = 0;
  click(1); flush();
  assert.strictEqual(sent.length, 1, 'a direct button clears pending gesture state');
  if (panel === 'boxPanel') {
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'thumbs', items: [{ id: 'screen.button', url: 'preview.png' }] } }));
    assert.strictEqual(card.querySelectorAll('.thumbnail-actions button').length, 3, 'loading a box image preserves actions');
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'rows', rows: [{ id: 'screen.runtime', label: 'to_box()' }] } }));
    const open = w.document.querySelectorAll('.thumbnail-actions button')[2];
    assert(open.disabled);
    sent.length = 0; open.click(); assert.strictEqual(sent.length, 0);
  }
  dom.window.close();
}

const { dom, w, sent } = gallery('templateAssetPanel', { type: 'templates', templates: [{
  name: 'source.png', imagePath: 'source.png', width: 20, height: 30, categories: [], annotations: 0,
}] });
const card = w.document.querySelector('.card');
assert.strictEqual(card.querySelectorAll('.thumbnail-actions button').length, 4);
card.querySelector('[data-action="edit"]').click();
assert.deepStrictEqual(sent.pop(), { type: 'openAnnotation', imagePath: 'source.png' });
card.querySelector('[data-action="open"]').click();
assert.deepStrictEqual(sent.pop(), { type: 'openSource', imagePath: 'source.png' });
assert.strictEqual(sent.length, 0, 'direct asset actions never trigger a second card action');
dom.window.close();
console.log('thumbnail action parity: buttons, single/double clicks, isolation and source-less state OK');
