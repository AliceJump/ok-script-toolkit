(function () {
  const vscode = acquireVsCodeApi();
  const I18N = JSON.parse(document.getElementById('paramsI18n')?.textContent || '{}');
  const t = (k, a = {}) => (I18N[k] || k).replace(/\{(\w+)\}/g, (_, n) => String(a[n] ?? '{' + n + '}'));
  const empty = document.getElementById('empty');
  const body = document.getElementById('body');
  const formHost = document.getElementById('formHost');
  document.getElementById('emptyTitle').textContent = t('paramsEmptyTitle');
  document.getElementById('emptyBody').textContent = t('paramsEmptyBody');

  function showEmpty() {
    empty.hidden = false;
    body.hidden = true;
    formHost.replaceChildren();
  }

  function render(msg) {
    empty.hidden = true;
    body.hidden = false;
    document.getElementById('title').textContent = msg.title || '';
    document.getElementById('subtitle').textContent = msg.subtitle || '';
    document.getElementById('status').textContent = msg.statusText || t('paramsSandboxHint');
    formHost.replaceChildren();
    const fields = msg.fields || [];
    const values = msg.values || {};
    if (!fields.length) {
      const p = document.createElement('p');
      p.className = 'panel-hint';
      p.textContent = t('paramsNoFields');
      formHost.appendChild(p);
      return;
    }
    // Prefer shared ConfigPanel when available; fall back to plain inputs.
    if (typeof ConfigPanel !== 'undefined' && ConfigPanel.mount) {
      ConfigPanel.mount(formHost, {
        fields,
        values,
        onChange: (next) => vscode.postMessage({ type: 'save', target: msg.target, key: msg.key, values: next }),
      });
      return;
    }
    const list = document.createElement('div');
    list.className = 'params-fields';
    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'params-field';
      const name = document.createElement('span');
      name.textContent = f.displayKey || f.key;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = values[f.key] != null ? String(values[f.key]) : (f.default != null ? String(f.default) : '');
      input.addEventListener('change', () => {
        const next = { ...values, [f.key]: input.value };
        vscode.postMessage({ type: 'save', target: msg.target, key: msg.key, values: next });
      });
      row.append(name, input);
      list.appendChild(row);
    }
    formHost.appendChild(list);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'clear') showEmpty();
    if (msg?.type === 'params') render(msg);
  });
  showEmpty();
  vscode.postMessage({ type: 'ready' });
})();
