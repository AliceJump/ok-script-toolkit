(() => {
  const I18N = JSON.parse(document.getElementById('annotationPanelI18n')?.textContent || '{}');
  const t = (key, args = {}) => (I18N[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));

  const modeSwitch = document.querySelector('.annotation-mode-switch');
  const templateModeBtn = document.getElementById('templateModeBtn');
  const rectModeBtn = document.getElementById('rectModeBtn');
  const pointModeBtn = document.getElementById('pointModeBtn');
  const sharedHistory = document.getElementById('sharedHistoryChk');
  const sharedHistoryLabel = document.getElementById('sharedHistoryLabel');
  const coordPreference = document.getElementById('coordPreferXywhChk');
  const drawBtn = document.getElementById('drawBtn');
  const bboxTitle = document.getElementById('bboxTitle');
  const colorInfo = document.getElementById('colorInfo');

  function localizeStatic() {
    if (modeSwitch) modeSwitch.setAttribute('aria-label', t('annotationModeLabel'));
    if (templateModeBtn) templateModeBtn.textContent = t('modeTemplate');
    if (rectModeBtn) rectModeBtn.textContent = t('modeRect');
    if (pointModeBtn) pointModeBtn.textContent = t('modePoint');
    if (sharedHistoryLabel) sharedHistoryLabel.textContent = t('sharedHistory');
    if (sharedHistory?.parentElement) sharedHistory.parentElement.title = t('sharedHistoryTooltip');
    if (coordPreference?.parentElement) coordPreference.parentElement.title = t('coordPreferenceTooltip');
  }

  function localizeDrawTool() {
    if (!drawBtn) return;
    const expected = pointModeBtn?.classList.contains('active') ? t('pointTool') : t('drawBbox');
    if (drawBtn.textContent !== expected) drawBtn.textContent = expected;
  }

  function localizeTitle() {
    if (!bboxTitle) return;
    if (bboxTitle.textContent === 'Edit point') bboxTitle.textContent = t('editPointTitle');
    else if (bboxTitle.textContent === 'New point') bboxTitle.textContent = t('newPointTitle');
  }

  function localizeStatus() {
    if (!colorInfo) return;
    if (colorInfo.textContent === 'Clipboard is not a valid normalized coordinate tuple.') {
      colorInfo.textContent = t('clipboardInvalid');
    } else if (colorInfo.textContent === 'Zero-size coordinates can only be pasted in Point mode.') {
      colorInfo.textContent = t('clipboardPointOnly');
    }
  }

  localizeStatic();
  localizeDrawTool();
  localizeTitle();
  localizeStatus();

  const observer = new MutationObserver(() => {
    localizeStatic();
    localizeDrawTool();
    localizeTitle();
    localizeStatus();
  });
  for (const target of [templateModeBtn, rectModeBtn, pointModeBtn, drawBtn, bboxTitle, colorInfo]) {
    if (target) observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
  }
})();
