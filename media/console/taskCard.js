(() => {
  const { t, post, state, elements, taskKey, taskKind, triggerEnabled, uiState } = globalThis.TaskLauncherCore;
  const { buildConfigPanel } = globalThis.TaskLauncherConfigPanel;

  const BADGE_LABELS = {
    disabled: 'triggerDisabled',
    armed: 'triggerArmed',
    enqueued: 'triggerEnqueued',
    polling: 'triggerPolling',
    queued: 'taskQueued',
    running: 'taskRunning',
  };

  /** 搜索过滤 + 分组折叠（模块级：renderTasks 重渲染时保持） */
  let searchQuery = '';
  /**
   * 任务分组折叠状态（kind 级「触发任务/一次性」与一次性任务的业务分组）落盘
   * uiState，重开面板/重启宿主后复用；键前缀统一 taskGroupCollapsed::。
   */
  const groupCollapseKey = key => `taskGroupCollapsed::${key}`;
  const isGroupCollapsed = key => uiState.get(groupCollapseKey(key), false) === true;
  const setGroupCollapsed = (key, collapsed) => uiState.set(groupCollapseKey(key), collapsed);

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

  /** 参数入口：badge 样式按钮，点击把该任务的参数表单搬进抽屉 */
  function buildConfigButton(task) {
    const key = taskKey(task);
    const button = createButton('task-card__config', `⚙ ${t('parameters')}`, () => {
      globalThis.TaskLauncherConsole.openDrawer(task);
    });
    button.dataset.role = 'config-toggle';
    button.dataset.taskKey = key;
    button.classList.toggle('has-overrides', snapshotDiffersFromFactory(key));
    return button;
  }

  /**
   * 全量接管下的覆盖徽标：任一键快照值 ≠ 出厂值，或存在孤儿键（default 已删）。
   * 快照全量化后 params 恒非空，旧的「非空即亮」判断会失去意义。
   */
  function configValuesEqual(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (!configValuesEqual(left[index], right[index])) return false;
      }
      return true;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && configValuesEqual(left[key], right[key]));
  }

  function snapshotDiffersFromFactory(key) {
    const schema = state.schemas[key];
    const params = state.taskConfigs[key]?.params;
    if (!params || !Object.keys(params).length) return false;
    const known = new Set();
    for (const f of schema?.fields || []) {
      known.add(f.key);
      if (f.default !== undefined && f.key in params && !configValuesEqual(params[f.key], f.default)) return true;
    }
    for (const k of Object.keys(params)) {
      if (!known.has(k)) return true;
    }
    return false;
  }

  /** 卡片头部的快照操作：同步 default（并集扩张）/ 恢复默认（出厂值，孤儿键保留） */
  function buildSnapshotButtons(key) {
    const schema = state.schemas[key];
    if (!schema || schema.broken || !schema.fields?.length) return [];
    const sync = createButton('task-card__snap', '⇄', () => {
      post({ type: 'syncDefault', target: 'task', name: key });
    });
    sync.title = t('syncDefaultBtn');
    const reset = createButton('task-card__snap', '⟲', () => {
      post({ type: 'resetDefault', target: 'task', name: key });
    });
    reset.title = t('resetDefaultBtn');
    return [sync, reset];
  }

  /* ── 悬停弹出（body 级单例 + fixed 定位）──────────────────────────
     卡内 absolute + left:calc(100%+12px) 会被任务列表滚动容器的
     overflow 裁掉（lab 里 B/C 布局同款翻车），挂到 body 上用
     getBoundingClientRect + 视口夹紧定位，右缘对齐卡片、优先下方、
     底部放不下自动翻上方。只读无按钮；内容与 configPanel 同源。 */
  let popEl = null;
  let popHideTimer = 0;
  let popSuppressUntil = 0;

  /** 弹层内容：参数分组概要（configGroups / groupLabels / displayKey） */
  function groupPopContent(task, schema) {
    const groups = schema?.configGroups && typeof schema.configGroups === 'object'
      ? Object.entries(schema.configGroups) : [];
    if (!groups.length) return null;
    const labels = Object.fromEntries((schema?.fields || []).map((f) => [f.key, f.displayKey || f.key]));
    const frag = document.createDocumentFragment();
    const title = document.createElement('div');
    title.className = 'pop-title';
    title.textContent = schema?.displayName || task.displayName || '';
    const sub = document.createElement('span');
    sub.className = 'pop-sub';
    sub.textContent = t('depsPopSub', { count: groups.length });
    title.appendChild(sub);
    frag.appendChild(title);
    for (const [key, fieldKeys] of groups) {
      const list = Array.isArray(fieldKeys) ? fieldKeys : [];
      const grp = document.createElement('div');
      grp.className = 'grp';
      const head = document.createElement('div');
      head.className = 'grp-head';
      const name = document.createElement('b');
      name.textContent = schema.groupLabels?.[key] || key;
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = t('itemsCount', { count: list.length });
      head.append(name, cnt);
      const body = document.createElement('div');
      body.className = 'grp-body';
      for (const fieldKey of list.slice(0, 4)) {
        const it = document.createElement('div');
        it.className = 'it';
        const label = document.createElement('span');
        label.textContent = labels[fieldKey] || fieldKey;
        it.appendChild(label);
        body.appendChild(it);
      }
      grp.append(head, body);
      frag.appendChild(grp);
    }
    return frag;
  }

  function hideHoverPop(immediate = false) {
    window.clearTimeout(popHideTimer);
    if (!popEl) return;
    if (immediate) {
      popEl.classList.remove('is-visible');
      return;
    }
    popHideTimer = window.setTimeout(() => popEl?.classList.remove('is-visible'), 120);
  }

  function showHoverPop(card, task, schema) {
    window.clearTimeout(popHideTimer); // 关键：撤掉上一张卡 mouseleave 挂起的隐藏定时器，
    // 否则快速移到相邻卡片时，新弹层显示 ~40ms 后被旧定时器藏掉（真机复现过）
    if (Date.now() < popSuppressUntil) return;
    const content = groupPopContent(task, schema);
    if (!content) return;
    if (!popEl) {
      popEl = document.createElement('div');
      popEl.className = 'gpop';
      popEl.setAttribute('role', 'tooltip');
      popEl.addEventListener('mouseenter', () => window.clearTimeout(popHideTimer));
      popEl.addEventListener('mouseleave', () => hideHoverPop());
      document.body.appendChild(popEl);
    }
    popEl.replaceChildren(content);
    popEl.classList.remove('is-visible'); // 先归零再测量，避免位置跳变闪烁
    const rect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = popEl.offsetWidth;
    const ph = popEl.offsetHeight;
    let left = rect.right - pw - 10; // 右缘对齐卡片右缘
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = rect.bottom + 8; // 优先放下方
    if (top + ph > vh - 8) top = rect.top - ph - 8; // 底部放不下 → 翻上方
    top = Math.max(8, Math.min(top, Math.max(8, vh - ph - 8)));
    popEl.style.left = `${Math.round(left)}px`;
    popEl.style.top = `${Math.round(top)}px`;
    popEl.classList.add('is-visible');
  }

  /** 切分段后短暂抑制弹出（弹出层规范：点 Tab 后 1.2s 内不弹 + 内容淡入重放） */
  function suppressPopups() {
    popSuppressUntil = Date.now() + 1200;
    hideHoverPop(true);
  }

  // 列表滚动 / 窗口缩放时弹层立刻收起，避免钉在旧位置
  window.addEventListener('scroll', () => hideHoverPop(true), { capture: true, passive: true });
  window.addEventListener('resize', () => hideHoverPop(true));

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
    const dot = document.createElement('span');
    dot.className = 'rc-dot';
    dot.setAttribute('aria-hidden', 'true');
    titleRow.appendChild(dot);
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
    actions.appendChild(buildConfigButton(task));
    for (const button of buildSnapshotButtons(key)) actions.appendChild(button);
    actions.appendChild(kind === 'trigger' ? buildTriggerToggle(task) : buildLaunchButton(task));
    header.append(identity, actions);

    // 参数表单仍随卡片构建（保持 DOM 契约与测试兼容），但不再就地展开 ——
    // 点击「参数」按钮时由 console.js 把这个节点搬运进抽屉显示。
    const configPanel = buildConfigPanel(task, schema);
    card.append(header, configPanel);
    // 有参数分组才挂悬停弹出（内容按需构建，body 级单例见 showHoverPop）
    if (schema?.configGroups && Object.keys(schema.configGroups).length) {
      card.classList.add('task-card--pop');
      card.addEventListener('mouseenter', () => showHoverPop(card, task, schema));
      card.addEventListener('mouseleave', () => hideHoverPop());
    }
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
      card.dataset.run = status || 'idle';
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
      // 参数覆盖徽标：全量接管语义——快照值 ≠ 出厂值（或存在孤儿键）时高亮
      const configBtn = card.querySelector('[data-role="config-toggle"]');
      if (configBtn) {
        configBtn.classList.toggle('has-overrides', snapshotDiffersFromFactory(card.dataset.taskKey));
      }
    }
    updateToolbar();
  }

  /** 任务显示名：tasks 列表 → schema → 原始 key 兜底 */
  function displayNameOf(key) {
    const task = state.currentTasks.find((item) => taskKey(item) === key);
    return task?.displayName || state.schemas[key]?.displayName || key;
  }

  /** 执行队列条：一次性队列可视化（队列芯片随 executor 消息刷新） */
  function renderQueueStrip() {
    const strip = document.getElementById('queueStrip');
    if (!strip) return;
    const queue = state.executor.onetimeQueue || [];
    strip.textContent = '';
    if (!queue.length) {
      strip.hidden = true;
      return;
    }
    const head = document.createElement('div');
    head.className = 'rc-queue__head';
    const title = document.createElement('b');
    title.textContent = t('queueTitle');
    head.appendChild(title);
    const chips = document.createElement('div');
    chips.className = 'rc-queue__chips';
    for (const key of queue) {
      const chip = document.createElement('span');
      chip.className = 'rc-queue__chip';
      chip.textContent = displayNameOf(key);
      chips.appendChild(chip);
    }
    strip.append(head, chips);
    strip.hidden = false;
  }

  /** 状态条第二行：当前任务 + 一次性队列（空闲时隐藏） */
  function updateExecutorSub() {
    const sub = document.getElementById('executorSub');
    if (!sub) return;
    const executor = state.executor;
    const parts = [];
    if (executor.current) {
      parts.push(t('executorCurrent', { task: displayNameOf(executor.current) }));
    }
    if (executor.onetimeQueue.length) {
      parts.push(t('executorQueueCount', { count: executor.onetimeQueue.length }));
    }
    sub.hidden = !parts.length;
    sub.textContent = parts.join(' · ');
    renderQueueStrip();
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

    // 状态条圆点与行状态（gbar 由样式按行 class 着色）
    const execRow = document.getElementById('execDot')?.closest('.gbar__row');
    if (execRow) {
      execRow.classList.toggle('is-run', level === 'running' || level === 'connecting');
      execRow.classList.toggle('is-warn', level === 'paused');
      execRow.classList.toggle('is-ok', level === 'idle');
    }
    updateExecutorSub();

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

  /** 搜索匹配：显示名 / 类名 / 模块 / 描述 / 分组名 */
  function matches(task) {
    if (!searchQuery) return true;
    const schema = state.schemas[taskKey(task)];
    const groupName = schema?.groupName || '';
    const haystack = [
      task.displayName,
      schema?.displayName,
      task.className,
      task.module,
      schema?.description,
      groupName ? t(groupName) : '',
    ].filter((value) => typeof value === 'string').join('\n').toLowerCase();
    return haystack.includes(searchQuery);
  }

  function renderGroup(containerId, headId, countId, kind, tasks) {
    const body = document.getElementById(containerId);
    const head = document.getElementById(headId);
    const count = document.getElementById(countId);
    if (!body) return;
    const fragment = document.createDocumentFragment();
    for (const task of tasks) fragment.appendChild(buildTaskCard(task));
    body.replaceChildren(fragment);
    const collapsed = isGroupCollapsed(kind);
    body.classList.toggle('is-collapsed', collapsed);
    if (head) head.classList.toggle('is-collapsed', collapsed);
    if (count) count.textContent = t('taskCount', { count: tasks.length });
  }

  /** 任务分组名（schema.groupName 源文案 key；空 = 未分组） */
  function groupNameOf(task) {
    return state.schemas[taskKey(task)]?.groupName || '';
  }

  /**
   * 一次性任务按 group_name 二级分组渲染（ok-end-field/ok-nte 的业务分组形态）：
   * 每组一个可折叠小节（组头 = 翻译组名 + 计数），缺省归「未分组」；
   * 搜索激活时忽略折叠并只显示有匹配的组。
   */
  function renderGroupedOnetime(containerId, tasks) {
    const body = document.getElementById(containerId);
    if (!body) return;
    const fragment = document.createDocumentFragment();
    const buckets = new Map();
    for (const task of tasks) {
      const name = groupNameOf(task);
      if (!buckets.has(name)) buckets.set(name, []);
      buckets.get(name).push(task);
    }
    const searching = Boolean(searchQuery);
    for (const [name, groupTasks] of buckets) {
      const label = name ? t(name) : t('ungrouped');
      const foldKey = `onetime::${name || '__ungrouped__'}`;
      const collapsed = !searching && isGroupCollapsed(foldKey);
      const head = document.createElement('div');
      head.className = 'subgroup-head';
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      const chev = document.createElement('span');
      chev.className = 'subgroup-head__chev';
      chev.textContent = collapsed ? '▸' : '▾';
      const title = document.createElement('span');
      title.textContent = label;
      const count = document.createElement('span');
      count.className = 'subgroup-head__count';
      count.textContent = t('itemsCount', { count: groupTasks.length });
      head.append(chev, title, count);
      head.addEventListener('click', () => {
        setGroupCollapsed(foldKey, !isGroupCollapsed(foldKey));
        renderTasks(state.currentTasks);
      });
      head.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          head.click();
        }
      });
      fragment.appendChild(head);
      if (collapsed) continue; // 收起的组不渲染卡片 DOM（大列表伸缩性）
      const block = document.createElement('div');
      block.className = 'subgroup-body';
      for (const task of groupTasks) block.appendChild(buildTaskCard(task));
      fragment.appendChild(block);
    }
    body.replaceChildren(fragment);
  }

  function renderTasks(tasks) {
    state.currentTasks = tasks;
    hideHoverPop(true); // 重渲染后旧弹层位置失效，直接收起
    // show_in_task_tab=False 的任务不进列表（框架原生不消费，插件按隐藏对待）
    const listed = tasks.filter((task) => state.schemas[taskKey(task)]?.showInTaskTab !== false);
    const visible = listed.filter(matches);
    renderGroup('gTriggers', 'triggerHead', 'triggerCount', 'trigger', visible.filter((task) => taskKind(task) === 'trigger'));
    renderGroupedOnetime('gOnetime', visible.filter((task) => taskKind(task) !== 'trigger'));
    elements.empty.hidden = listed.length > 0;
    updateRunningState();
  }

  function setSearch(value) {
    searchQuery = String(value || '').trim().toLowerCase();
    renderTasks(state.currentTasks);
  }

  function toggleGroup(kind) {
    setGroupCollapsed(kind, !isGroupCollapsed(kind));
    renderTasks(state.currentTasks);
  }

  globalThis.TaskLauncherTaskCard = { renderTasks, updateRunningState, setSearch, toggleGroup, suppressPopups };
})();
