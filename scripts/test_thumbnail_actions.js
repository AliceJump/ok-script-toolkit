/** Run the unified resource preview and asset cards to verify their shared interaction contract. */
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
const icons = fs.readFileSync(path.join(root, 'media/shared/icons.js'), 'utf8');

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
  w.eval(icons);
  w.eval(shared);
  w.eval(fs.readFileSync(path.join(root, 'media', panel, 'app.js'), 'utf8'));
  w.dispatchEvent(new w.MessageEvent('message', { data: message }));
  sent.length = 0;
  return { dom, w, sent, flush: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

const previewCases = [
  {
    mode: 'template',
    resource: {
      name: 'button', width: 20, height: 30, bbox: [1, 2, 20, 30], imagePath: 'source.png',
      kind: 'template', expression: 'fL.button',
    },
  },
  {
    mode: 'rect',
    resource: {
      name: 'screen.button', width: 20, height: 30, bbox: [1, 2, 10, 12], imagePath: 'source.png',
      kind: 'rect', expression: 'self.pos.screen.button.to_box()',
    },
  },
  {
    mode: 'point',
    resource: {
      name: 'screen.anchor', width: 20, height: 30, bbox: [2, 3, 8, 8], imagePath: 'source.png',
      kind: 'point', expression: 'self.pos.screen.anchor',
    },
  },
];

for (const { mode, resource } of previewCases) {
  const { dom, w, sent, flush } = gallery('templatePanel', {
    type: 'resources', mode, resources: [resource],
  });
  const card = w.document.querySelector('.card');
  const buttons = [...card.querySelectorAll('.thumbnail-actions button')];
  assert.strictEqual(buttons.length, 3, `${mode} preview exposes insert, copy and view`);
  assert(buttons.every(button => button.title && button.getAttribute('aria-label') === button.title));

  const grid = w.document.getElementById('grid');
  assert.strictEqual(grid.getAttribute('role'), 'listbox', 'resource grid is a listbox');
  assert.strictEqual(card.getAttribute('role'), 'option', 'cards are listbox options');
  assert.strictEqual(card.tabIndex, 0, 'the only card is the keyboard entry point');

  const key = (k, extra = {}) => card.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
  // 单击 = 选中，无副作用（不再有 500ms 延迟插入）
  card.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  flush();
  assert.strictEqual(sent.length, 0, 'single click only selects');
  assert(card.classList.contains('is-selected') && card.getAttribute('aria-selected') === 'true', 'single click selects the card');

  // 双击 / Enter = 插入
  card.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.deepStrictEqual(sent.splice(0), [{ type: 'insert', expression: resource.expression }], 'double-click inserts');
  key('Enter');
  assert.deepStrictEqual(sent.splice(0), [{ type: 'insert', expression: resource.expression }], 'Enter inserts');
  // Ctrl+C = 复制
  key('c', { ctrlKey: true });
  assert.deepStrictEqual(sent.splice(0), [{ type: 'copy', expression: resource.expression }], 'Ctrl+C copies the reference');
  key('Delete');
  assert.strictEqual(sent.length, 0, 'resource preview has no delete gesture');

  // 卡内按钮只做自己的事，不触发卡片手势
  buttons[2].click();
  buttons[2].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.strictEqual(sent.length, 1, 'source button never triggers the card gesture');
  assert.strictEqual(sent[0].type, 'open');
  sent.length = 0;
  buttons[1].click();
  assert.deepStrictEqual(sent.splice(0), [{ type: 'copy', expression: resource.expression }]);
  dom.window.close();
}

const { dom, w, sent } = gallery('templateAssetPanel', { type: 'templates', templates: [{
  name: 'source.png', imagePath: 'source.png', width: 20, height: 30, categories: [], annotations: 0,
}] });
const card = w.document.querySelector('.card');
assert.strictEqual(card.querySelectorAll('.thumbnail-actions button').length, 3, 'asset card exposes only source, swap and delete actions');
assert.strictEqual(card.querySelector('[data-action="edit"]'), null, 'clicking the card itself is the annotation edit action');
card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
assert.strictEqual(sent.length, 0, 'single click on an asset card only selects it');
card.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
assert.deepStrictEqual(sent.pop(), { type: 'openAnnotation', imagePath: 'source.png' });
card.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert.deepStrictEqual(sent.pop(), { type: 'openAnnotation', imagePath: 'source.png' });
card.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
assert.deepStrictEqual(sent.pop(), { type: 'openAnnotation', imagePath: 'source.png' });
card.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
assert.deepStrictEqual(sent.pop(), { type: 'deleteImage', imagePath: 'source.png' });
const deleteButton = card.querySelector('[data-action="delete"]');
assert(deleteButton.closest('.thumbnail-actions--danger'), 'delete sits apart from view/swap actions');
assert(!card.querySelector('[data-action="open"]').closest('.thumbnail-actions--danger'), 'view action is not in the danger slot');
card.querySelector('[data-action="open"]').click();
assert.deepStrictEqual(sent.pop(), { type: 'openSource', imagePath: 'source.png' });
assert.strictEqual(sent.length, 0, 'direct asset actions never trigger a second card action');

w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'templates', templates: [{
  name: 'source.png', imagePath: 'source.png', width: 20, height: 30, categories: ['screen.updated'], annotations: 1,
}] } }));
assert.strictEqual(w.document.querySelector('.card'), card, 'annotation refresh preserves the existing source-card DOM node');
assert.strictEqual(card.querySelector('.cats').textContent, 'screen.updated', 'annotation metadata updates in place');

dom.window.close();

// 键盘：方向键 / Home / End 在网格内移动选中，Tab 入口只有一个
{
  const many = ['a.png', 'b.png', 'c.png'].map(name => ({ name, imagePath: name, width: 1, height: 1, categories: [], annotations: 0 }));
  const { dom: d2, w: w2 } = gallery('templateAssetPanel', { type: 'templates', templates: many });
  const cards = [...w2.document.querySelectorAll('.card')];
  assert.deepStrictEqual(cards.map(c => c.tabIndex), [0, -1, -1], 'one roving tab stop');
  const press = (el, k) => el.dispatchEvent(new w2.KeyboardEvent('keydown', { key: k, bubbles: true }));
  press(cards[0], 'ArrowRight');
  assert(cards[1].classList.contains('is-selected') && w2.document.activeElement === cards[1], 'ArrowRight moves to the next card');
  press(cards[1], 'End');
  assert(cards[2].classList.contains('is-selected'), 'End jumps to the last card');
  press(cards[2], 'Home');
  assert(cards[0].classList.contains('is-selected'), 'Home jumps to the first card');
  assert.deepStrictEqual(cards.map(c => c.tabIndex), [0, -1, -1], 'tab stop follows the selection');
  d2.window.close();
}
console.log('thumbnail action parity: unified template/rect/point preview and asset actions OK');
