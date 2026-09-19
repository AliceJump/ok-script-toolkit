(() => {
  const { t, post, state, elements, taskKey, taskKind, triggerEnabled } = globalThis.TaskLauncherCore;
  const { buildConfigPanel } = globalThis.TaskLauncherConfigPanel;

  const BADGE_LABELS = {
    disabled: 'triggerDisabled',
    armed: 'triggerArmed',
    enqueued: 'triggerEnqueued',
    polling: 'triggerPolling',
    queued: 'taskQueued',
    running: 'taskRunning',
  };

  function createButton(className, text, handler) {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', handler);
    return button;
  }

  /** 触发任务：勾选即入列（等价 ok-script GUI 的启用开关），无需启动/停止按钮 */
  function buildTriggerToggle(task) {
    const label = document.createElement('label');
    label.className = 'task-card__enable';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.role = 'trigger-toggle';
    input.checked = triggerEnabled(taskKey(task));
    input.addEventListener('change', () => {
      post({ type: 'triggerSet', task: { ...task }, enabled: input.checked });
    });
    const text = document.createElement('span');
    text.textContent = t('enableTrigger');
    label.append(input, text);
    return label;
  }

  /** 一次性任务：入队到常驻执行器，执行一次后自动出队 */
  function buildLaunchButton(task) {
    const launch = createButton('task-card__launch', `▶ ${t('launch')}`, () => {
      post({ type: 'enqueue', task: { ...task } });
    });
    launch.dataset.role = 'launch';
    return launch;
  }

  function buildStatusBadge() {
    const badge = document.createElement('span');
    badge.className = 'task-card__status';
    badge.dataset.role = 'status';
    badge.hidden = true;
    return badge;
  }

  function buildTaskCard(task) {
    const key = taskKey(task);
    const schema = state.schemas[key];
    const kind = taskKind(task);
    const displayName = schema?.displayName || task.displayName;

    const card = document.createElement('article');
    card.className = 'task-card';
    card.dataset.taskKey = key;
    card.dataset.kind = kind;

    const header = document.createElement('header');
    header.className = 'task-card__header';
    const identity = document.createElement('div');
    identity.className = 'task-card__identity';
    const titleRow = document.createElement('div');
    titleRow.className = 'task-card__title-row';
    const name = document.createElement('div');
    name.className = 'task-card__name';
    name.textContent = displayName;
    name.title = task.module;
    titleRow.appendChild(name);
    const kindChip = document.createElement('span');
    kindChip.className = 'task-card__kind';
    kindChip.textContent = kind === 'trigger' ? t('triggerTask') : t('oneTimeTask');
    titleRow.appendChild(kindChip);
    titleRow.appendChild(buildStatusBadge());
    const className = document.createElement('div');
    className.className = 'task-card__class';
    className.textContent = `${task.className} · ${task.module}`;
    identity.append(titleRow, className);
    if (schema?.description) {
      const description = document.createElement('div');
      description.className = 'task-card__description';
      description.textContent = schema.description;
      identity.appendChild(description);
    }

    const actions = document.createElement('div');
    actions.className = 'task-card__actions';
    actions.appendChild(kind === 'trigger' ? buildTriggerToggle(task) : buildLaunchButton(task));
    header.append(identity, actions);

    const configPanel = buildConfigPanel(task, schema);
    if (state.openPanels.has(key)) configPanel.classList.add('open');
    const footer = document.createElement('footer');
    footer.className = 'task-card__footer';
    const configToggle = createButton(
      'task-card__config-toggle secondary',
      configPanel.classList.contains('open') ? `▲ ${t('collapseParameters')}` : `⚙ ${t('parameters')}`,
      () => {
        const open = configPanel.classList.toggle('open');
        if (open) state.openPanels.add(key); else state.openPanels.delete(key);
        configToggle.textContent = open ? `▲ ${t('collapseParameters')}` : `⚙ ${t('parameters')}`;
      },
    );
    footer.appendChild(configToggle);
    card.append(header, footer, configPanel);
    return card;
  }

  /** 单个卡片的执行状态：触发任务看入列/轮询，一次性任务看排队/执行 */
  function cardState(card) {
    const executor = state.executor;
    const key = card.dataset.taskKey;
    const isTrigger = card.dataset.kind === 'trigger';
    const current = executor.current === key;
    if (current) return isTrigger ? 'polling' : 'running';
    if (isTrigger) {
      // 只有勾了「启用」才算数；但执行器没跑时不能显示「已入列」——
      // 否则会让人误以为在轮询。此时用「已启用」表达「已记录，待启动」。
      if (!triggerEnabled(key)) return 'disabled';
      return executorRunning() ? 'enqueued' : 'armed';
    }
    return executor.onetimeQueue.indexOf(key) >= 0 ? 'queued' : '';
  }

  /** 执行器是否已拉起（含连接中） */
  function executorRunning() {
    const status = state.executor.status;
    return status === 'running' || status === 'connecting';
  }

  function updateRunningState() {
    for (const card of elements.tasks.querySelectorAll('.task-card')) {
      const status = cardState(card);
      card.classList.toggle('is-active', status === 'polling' || status === 'running');
      const badge = card.querySelector('[data-role="status"]');
      if (badge) {
        badge.hidden = !status;
        badge.className = `task-card__status is-${status || 'none'}`;
        badge.textContent = status ? t(BADGE_LABELS[status]) : '';
      }
      const toggle = card.querySelector('[data-role="trigger-toggle"]');
      if (toggle) {
        const enabled = triggerEnabled(card.dataset.taskKey);
        if (toggle.checked !== enabled) toggle.checked = enabled;
      }
      const launch = card.querySelector('[data-role="launch"]');
      if (launch) launch.disabled = status === 'queued' || status === 'running';
    }
    updateToolbar();
  }

  function updateToolbar() {
    const executor = state.executor;
    const active = executor.status === 'running' || executor.status === 'connecting';
    let text = t('executorIdle');
    let level = 'idle';
    if (executor.status === 'connecting') {
      text = t('executorConnecting');
      level = 'connecting';
    } else if (executor.status === 'running') {
      if (executor.paused) {
        text = t('executorPaused');
        level = 'paused';
      } else {
        text = t('executorRunning', { count: executor.enabledTriggers.length });
        level = 'running';
      }
    }
    elements.executorState.textContent = text;
    elements.executorState.className = `executor-state is-${level}`;

    // 显式启动：执行器起来之前才显示，起来后让位给暂停/停止
    elements.startExecutor.hidden = active;
    elements.startExecutor.disabled = active;
    elements.startExecutor.textContent = `▶ ${t('startExecutor')}`;
    elements.pauseToggle.hidden = !active;
    elements.pauseToggle.disabled = executor.status !== 'running';
    elements.pauseToggle.textContent = executor.paused ? `▶ ${t('resume')}` : `⏸ ${t('pause')}`;
    elements.stopCurrent.hidden = !active;
    elements.stopCurrent.disabled = !executor.current;
    elements.stopCurrent.textContent = `⏹ ${t('stopCurrent')}`;
    elements.stopExecutor.hidden = !active;
  }

  function renderTasks(tasks) {
    state.currentTasks = tasks;
    const fragment = document.createDocumentFragment();
    for (const task of tasks) fragment.appendChild(buildTaskCard(task));
    elements.tasks.replaceChildren(fragment);
    elements.empty.hidden = tasks.length > 0;
    updateRunningState();
  }

  globalThis.TaskLauncherTaskCard = { renderTasks, updateRunningState };
})();
