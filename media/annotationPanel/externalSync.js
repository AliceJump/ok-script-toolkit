(() => {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const bboxModal = document.getElementById('bboxModal');
  const drawBtn = document.getElementById('drawBtn');
  const coordBtn = document.getElementById('coordBtn');
  const pendingModes = new Set();
  let pointerActive = false;
  let reportScheduled = false;

  function hasTransientEdit() {
    return pointerActive
      || !!bboxModal?.classList.contains('visible')
      || !!drawBtn?.classList.contains('active')
      || !!coordBtn?.classList.contains('active');
  }

  function reportPending() {
    reportScheduled = false;
    if (!pendingModes.size) return;
    const transient = hasTransientEdit();
    for (const mode of pendingModes) {
      vscode.postMessage({ type: 'externalEditorState', mode, transient });
    }
    if (!transient) pendingModes.clear();
  }

  function scheduleReport() {
    if (reportScheduled || !pendingModes.size) return;
    reportScheduled = true;
    queueMicrotask(reportPending);
  }

  canvas?.addEventListener('mousedown', event => {
    if (event.button === 0) pointerActive = true;
  }, true);
  window.addEventListener('mouseup', () => {
    pointerActive = false;
    scheduleReport();
  }, true);
  window.addEventListener('blur', () => {
    pointerActive = false;
    scheduleReport();
  });
  document.addEventListener('click', scheduleReport, true);
  document.addEventListener('keyup', scheduleReport, true);

  if (bboxModal) {
    new MutationObserver(scheduleReport).observe(bboxModal, { attributes: true, attributeFilter: ['class'] });
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type !== 'externalSourceChanged' || !message.mode) return;
    pendingModes.add(message.mode);
    reportPending();
  });
})();
