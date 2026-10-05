#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
let jsdom;
try { jsdom = require('jsdom'); } catch {
  const root = process.env.OK_LANG_HINTS_JSDOM_ROOT || path.join(os.tmpdir(), 'ok-script-toolkit-jsdom');
  jsdom = require(path.join(root, 'node_modules', 'jsdom'));
}
const { JSDOM, VirtualConsole } = jsdom;
const root = path.resolve(__dirname, '..');
const componentRoot = path.join(root, 'media', 'templateAssetPanel');
const dictionary = {
  templateAssetsTitle: 'Template Assets', templatesSearch: 'Search...', assetImport: 'Import', screenshot: 'Screenshot',
  hardForeground: 'Hard foreground', hardForegroundHint: 'Hard foreground hint', publish: 'Publish', openSourceImage: 'Open source',
  assetDeleteTooltip: 'Delete', assetSwapTooltip: 'Swap annotations', assetSwapTitle: 'Swap annotations',
  assetSwapHint: 'Pick target', assetSwapEmpty: 'No other image', assetSwapBoxes: '{count} boxes', assetSwapNoBoxes: 'No annotations',
  cancel: 'Cancel', loadFailed: 'Failed', assetNoMatch: 'No match', noTemplatesWithHint: 'No templates', assetDropHint: 'Drop',
};
let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');
html = html.replaceAll('__CSP_NONCE__', 'test').replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary)).replaceAll('__SHARED_TOKENS_URI__', '').replaceAll('__SHARED_CONTROLS_URI__', '')
  .replace('<script src="__SHARED_THUMBNAIL_ACTIONS_URI__"></script>', `<script>${fs.readFileSync(path.join(root, 'media/shared/thumbnailActions.js'), 'utf8')}</script>`)
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', '')
  .replace('<script src="__APP_SCRIPT_URI__"></script>', `<script>${fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8')}</script>`);
const templates = [
  { name:'1.png', imagePath:'C:/p/1.png', width:1920, height:1080, categories:['a'], annotations:1 },
  { name:'2.png', imagePath:'C:/p/2.png', width:800, height:600, categories:[], annotations:0 },
  { name:'3.png', imagePath:'C:/p/3.png', width:1280, height:720, categories:['b','c'], annotations:2 },
];
function makeDom() {
  const sent = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => { throw e; });
  const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc, beforeParse(w) {
    w.acquireVsCodeApi = () => ({ postMessage:m => sent.push(JSON.parse(JSON.stringify(m))), getState:()=>({}), setState(){} });
  }});
  return { dom, w:dom.window, sent };
}
const send = (w, data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
const flush = w => new Promise(r => w.setTimeout(r, 0));
(async () => {
  const { dom, w, sent } = makeDom(); const d = w.document; await flush(w);
  send(w, { type:'templates', templates }); await flush(w);
  const card = name => d.querySelector(`.card[data-name="${name}"]`);
  assert.strictEqual(card('1.png').querySelectorAll('.actions button').length, 3, 'cards expose open/swap/delete only');
  assert.strictEqual(card('1.png').querySelector('[data-action="edit"]'), null, 'edit button is removed');
  card('1.png').dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
  assert.deepStrictEqual(sent.at(-1), { type:'openAnnotation', imagePath:'C:/p/1.png' });
  card('1.png').querySelector('[data-action="open"]').click();
  assert.deepStrictEqual(sent.at(-1), { type:'openSource', imagePath:'C:/p/1.png' });

  card('1.png').querySelector('[data-action="swap"]').click(); await flush(w);
  const items = [...d.querySelectorAll('#swapList .swap-item')];
  assert.deepStrictEqual(items.map(x => x.querySelector('.swap-name').textContent).sort(), ['2.png','3.png']);
  const req = sent.filter(x => x.type === 'requestThumbs').at(-1);
  assert.deepStrictEqual(new Set(req.imagePaths), new Set(['C:/p/2.png','C:/p/3.png']));

  send(w, { type:'thumbs', items:[{ name:'3.png', url:'data:image/png;base64,AAA' }] }); await flush(w);
  const gridImg = card('3.png').querySelector('.thumb-box img');
  const pickerImg = [...d.querySelectorAll('#swapList .swap-item')].find(x => x.querySelector('.swap-name').textContent === '3.png').querySelector('.swap-thumb img');
  assert(gridImg && pickerImg, 'late thumbnail populates grid and open picker');
  send(w, { type:'thumbs', items:[{ name:'3.png', url:'data:image/png;base64,BBB' }] }); await flush(w);
  assert.strictEqual(card('3.png').querySelectorAll('.thumb-box img').length, 1);
  assert(gridImg.src.includes('BBB') && pickerImg.src.includes('BBB'), 'new content updates existing img nodes');

  d.getElementById('swapCancel').click();
  const oldCard = card('3.png'); const oldImg = gridImg;
  const changed = templates.map(x => x.name === '3.png' ? { ...x, categories:['b','c','new'], annotations:3 } : { ...x });
  send(w, { type:'templates', templates:changed }); await flush(w);
  assert.strictEqual(card('3.png'), oldCard, 'metadata refresh preserves card DOM');
  assert.strictEqual(card('3.png').querySelector('.thumb-box img'), oldImg, 'metadata refresh preserves decoded thumbnail');
  assert(card('3.png').querySelector('.cats').textContent.includes('new'));

  card('1.png').querySelector('[data-action="swap"]').click(); await flush(w);
  const target = [...d.querySelectorAll('#swapList .swap-item')].find(x => x.querySelector('.swap-name').textContent === '2.png');
  target.click(); await flush(w);
  assert.deepStrictEqual(sent.filter(x => x.type === 'swapAnnotations').at(-1), { type:'swapAnnotations', imagePath:'C:/p/1.png', targetPath:'C:/p/2.png' });

  const solo = makeDom(); await flush(solo.w); send(solo.w, { type:'templates', templates:[templates[0]] }); await flush(solo.w);
  solo.w.document.querySelector('[data-action="swap"]').click(); await flush(solo.w);
  assert.strictEqual(solo.w.document.querySelector('#swapList .swap-empty').textContent, dictionary.assetSwapEmpty);
  dom.window.close(); solo.dom.window.close();
  console.log('asset swap picker tests passed');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
