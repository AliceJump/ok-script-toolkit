(() => {
  const vscode = acquireVsCodeApi();
  const I18N = JSON.parse(document.getElementById('annotationPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const canvas = document.getElementById('canvas');
  const wrap = canvas?.parentElement;
  const panel = document.getElementById('conflictPanel');
  const rows = document.getElementById('conflictRows');
  const apply = document.getElementById('conflictApply');
  const summary = document.getElementById('conflictSummary');
  if (!canvas || !wrap || !panel || !rows || !apply || !summary) return;

  const overlay = document.createElement('canvas');
  overlay.id = 'conflictCanvas';
  overlay.setAttribute('aria-hidden', 'true');
  wrap.appendChild(overlay);

  let session = null;
  let transform = null;
  let submitting = false;
  const choices = new Map();

  const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(...args) {
    const result = originalDrawImage.apply(this, args);
    if (this.canvas === canvas && args.length >= 5 && args[0] instanceof HTMLImageElement) {
      const image = args[0];
      const imageWidth = image.naturalWidth || image.width || 1;
      const imageHeight = image.naturalHeight || image.height || 1;
      transform = {
        x: Number(args[1]) || 0,
        y: Number(args[2]) || 0,
        sx: (Number(args[3]) || imageWidth) / imageWidth,
        sy: (Number(args[4]) || imageHeight) / imageHeight,
      };
      resizeOverlay();
      paintOverlay();
    }
    return result;
  };

  function resizeOverlay() {
    if (overlay.width !== canvas.width) overlay.width = canvas.width;
    if (overlay.height !== canvas.height) overlay.height = canvas.height;
  }

  function candidateLabel(candidate) {
    if (!candidate) return '∅';
    const dims = candidate.w === 0 && candidate.h === 0
      ? `(${candidate.x}, ${candidate.y})`
      : `[${candidate.x}, ${candidate.y}, ${candidate.w}, ${candidate.h}]`;
    return `${candidate.category || '?'} ${dims}`;
  }

  function paintCandidate(ctx, candidate, kind) {
    if (!candidate || !transform) return;
    const style = getComputedStyle(document.body);
    const currentColor = style.getPropertyValue('--accent').trim() || '#4daafc';
    const externalColor = style.getPropertyValue('--err').trim() || '#f14c4c';
    const color = kind === 'local' ? currentColor : externalColor;
    const x = transform.x + candidate.x * transform.sx;
    const y = transform.y + candidate.y * transform.sy;
    const w = candidate.w * transform.sx;
    const h = candidate.h * transform.sy;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(kind === 'local' ? [] : [7, 4]);
    if (candidate.w === 0 && candidate.h === 0) {
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, w, h);
    }
    ctx.setLineDash([]);
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(kind === 'local' ? 'L' : 'E', x + 3, Math.max(11, y - 4));
    ctx.restore();
  }

  function paintOverlay() {
    resizeOverlay();
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!session) return;
    for (const conflict of session.conflicts || []) {
      paintCandidate(ctx, conflict.local, 'local');
      paintCandidate(ctx, conflict.external, 'external');
    }
  }

  function renderConflictRow(conflict) {
    const row = document.createElement('div');
    row.className = 'conflict-row';
    row.dataset.key = conflict.key;

    const name = document.createElement('div');
    name.className = 'conflict-name';
    name.textContent = conflict.key;

    const fields = document.createElement('div');
    fields.className = 'conflict-fields';
    fields.textContent = `${t('conflictFields')}: ${(conflict.fields || []).join(', ') || '—'}`;

    const current = document.createElement('button');
    current.type = 'button';
    current.className = 'mini-btn conflict-choice';
    current.dataset.choice = 'local';
    current.textContent = `${t('conflictCurrent')}: ${candidateLabel(conflict.local)}`;

    const external = document.createElement('button');
    external.type = 'button';
    external.className = 'mini-btn conflict-choice';
    external.dataset.choice = 'external';
    external.textContent = `${t('conflictExternal')}: ${candidateLabel(conflict.external)}`;

    const choose = choice => {
      if (submitting) return;
      choices.set(conflict.key, choice);
      for (const button of row.querySelectorAll('.conflict-choice')) {
        button.classList.toggle('active', button.dataset.choice === choice);
      }
      apply.disabled = choices.size !== (session?.conflicts?.length || 0);
    };
    current.addEventListener('click', () => choose('local'));
    external.addEventListener('click', () => choose('external'));

    row.append(name, fields, current, external);
    return row;
  }

  function showConflicts(message) {
    session = message;
    submitting = false;
    choices.clear();
    rows.replaceChildren();
    for (const conflict of message.conflicts || []) rows.appendChild(renderConflictRow(conflict));
    summary.textContent = `${t('conflictTitle')} · ${(message.conflicts || []).length}\n${t('conflictHint')}`;
    apply.textContent = t('conflictApply');
    apply.disabled = true;
    panel.hidden = false;
    paintOverlay();
  }

  function clearConflicts() {
    session = null;
    submitting = false;
    choices.clear();
    rows.replaceChildren();
    panel.hidden = true;
    paintOverlay();
  }

  apply.addEventListener('click', () => {
    if (!session || submitting || choices.size !== (session.conflicts?.length || 0)) return;
    submitting = true;
    apply.disabled = true;
    vscode.postMessage({
      type: 'resolveAnnotationConflicts',
      conflictSessionId: session.conflictSessionId,
      choices: [...choices].map(([key, choice]) => ({ key, choice })),
    });
  });

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'annotationConflicts') showConflicts(message);
    else if (message.type === 'clearAnnotationConflicts'
      && (!message.conflictSessionId || message.conflictSessionId === session?.conflictSessionId)) clearConflicts();
    else if (message.type === 'conflictResolutionFailed'
      && message.conflictSessionId === session?.conflictSessionId) {
      submitting = false;
      apply.disabled = choices.size !== (session?.conflicts?.length || 0);
    } else if (message.type === 'load' && session) clearConflicts();
  });

  window.addEventListener('resize', () => {
    resizeOverlay();
    paintOverlay();
  });
})();