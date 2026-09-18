(() => {
  const { post, state, elements, setStatus, initializeStaticUi } = globalThis.TaskLauncherCore;
  const { renderTasks, updateRunningState } = globalThis.TaskLauncherTaskCard;

  function applyExecutor(message) {
    state.executor = {
      status: message.status || 'idle',
      paused: message.paused === true,
      current: message.current || '',
      currentIsTrigger: message.currentIsTrigger === true,
      onetimeQueue: Array.isArray(message.onetimeQueue) ? message.onetimeQueue : [],
      enabledTriggers: Array.isArray(message.enabledTriggers) ? message.enabledTriggers : [],
    };
    updateRunningState();
  }

  function handleMessage(message) {
    switch (message.type) {
      case 'tasks':
        state.schemas = message.schemas || state.schemas;
        renderTasks(message.tasks || []);
        break;
      case 'schemas':
        state.schemas = message.schemas || state.schemas;
        renderTasks(state.currentTasks);
        break;
      case 'taskConfigs':
        state.taskConfigs = message.configs || {};
        renderTasks(state.currentTasks);
        break;
      case 'executor':
        applyExecutor(message);
        break;
      case 'status':
        setStatus(message.level, message.text);
        break;
      default:
        break;
    }
  }

  initializeStaticUi();
  elements.refresh.addEventListener('click', () => post({ type: 'refresh' }));
  elements.pauseToggle.addEventListener('click', () => {
    post({ type: state.executor.paused ? 'resume' : 'pause' });
  });
  elements.stopCurrent.addEventListener('click', () => post({ type: 'stopCurrent' }));
  elements.stopExecutor.addEventListener('click', () => post({ type: 'stopExecutor' }));
  window.addEventListener('message', event => handleMessage(event.data));
  post({ type: 'ready' });
  post({ type: 'loadConfigs' });
})();
