(() => {
  const strings = globalThis.__TASK_LAUNCHER_I18N__ || {};
  const t = (key, args = {}) => (strings[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? `{${name}}`));
  const vscode = acquireVsCodeApi();

  const state = {
    schemas: {},
    taskConfigs: {},
    currentTasks: [],
    // UI 折叠状态（落盘于插件项目存储，重开面板复用）：键 -> 值
    uiState: {},
    // 常驻执行器会话：整个项目只有一个进程，连接一次后按启用集合轮询触发任务
    executor: {
      status: 'idle',
      paused: false,
      current: '',
      currentIsTrigger: false,
      onetimeQueue: [],
      enabledTriggers: [],
    },
  };

  /**
   * UI 折叠状态读写：所有折叠点（启动设置区、配置分组、卡片等）统一走这里，
   * 值即时落盘（宿主项目存储），重开面板/切分段后复用上次状态。
   */
  const uiState = {
    get: (key, fallback) => (state.uiState && key in state.uiState ? state.uiState[key] : fallback),
    set: (key, value) => {
      state.uiState = { ...(state.uiState || {}), [key]: value };
      post({ type: 'saveUiState', key, value });
    },
  };

  const elements = {
    tasks: document.getElementById('tasks'),
    status: document.getElementById('status'),
    empty: document.getElementById('empty'),
    refresh: document.getElementById('refresh'),
    executorState: document.getElementById('executorState'),
    startExecutor: document.getElementById('startExecutor'),
    pauseToggle: document.getElementById('pauseToggle'),
    stopCurrent: document.getElementById('stopCurrent'),
    stopExecutor: document.getElementById('stopExecutor'),
  };

  const taskKey = task => `${task.module}::${task.className}`;
  const post = message => vscode.postMessage(message);
  const taskKind = task => task.kind || state.schemas[taskKey(task)]?.kind || 'onetime';
  const triggerEnabled = key => state.executor.enabledTriggers.indexOf(key) >= 0;

  function setStatus(level, text) {
    if (!text) {
      elements.status.hidden = true;
      elements.status.textContent = '';
      return;
    }
    elements.status.hidden = false;
    elements.status.className = `status-banner ${level || ''}`;
    elements.status.textContent = text;
  }

  function initializeStaticUi() {
    document.documentElement.lang = navigator.language || 'en';
    document.title = t('taskTitle');
    elements.refresh.textContent = '↻';
    elements.refresh.title = t('refresh');
    elements.refresh.setAttribute('aria-label', t('refresh'));
    elements.stopExecutor.textContent = `✕ ${t('stopExecutor')}`;
    elements.empty.textContent = t('noTasks');
  }

  globalThis.TaskLauncherCore = {
    t,
    post,
    state,
    uiState,
    elements,
    taskKey,
    taskKind,
    triggerEnabled,
    setStatus,
    initializeStaticUi,
  };
})();
