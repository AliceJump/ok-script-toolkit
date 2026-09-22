(() => {
  const { post, state, elements, setStatus, initializeStaticUi } = globalThis.TaskLauncherCore;
  const { renderTasks, updateRunningState } = globalThis.TaskLauncherTaskCard;
  const Console = globalThis.TaskLauncherConsole;

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
        Console.refreshDrawer();
        break;
      case 'schemas':
        state.schemas = message.schemas || state.schemas;
        renderTasks(state.currentTasks);
        Console.refreshDrawer();
        break;
      case 'taskConfigs':
        state.taskConfigs = message.configs || {};
        renderTasks(state.currentTasks);
        Console.refreshDrawer();
        break;
      case 'executor':
        applyExecutor(message);
        break;
      // 游戏连接 / 浮层状态（状态条第一行 + 游戏分段卡片）
      case 'game':
        Console.renderGame(message.game || null, message.overlay === true);
        break;
      // 连接流程结束（成功或失败）：解锁连接按钮
      case 'connectDone':
        Console.onConnectDone();
        break;
      case 'status':
        setStatus(message.level, message.text);
        break;
      default:
        break;
    }
  }

  initializeStaticUi();
  Console.init();
  elements.refresh.addEventListener('click', () => post({ type: 'refresh' }));
  elements.startExecutor.addEventListener('click', () => post({ type: 'startExecutor' }));
  elements.pauseToggle.addEventListener('click', () => {
    post({ type: state.executor.paused ? 'resume' : 'pause' });
  });
  elements.stopCurrent.addEventListener('click', () => post({ type: 'stopCurrent' }));
  elements.stopExecutor.addEventListener('click', () => post({ type: 'stopExecutor' }));
  window.addEventListener('message', event => handleMessage(event.data));
  post({ type: 'ready' });
  post({ type: 'loadConfigs' });
})();
