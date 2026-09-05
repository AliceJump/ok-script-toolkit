(() => {
  const { t, post, state, elements, taskKey, setStatus, initializeStaticUi } = globalThis.TaskLauncherCore;
  const { renderTasks, updateRunningState } = globalThis.TaskLauncherTaskCard;

  function setRunning(running, taskOrKey, paused) {
    state.running = running;
    if (typeof taskOrKey === 'string') state.runningTaskKey = taskOrKey;
    else if (taskOrKey) state.runningTaskKey = taskKey(taskOrKey);
    if (!running) {
      state.runningTaskKey = '';
      state.paused = false;
      state.stopping = false;
    } else if (paused !== undefined) {
      state.paused = paused === true;
    }
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
      case 'status':
        setStatus(message.level, message.text);
        break;
      case 'running':
        setRunning(message.running, message.task, message.paused);
        state.stopping = message.running === true && message.stopping === true;
        if (message.stopping) setStatus('warn', message.timedOut ? t('timeoutStopping') : t('stopping'));
        else if (message.error) setStatus('error', message.error);
        else if (message.stopped) setStatus('warn', message.timedOut ? t('taskTimedOut') : t('taskStopped'));
        else if (message.running === false && message.code === 0) setStatus('ok', t('taskCompleted'));
        else if (message.running === false) setStatus('error', t('taskFailed'));
        break;
      case 'paused':
        state.paused = message.paused === true;
        updateRunningState();
        setStatus(state.paused ? 'warn' : 'ok', state.paused ? t('taskPaused') : t('taskResumed'));
        break;
      default:
        break;
    }
  }

  initializeStaticUi();
  elements.refresh.addEventListener('click', () => post({ type: 'refresh' }));
  window.addEventListener('message', event => handleMessage(event.data));
  post({ type: 'ready' });
  post({ type: 'loadConfigs' });
})();
