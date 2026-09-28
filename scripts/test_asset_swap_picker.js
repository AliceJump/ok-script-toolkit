#!/usr/bin/env node
/**
 * 素材面板「交换标注」入口的回归测试（`media/templateAssetPanel/app.js`）。
 *
 * 覆盖的是**入口本身**：卡片上的 ⇄ 按钮能不能打开目标选择器、选择器里有没有自己、
 * 选中之后发给宿主的那条消息**带没带对路径**。
 *
 * 为什么值得单独测：这条消息是宿主唯一的输入，而宿主对"路径缺失/与自己相同"
 * 一律**静默 return**（`handleSwapAnnotations` 的首行守卫）。也就是说 webview 一旦
 * 把 `targetPath` 发成 undefined 或者发出自己，界面上什么都不会发生、也不会报错 ——
 * 典型的"看起来点了没反应"，靠人肉点一遍很难稳定复现。
 *
 * 与 `test_annotation_coords.js` 一样用 jsdom 直接跑真实 app.js（不另写一份逻辑），
 * 所以这里不需要 canvas 桩：素材面板不画图。
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
const componentRoot = path.join(root, 'media', 'templateAssetPanel');

const dictionary = {
  templateAssetsTitle: 'Template Assets',
  templatesSearch: 'Search...',
  assetImport: 'Import',
  screenshot: 'Screenshot',
  hardForeground: 'Hard foreground',
  hardForegroundHint: 'Hard foreground hint',
  saveToAssetsTitle: 'Save to assets',
  assetDeleteTooltip: 'Delete',
  assetSwapTooltip: 'Swap annotations with another image',
  assetSwapTitle: 'Swap annotations',
  assetSwapHint: 'Pick the image to swap annotations with',
  assetSwapEmpty: 'No other image to swap with',
  assetSwapBoxes: '{count} boxes',
  assetSwapNoBoxes: 'No annotations',
  cancel: 'Cancel',
  loadFailed: 'Failed to load',
  assetNoMatch: 'No match',
  noTemplatesWithHint: 'No templates found.',
  assetDropHint: 'Release to import into ok_templates',
};

let html = fs.readFileSync(path.join(componentRoot, 'index.html'), 'utf8');
html = html
  .replaceAll('__CSP_NONCE__', 'test')
  .replaceAll('__CSP_SOURCE__', "'self'")
  .replaceAll('__I18N_JSON__', JSON.stringify(dictionary))
  .replaceAll('__SHARED_TOKENS_URI__', '')
  .replaceAll('__SHARED_CONTROLS_URI__', '')
  .replace('<link rel="stylesheet" href="__STYLE_URI__">', '')
  .replace('<script src="__APP_SCRIPT_URI__"></script>', `<script>${fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8')}</script>`);

const sent = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => { throw error; });

function makeDom(source) {
  const page = source === undefined ? html : html.replace(
    fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8'),
    source,
  );
  return new JSDOM(page, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => sent.push(message),
        getState: () => undefined,
        setState: () => { },
      });
    },
  });
}

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

const TEMPLATES = [
  { name: '1.png', imagePath: 'C:/proj/ok_templates/1.png', width: 1920, height: 1080, categories: ['confirm'], annotations: 1 },
  { name: '2.png', imagePath: 'C:/proj/ok_templates/2.png', width: 800, height: 600, categories: [], annotations: 0 },
  { name: '3.png', imagePath: 'C:/proj/ok_templates/3.png', width: 1280, height: 720, categories: ['back', 'home'], annotations: 2 },
];

(async function run() {
  const dom = makeDom();
  const { window } = dom;
  const document = window.document;
  const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));
  await flush();

  const cards = [...document.querySelectorAll('.card')];
  check(cards.length === 0, '还没收到模板列表时没有卡片');

  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'templates', templates: TEMPLATES } }));
  await flush();

  /* ── 1. 卡片上的入口 ─────────────────────────────────────────── */
  console.log('卡片入口');
  const cardOf = (name) => document.querySelector(`.card[data-name="${name}"]`);
  check(document.querySelectorAll('.card').length === 3, '三张图各一张卡片');
  check(
    !!cardOf('1.png') && cardOf('1.png').querySelectorAll('.actions button').length === 2,
    '卡片操作区有 2 个按钮（⇄ 交换 + X 删除）',
  );
  const swapBtn = cardOf('1.png').querySelectorAll('.actions button')[0];
  check(swapBtn.textContent === '⇄', `第一个按钮是交换（实际 "${swapBtn.textContent}"）`);
  check(swapBtn.title === dictionary.assetSwapTooltip, '交换按钮的 tooltip 走文案字典');

  /* ── 2. 打开选择器：排除自己、显示尺寸与标注数 ───────────────── */
  console.log('目标选择器');
  const modal = document.getElementById('swapModal');
  check(!modal.classList.contains('visible'), '初始时选择器是关闭的');

  swapBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  check(modal.classList.contains('visible'), '点 ⇄ 后选择器打开');
  check(document.getElementById('swapTitle').textContent === dictionary.assetSwapTitle, '标题走文案字典');

  const items = [...document.querySelectorAll('#swapList .swap-item')];
  check(items.length === 2, `列表里是"除自己以外"的 2 张图（实际 ${items.length}）`);
  const names = items.map((it) => it.querySelector('.swap-name').textContent);
  check(!names.includes('1.png'), `列表里不含自己（实际 ${names.join(', ')}）`);
  check(names.includes('2.png') && names.includes('3.png'), '另外两张都在列表里');

  const metaOf = (name) => items[names.indexOf(name)].querySelector('.swap-meta').textContent;
  check(metaOf('3.png').includes('1280x720'), `列表项显示尺寸（实际 "${metaOf('3.png')}"）`);
  check(metaOf('3.png').includes('2 boxes'), `列表项显示标注数（实际 "${metaOf('3.png')}"）`);
  check(metaOf('2.png').includes(dictionary.assetSwapNoBoxes), '无标注的图显示"无标注"而不是"0 boxes"');

  /* ── 3. 选中目标：发出去的消息必须带全两个路径 ───────────────── */
  console.log('选中目标');
  const target = items[names.indexOf('2.png')];
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  const swaps = sent.filter((m) => m && m.type === 'swapAnnotations');
  check(swaps.length === 1, `恰好发出一条交换消息（实际 ${swaps.length}）`);
  const msg = swaps[0] || {};
  check(msg.imagePath === 'C:/proj/ok_templates/1.png', `imagePath 是被交换的那张（实际 ${JSON.stringify(msg.imagePath)}）`);
  check(msg.targetPath === 'C:/proj/ok_templates/2.png', `targetPath 是选中的目标（实际 ${JSON.stringify(msg.targetPath)}）`);
  check(
    typeof msg.imagePath === 'string' && typeof msg.targetPath === 'string' && msg.imagePath !== msg.targetPath,
    '两个路径都是字符串且不相同 —— 宿主对"缺失/与自己相同"是静默 return，发错了就是"点了没反应"',
  );
  check(!modal.classList.contains('visible'), '选完即关闭选择器');

  /* ── 4. 关闭方式：取消 / 遮罩 / Esc ───────────────────────────── */
  console.log('关闭方式');
  swapBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  document.getElementById('swapCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  check(!modal.classList.contains('visible'), '点取消关闭');
  check(sent.filter((m) => m && m.type === 'swapAnnotations').length === 1, '取消不会发出交换消息');

  swapBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  modal.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await flush();
  check(!modal.classList.contains('visible'), '点遮罩关闭');

  swapBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  check(!modal.classList.contains('visible'), 'Esc 关闭');

  /* ── 5. 只有一张图时给出空态 ─────────────────────────────────── */
  console.log('只有一张图');
  const solo = makeDom();
  await new Promise((resolve) => solo.window.setTimeout(resolve, 0));
  solo.window.dispatchEvent(new solo.window.MessageEvent('message', {
    data: { type: 'templates', templates: [TEMPLATES[0]] },
  }));
  await new Promise((resolve) => solo.window.setTimeout(resolve, 0));
  solo.window.document.querySelector('.card .actions button')
    .dispatchEvent(new solo.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => solo.window.setTimeout(resolve, 0));
  check(
    solo.window.document.getElementById('swapModal').classList.contains('visible'),
    '只有一张图时也能打开（用来给出"没有其他图片"的说明）',
  );
  check(
    solo.window.document.querySelector('#swapList .swap-empty')?.textContent === dictionary.assetSwapEmpty,
    '空态文案走文案字典',
  );

  /* ── 6. 缩略图：缺的要现要，后补的要能填进已经打开的列表 ─────────
     背景：网格的缩略图是宿主**分批异步**推来的，而选择器的列表只在打开那一刻渲染一次。
     用户完全可能在这一轮推完之前就点开 ⇄ —— 那时缺的那几张会永远停在占位符上，
     只有关掉再打开才"碰巧"有（因为缓存那时已经被填上了）。这一组钉住的就是这个。 */
  console.log('缩略图补推');
  {
    const mark = sent.length;
    const d2 = makeDom();
    const w2 = d2.window;
    const doc2 = w2.document;
    const flush2 = () => new Promise((resolve) => w2.setTimeout(resolve, 0));
    const since = (type) => sent.slice(mark).filter((m) => m && m.type === type);
    const openPicker = async (name) => {
      doc2.querySelector(`.card[data-name="${name}"] .actions button`)
        .dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
      await flush2();
    };

    await flush2();
    w2.dispatchEvent(new w2.MessageEvent('message', { data: { type: 'templates', templates: TEMPLATES } }));
    await flush2();
    check(
      doc2.querySelectorAll('.card .thumb-box img').length === 0,
      '这一轮还没收到任何缩略图（模拟"刚打开面板就点 ⇄"）',
    );

    await openPicker('1.png');
    const requested = since('requestThumbs');
    check(requested.length === 1, `打开选择器时发了一次补推请求（实际 ${requested.length} 次）`);
    const asked = (requested[0] && requested[0].imagePaths) || [];
    check(
      asked.length === 2 && asked.includes('C:/proj/ok_templates/2.png') && asked.includes('C:/proj/ok_templates/3.png'),
      `只请求缺缩略图的那几张、且不含自己（实际 ${JSON.stringify(asked)}）`,
    );
    check(
      doc2.querySelectorAll('#swapList .swap-thumb img').length === 0,
      '补推到达之前列表里是占位符',
    );

    // 宿主后补一张（列表**开着**）
    w2.dispatchEvent(new w2.MessageEvent('message', {
      data: { type: 'thumbs', items: [{ name: '3.png', url: 'data:image/png;base64,AAA' }] },
    }));
    await flush2();
    check(
      doc2.querySelectorAll('#swapList .swap-thumb img').length === 1,
      '后补的缩略图会填进**已经打开**的列表（不必关掉再打开）',
    );
    check(
      doc2.querySelector('.card[data-name="3.png"] .thumb-box img') !== null,
      '同一张缩略图也落到网格卡片上（一份缓存、两处复用，就是网格那一张）',
    );

    w2.dispatchEvent(new w2.MessageEvent('message', {
      data: { type: 'thumbs', items: [{ name: '3.png', url: 'data:image/png;base64,BBB' }] },
    }));
    await flush2();
    check(
      doc2.querySelectorAll('#swapList .swap-thumb img').length === 1,
      '同一张重复推送不会插第二张（幂等）',
    );

    // 重新下发模板列表 ⇒ 缩略图 URL 缓存作废（模板名会被复用，旧 URL 会显示错图）
    doc2.getElementById('swapCancel').dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
    await flush2();
    w2.dispatchEvent(new w2.MessageEvent('message', { data: { type: 'templates', templates: TEMPLATES } }));
    await flush2();
    const beforeSecondOpen = since('requestThumbs').length;
    await openPicker('1.png');
    check(
      since('requestThumbs').length === beforeSecondOpen + 1,
      '模板列表重下发后缓存整份作废：再开选择器会重新要一遍（不会沿用旧 URL）',
    );
  }

  /* ── 7. 破坏性对照：去掉"排除自己" ───────────────────────────── */
  console.log('破坏性对照');
  {
    const appSource = fs.readFileSync(path.join(componentRoot, 'app.js'), 'utf8');
    const noSelfFilter = appSource.replace(
      'metas.filter((m) => m.name !== source.name)',
      'metas.filter((m) => true)',
    );
    check(noSelfFilter !== appSource, '对照源码确实被改动了（替换命中）—— 否则对照是假的');

    const broken = makeDom(noSelfFilter);
    await new Promise((resolve) => broken.window.setTimeout(resolve, 0));
    broken.window.dispatchEvent(new broken.window.MessageEvent('message', {
      data: { type: 'templates', templates: TEMPLATES },
    }));
    await new Promise((resolve) => broken.window.setTimeout(resolve, 0));
    broken.window.document.querySelector('.card[data-name="1.png"] .actions button')
      .dispatchEvent(new broken.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => broken.window.setTimeout(resolve, 0));
    const brokenNames = [...broken.window.document.querySelectorAll('#swapList .swap-item')]
      .map((it) => it.querySelector('.swap-name').textContent);
    check(
      brokenNames.includes('1.png') && brokenNames.length === 3,
      `对照：去掉自我排除后列表里出现自己（实际 ${brokenNames.join(', ')}）—— 与第 2 组相反`,
    );

    /* 对照二：拿掉"回填已经打开的选择器"那段 —— 正是用户报的"不会尝试渲染"。 */
    const noPatch = appSource.replace(
      "if (thumb.dataset.name === name) fillThumbBox(thumb, url, name, '');",
      "if (false) fillThumbBox(thumb, url, name, '');",
    );
    check(noPatch !== appSource, '对照二源码确实被改动了（替换命中）—— 否则对照是假的');

    const noPatchDom = makeDom(noPatch);
    const w3 = noPatchDom.window;
    await new Promise((resolve) => w3.setTimeout(resolve, 0));
    w3.dispatchEvent(new w3.MessageEvent('message', { data: { type: 'templates', templates: TEMPLATES } }));
    await new Promise((resolve) => w3.setTimeout(resolve, 0));
    w3.document.querySelector('.card[data-name="1.png"] .actions button')
      .dispatchEvent(new w3.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => w3.setTimeout(resolve, 0));
    w3.dispatchEvent(new w3.MessageEvent('message', {
      data: { type: 'thumbs', items: [{ name: '3.png', url: 'data:image/png;base64,AAA' }] },
    }));
    await new Promise((resolve) => w3.setTimeout(resolve, 0));
    check(
      w3.document.querySelectorAll('#swapList .swap-thumb img').length === 0,
      '对照二：不回填时，后补的缩略图进不了已经打开的列表（只能关掉再开）—— 与第 6 组相反',
    );

    /* 对照三：拿掉"为缺缩略图的候选发补推请求"—— 那样缺的图永远没有机会被补上。 */
    const noRequest = appSource.replace(
      'if (missing.length) vscode.postMessage({ type: \'requestThumbs\', imagePaths: missing });',
      'if (false) vscode.postMessage({ type: \'requestThumbs\', imagePaths: missing });',
    );
    check(noRequest !== appSource, '对照三源码确实被改动了（替换命中）—— 否则对照是假的');

    const noRequestMark = sent.length;
    const noRequestDom = makeDom(noRequest);
    const w4 = noRequestDom.window;
    await new Promise((resolve) => w4.setTimeout(resolve, 0));
    w4.dispatchEvent(new w4.MessageEvent('message', { data: { type: 'templates', templates: TEMPLATES } }));
    await new Promise((resolve) => w4.setTimeout(resolve, 0));
    w4.document.querySelector('.card[data-name="1.png"] .actions button')
      .dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => w4.setTimeout(resolve, 0));
    check(
      sent.slice(noRequestMark).filter((m) => m && m.type === 'requestThumbs').length === 0,
      '对照三：不主动要时一张补推请求都不发（裁剪失败的那几张整轮都不会再推）—— 与第 6 组相反',
    );
  }

  console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
