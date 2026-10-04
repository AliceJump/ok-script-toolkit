(() => {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const wrap = canvas?.parentElement;
  const panel = document.getElementById('conflictPanel');
  const rows = document.getElementById('conflictRows');
  const apply = document.getElementById('conflictApply');
  const summary = document.getElementById('conflictSummary');
  if (!canvas || !wrap || !panel || !rows || !apply || !summary) return;

  const lang = (navigator.language || 'en').toLowerCase();
  const copies = {
    zh: {
      title: '标注冲突', current: '当前编辑', external: '外部修改', fields: '冲突字段',
      apply: '应用选择并保存', hint: '两边都会保留到你完成选择；未解决前不会写盘。',
    },
    ja: {
      title: 'アノテーション競合', current: '編集中', external: '外部変更', fields: '競合フィールド',
      apply: '選択を適用して保存', hint: '選択が完了するまで両方を保持し、ディスクには書き込みません。',
    },
    ko: {
      title: '주석 충돌', current: '현재 편집', external: '외부 변경', fields: '충돌 필드',
      apply: '선택 적용 및 저장', hint: '선택이 끝날 때까지 두 버전을 모두 유지하며 디스크에 쓰지 않습니다.',
    },
    es: {
      title: 'Conflicto de anotaciones', current: 'Edición actual', external: 'Cambio externo', fields: 'Campos en conflicto',
      apply: 'Aplicar selección y guardar', hint: 'Ambas versiones se conservan hasta resolver el conflicto; no se escribe nada antes.',
    },
    en: {
      title: 'Annotation conflicts', current: 'Current edit', external: 'External change', fields: 'Conflicting fields',
      apply: 'Apply choices and save', hint: 'Both versions are kept until every conflict is resolved; nothing is written before that.',
    },
  };
  const text = lang.startsWith('zh') ? copies.zh
    : lang.startsWith('ja') ? copies.ja
      : lang.startsWith('ko') ? copies.ko
        : lang.startsWith('es') ? copies.es
          : copies.en;

  const overlay = document.createElement('canvas');
  overlay.id = 'conflictCanvas';
  overlay.setAttribute('aria-hidden', 'true');
  wrap.appendChild(overlay);

  let session = null;
  let transform = null;
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
    fields.textContent = `${text.fields}: ${(conflict.fields || []).join(', ') || '—'}`;

    const current = document.createElement('button');
    current.type = 'button';
    current.className = 'mini-btn conflict-choice';
    current.dataset.choice = 'local';
    current.textContent = `${text.current}: ${candidateLabel(conflict.local)}`;

    const external = document.createElement('button');
    external.type = 'button';
    external.className = 'mini-btn conflict-choice';
    external.dataset.choice = 'external';
    external.textContent = `${text.external}: ${candidateLabel(conflict.external)}`;

    const choose = choice => {
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
    choices.clear();
    rows.replaceChildren();
    for (const conflict of message.conflicts || []) rows.appendChild(renderConflictRow(conflict));
    summary.textContent = `${text.title} · ${(message.conflicts || []).length}\n${text.hint}`;
    apply.textContent = text.apply;
    apply.disabled = true;
    panel.hidden = false;
    paintOverlay();
  }

  function clearConflicts() {
    session = null;
    choices.clear();
    rows.replaceChildren();
    panel.hidden = true;
    paintOverlay();
  }

  apply.addEventListener('click', () => {
    if (!session || choices.size !== (session.conflicts?.length || 0)) return;
    vscode.postMessage({
      type: 'resolveAnnotationConflicts',
      choices: [...choices].map(([key, choice]) => ({ key, choice })),
    });
  });

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'annotationConflicts') showConflicts(message);
    else if (message.type === 'load' && session) clearConflicts();
  });

  window.addEventListener('resize', () => {
    resizeOverlay();
    paintOverlay();
  });
})();
