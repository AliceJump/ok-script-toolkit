(() => {
  const vscode = acquireVsCodeApi();
  const nativePostMessage = vscode.postMessage.bind(vscode);
  const canvas = document.getElementById('canvas');
  const bboxModal = document.getElementById('bboxModal');
  const drawBtn = document.getElementById('drawBtn');
  const coordBtn = document.getElementById('coordBtn');
  const pendingModes = new Set();
  const annotationSnapshots = new Map();
  let pointerActive = false;
  let reportScheduled = false;

  const cloneAnnotations = values => Array.isArray(values) ? values.map(value => ({ ...value })) : [];

  // app.js and this helper intentionally share the same VS Code API object. Keep
  // the latest editor-owned snapshot so an idle external reload can distinguish
  // a clean canvas from unsaved edits left behind by a failed save.
  vscode.postMessage = message => {
    if ((message?.type === 'save' || message?.type === 'saveMode') && message.mode && Array.isArray(message.annotations)) {
      annotationSnapshots.set(message.mode, cloneAnnotations(message.annotations));
    }
    return nativePostMessage(message);
  };

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
      nativePostMessage({
        type: 'externalEditorState',
        mode,
        transient,
        annotations: transient ? undefined : cloneAnnotations(annotationSnapshots.get(mode)),
      });
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
    if (message.type === 'load' && message.annotationMode) {
      annotationSnapshots.set(message.annotationMode, cloneAnnotations(message.annotations));
      return;
    }
    if (message.type !== 'externalSourceChanged' || !message.mode) return;
    pendingModes.add(message.mode);
    reportPending();
  });
})();