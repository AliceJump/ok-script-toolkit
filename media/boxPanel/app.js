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

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type !== 'rows') return;
    const rows = document.getElementById('rows');
    while (rows.firstChild) rows.removeChild(rows.firstChild);
    (msg.rows || []).forEach((row) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'box-row';
      button.textContent = row.label;
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
