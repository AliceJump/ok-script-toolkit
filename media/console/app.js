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
        Console.renderHealth();
        // 多账户存储概要随 tasks 消息一起到达（probe 探测结果）；store 数据保持独立状态
        Console.renderMultiAccount(message.multiAccount || state.multiAccount, state.accountStore);
        break;
      case 'schemas':
        state.schemas = message.schemas || state.schemas;
        // probe 完成回推：multiAccount 更新，但 store 数据由独立的 accountStore 消息维护——
        // 这里必须带上 state.accountStore，否则编辑器会被「无法读取」空态顶掉
        Console.renderMultiAccount(message.multiAccount || state.multiAccount, state.accountStore);
        renderTasks(message.tasks || state.currentTasks);
        Console.refreshDrawer();
        Console.renderHealth();
        break;
      case 'taskConfigs':
        state.taskConfigs = message.configs || {};
        // UI 折叠状态（启动设置区/配置分组/卡片）随任务配置一起下发，重开面板复用
        if (message.uiState) state.uiState = message.uiState;
        renderTasks(state.currentTasks);
        Console.refreshDrawer();
        Console.renderHealth();
        break;
      // 配置接管：全局配置组 + 快照（配置分段数据源）
      case 'globalGroups':
        state.globalGroups = message.groups || [];
        state.globalSnapshots = message.snapshots || {};
        // 展开状态以宿主持久化集合为准（点击 toggle 后由宿主回推）
        state.expandedGlobalGroups = message.expanded || [];
        Console.renderConfig(state.globalGroups, state.globalSnapshots, state.expandedGlobalGroups);
        break;
      case 'snapshotUpdated':
        if (message.target === 'task') {
          state.taskConfigs[message.name] = {
            ...(state.taskConfigs[message.name] || {}),
            params: message.params || {},
          };
          renderTasks(state.currentTasks);
          Console.refreshDrawer();
          Console.renderHealth();
        } else if (message.target === 'global') {
          state.globalSnapshots[message.name] = message.values || {};
          Console.renderConfig(state.globalGroups, state.globalSnapshots, state.expandedGlobalGroups || []);
        }
        break;
      // 多账户存储数据（account_store.py get 的结果）：账号分段编辑器数据源
      case 'accountStore':
        Console.renderMultiAccount(state.multiAccount, message.data || null, message.error || '');
        break;
      // 多账户存储只读概要（账号分段）
      case 'multiAccount':
        Console.renderMultiAccount(message.info || { available: false }, state.accountStore);
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
