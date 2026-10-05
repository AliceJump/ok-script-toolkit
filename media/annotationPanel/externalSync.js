(() => {
  const vscode = acquireVsCodeApi();
  const nativePostMessage = vscode.postMessage.bind(vscode);
  const canvas = document.getElementById('canvas');
  const bboxModal = document.getElementById('bboxModal');
  const pendingModes = new Set();
  const annotationSnapshots = new Map();
  const editorVersions = new Map();
  const pendingSaveCounts = new Map();
  const rejectedLoads = new Map();
  let currentImagePath = '';
  let pointerActive = false;
  let reportScheduled = false;

  const cloneAnnotations = values => Array.isArray(values) ? values.map(value => ({ ...value })) : [];
  const stateKey = (imagePath, mode) => `${imagePath || ''}\n${mode || ''}`;
  const currentKey = mode => stateKey(currentImagePath, mode);

  // app.js and this helper intentionally share the same VS Code API object. A
  // save increments the editor version before the message leaves the Webview,
  // closing the small window where an older host load could otherwise arrive
  // before the extension has started processing that save.
  vscode.postMessage = message => {
    if ((message?.type === 'save' || message?.type === 'saveMode') && message.mode && Array.isArray(message.annotations)) {
      const key = currentKey(message.mode);
      const editorVersion = (editorVersions.get(key) || 0) + 1;
      editorVersions.set(key, editorVersion);
      pendingSaveCounts.set(key, (pendingSaveCounts.get(key) || 0) + 1);
      annotationSnapshots.set(key, cloneAnnotations(message.annotations));
      return nativePostMessage({ ...message, imagePath: currentImagePath, editorVersion });
    }
    return nativePostMessage(message);
  };

  function hasTransientEdit() {
    return pointerActive || !!bboxModal?.classList.contains('visible');
  }

  function reportPending() {
    reportScheduled = false;
    if (!pendingModes.size) return;
    const transient = hasTransientEdit();
    for (const mode of pendingModes) {
      nativePostMessage({
        type: 'externalEditorState',
        imagePath: currentImagePath,
        mode,
        transient,
        annotations: transient ? undefined : cloneAnnotations(annotationSnapshots.get(currentKey(mode))),
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
      const imagePath = message.imagePath || '';
      const mode = message.annotationMode;
      const key = stateKey(imagePath, mode);
      const editorVersion = editorVersions.get(key) || 0;
      const expectedEditorVersion = Number.isInteger(message.expectedEditorVersion)
        ? message.expectedEditorVersion
        : editorVersion;
      const pendingSaves = pendingSaveCounts.get(key) || 0;

      if (message.loadRequestId && (pendingSaves > 0 || editorVersion !== expectedEditorVersion)) {
        rejectedLoads.set(key, { imagePath, mode });
        event.stopImmediatePropagation();
        nativePostMessage({
          type: 'loadRejected',
          loadRequestId: message.loadRequestId,
          imagePath,
          mode,
          editorVersion,
          pendingSaves,
          annotations: cloneAnnotations(annotationSnapshots.get(key)),
        });
        return;
      }

      currentImagePath = imagePath;
      editorVersions.set(key, expectedEditorVersion);
      annotationSnapshots.set(key, cloneAnnotations(message.annotations));
      rejectedLoads.delete(key);
      if (message.loadRequestId) {
        queueMicrotask(() => nativePostMessage({
          type: 'loadAccepted',
          loadRequestId: message.loadRequestId,
          imagePath,
          mode,
          editorVersion: expectedEditorVersion,
        }));
      }
      return;
    }

    if (message.type === 'annotationSaveProcessed' && message.mode) {
      const key = stateKey(message.imagePath || '', message.mode);
      const remaining = Math.max(0, (pendingSaveCounts.get(key) || 0) - 1);
      pendingSaveCounts.set(key, remaining);
      if (remaining === 0 && rejectedLoads.has(key) && message.saved !== false) {
        const rejected = rejectedLoads.get(key);
        rejectedLoads.delete(key);
        nativePostMessage({ type: 'retryLoad', imagePath: rejected.imagePath, mode: rejected.mode });
      }
      return;
    }

    if (message.type !== 'externalSourceChanged' || !message.mode) return;
    pendingModes.add(message.mode);
    reportPending();
  });
})();
