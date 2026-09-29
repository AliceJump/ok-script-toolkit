(function () {
  const I18N = JSON.parse(document.getElementById('boxPanelI18n')?.textContent || '{}');
  const t = (key) => I18N[key] || key;
  const vscode = acquireVsCodeApi();
  const mode = (document.getElementById('boxPanelMode')?.textContent || 'assets').trim();
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
    if (msg.type === 'thumbs' && mode === 'assets') {
      (msg.items || []).forEach((item) => {
        const card = cards.get(item.id);
        if (card) fillThumb(card, item.url);
      });
      return;
    }
    if (msg.type !== 'rows') return;
    cards.clear();
    while (rows.firstChild) rows.removeChild(rows.firstChild);
    rows.className = mode === 'assets' ? 'asset-grid' : '';
    (msg.rows || []).forEach((row) => {
      const button = document.createElement('button');
      button.type = 'button';
      if (mode === 'assets') {
        button.className = 'card asset-card';
        button.title = row.name;
        const box = document.createElement('div');
        box.className = 'thumb-box';
        box.textContent = '…';
        const name = document.createElement('div');
        name.className = 'asset-name';
        name.textContent = row.name;
        const count = document.createElement('div');
        count.className = 'asset-count';
        count.textContent = String(row.count);
        button.append(box, name, count);
        cards.set(row.id, button);
      } else {
        button.className = 'box-row';
        button.textContent = row.label;
      }
      let clickTimer = 0;
      button.onclick = () => {
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => vscode.postMessage({ type: 'activate', id: row.id, clicks: 1 }), 250);
      };
      button.ondblclick = () => {
        window.clearTimeout(clickTimer);
        vscode.postMessage({ type: 'activate', id: row.id, clicks: 2 });
      };
      rows.append(button);
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
