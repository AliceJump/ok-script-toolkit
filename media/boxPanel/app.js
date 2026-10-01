(function () {
  const I18N = JSON.parse(document.getElementById('boxPanelI18n')?.textContent || '{}');
  const t = (key) => I18N[key] || key;
  const vscode = acquireVsCodeApi();
  const mode = (document.getElementById('boxPanelMode')?.textContent || 'gallery').trim();
  document.getElementById('refreshBtn').textContent = t('refresh');
  const publish = document.getElementById('publishBtn');
  publish.textContent = t('publish');
  publish.style.display = mode === 'assets' ? '' : 'none';
  document.getElementById('hint').textContent = mode === 'assets' ? t('assetsHint') : t('galleryHint');
  document.getElementById('refreshBtn').onclick = () => vscode.postMessage({ type: 'refresh' });
  publish.onclick = () => vscode.postMessage({ type: 'publish' });

  const cards = new Map();
  function fillThumb(card, url) {
    const box = card.querySelector('.thumb-box');
    if (!box || box.querySelector('img')) return;
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    box.textContent = '';
    box.append(img);
    img.src = url;
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    const rows = document.getElementById('rows');
    // 原图上下文裁剪与红框标记，分批到达逐张填充。
    if (msg.type === 'thumbs') {
      (msg.items || []).forEach((item) => {
        const card = cards.get(item.id);
        if (card) fillThumb(card, item.url);
      });
      return;
    }
    if (msg.type !== 'rows') return;
    cards.clear();
    while (rows.firstChild) rows.removeChild(rows.firstChild);
    rows.className = 'asset-grid';
    (msg.rows || []).forEach((row) => {
      const card = document.createElement('div');
      card.className = 'card asset-card';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'activate-btn';
      button.title = row.id;
      const box = document.createElement('div');
      box.className = 'thumb-box';
      box.textContent = '…';
      const name = document.createElement('div');
      name.className = 'asset-name';
      name.textContent = row.id;
      const count = document.createElement('div');
      count.className = 'asset-count';
      count.textContent = row.label;
      button.append(box, name, count);
      card.append(button);
      if (row.imagePath && row.bbox) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'open-btn';
        open.textContent = '👁';
        open.title = t('viewOriginal');
        open.setAttribute('aria-label', t('viewOriginal'));
        open.onclick = () => vscode.postMessage({ type: 'open', id: row.id });
        card.append(open);
      }
      cards.set(row.id, card);
      let clickTimer = 0;
      button.onclick = () => {
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => vscode.postMessage({ type: 'activate', id: row.id, clicks: 1 }), 250);
      };
      button.ondblclick = () => {
        window.clearTimeout(clickTimer);
        vscode.postMessage({ type: 'activate', id: row.id, clicks: 2 });
      };
      rows.append(card);
    });
    if (!(msg.rows || []).length) {
      const empty = document.createElement('div');
      empty.className = 'panel-hint';
      empty.textContent = t(mode === 'assets' ? 'assetsEmpty' : 'galleryEmpty');
      rows.append(empty);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
