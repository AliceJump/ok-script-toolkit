/**
 * ok-script 控制台 —— 前端控制层。
 *
 * 职责：
 * 1. 分段切换（任务 / 游戏）与全局状态条游戏行、游戏分段卡片的渲染；
 * 2. 参数抽屉：点击任务卡片「参数」按钮把该任务的参数表单**搬运**进抽屉。
 *    表单 DOM 仍由 configPanel.js 随卡片构建（保持既有契约与测试兼容），
 *    抽屉只是它的另一个宿主位置，关闭时归还原位；
 * 3. 静态文案绑定与一次性事件接线（app.js 加载后调用 init()）。
 */
(() => {
  const { t, post, state, elements, taskKey, uiState } = globalThis.TaskLauncherCore;

  const $ = (id) => document.getElementById(id);

  // ── 分段切换 ─────────────────────────────────────────────────────────

  function switchSeg(seg) {
    for (const button of document.querySelectorAll('.seg__btn')) {
      const active = button.dataset.seg === seg;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    $('pageTasks').hidden = seg !== 'tasks';
    $('pageGame').hidden = seg !== 'game';
    $('pageConfig').hidden = seg !== 'config';
    $('pageAccounts').hidden = seg !== 'accounts';  }

  // ── 配置分段：全局配置组卡片（复用 configPanel，伪 task = __global__::组名） ──

  const GLOBAL_MODULE = '__global__';

  /** 把全局组快照镜像进 taskConfigs 的伪键，让 buildConfigPanel 的读写路径原样工作 */
  function syncGlobalPseudoTasks(groups, snapshots) {
    for (const group of groups) {
      const key = `${GLOBAL_MODULE}::${group.name}`;
      if (!state.taskConfigs[key]) state.taskConfigs[key] = {};
      state.taskConfigs[key] = {
        ...state.taskConfigs[key],
        params: { ...(snapshots[group.name] || {}) },
      };
    }
  }

  function renderConfig(groups, snapshots, expanded) {
    state.globalGroups = groups || [];
    state.globalSnapshots = snapshots || {};
    state.expandedGlobalGroups = Array.isArray(expanded) ? expanded : [];
    syncGlobalPseudoTasks(state.globalGroups, state.globalSnapshots);
    const host = $('configList');
    if (!host) return;
    host.replaceChildren();
    if (!state.globalGroups.length) {
      const empty = document.createElement('div');
      empty.className = 'config-empty';
      empty.textContent = t('noConfigParameters');
      host.appendChild(empty);
      return;
    }
    for (const group of state.globalGroups) {
      host.appendChild(buildGlobalCard(group, state.expandedGlobalGroups.includes(group.name)));
    }
  }

  function buildGlobalCard(group, expanded) {
    const fakeTask = { module: GLOBAL_MODULE, className: group.name, displayName: group.displayName || group.name };
    const fakeSchema = { fields: group.fields || [], configGroups: {}, groupLabels: {}, groupSelector: '' };

    const card = document.createElement('section');
    card.className = 'gconfig-card';
    card.dataset.group = group.name;

    const head = document.createElement('header');
    head.className = 'gconfig-card__head gconfig-card__head--toggle';
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    const chev = document.createElement('span');
    chev.className = 'gconfig-card__chev';
    chev.textContent = expanded ? '▾' : '▸';
    const title = document.createElement('div');
    title.className = 'gconfig-card__name';
    title.textContent = group.displayName || group.name;
    if (group.source === 'project_store') {
      const tag = document.createElement('span');
      tag.className = 'tag--store';
      tag.textContent = t('projectStoreTag');
      title.appendChild(tag);
    }
    const desc = document.createElement('div');
    desc.className = 'gconfig-card__desc';
    desc.textContent = group.description || '';
    const meta = document.createElement('div');
    meta.className = 'gconfig-card__meta';
    meta.textContent = t('itemsCount', { count: (group.fields || []).length });
    head.append(chev, title, desc, meta);

    // 折叠切换（头部按钮区不触发切换）：展开状态由宿主持久化，重开面板按上次状态
    const toggle = () => {
      post({ type: 'toggleGlobalGroup', name: group.name, expanded: !expanded });
    };
    head.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      toggle();
    });
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'gconfig-card__actions';
    const sync = document.createElement('button');
    sync.className = 'btn-mini';
    sync.textContent = `⇄ ${t('syncDefaultBtn')}`;
    sync.addEventListener('click', () => post({ type: 'syncDefault', target: 'global', name: group.name }));
    const reset = document.createElement('button');
    reset.className = 'btn-mini';
    reset.textContent = `⟲ ${t('resetDefaultBtn')}`;
    reset.addEventListener('click', () => post({ type: 'resetDefault', target: 'global', name: group.name }));
    actions.append(sync, reset);
    head.appendChild(actions);

    // 收起的组不构建表单 DOM（伸缩性）；展开状态由宿主 globalGroups 消息驱动重渲染
    const body = document.createElement('div');
    body.className = 'gconfig-card__body';
    body.hidden = !expanded;
    if (expanded) {
      body.appendChild(globalThis.TaskLauncherConfigPanel.buildConfigPanel(fakeTask, fakeSchema));
    }

    card.append(head, body);
    return card;
  }

  // ── 账号分段：多账户存储只读概要（Phase 6 只读呈现，编辑器列后续） ──

  /** 账号选择（模块级保持，重渲染不丢） */
  let accountSelection = { account: '', target: '' };

  function renderMultiAccount(info, store, storeError) {
    state.multiAccount = info || { available: false };
    state.accountStore = store || null;
    const host = $('accountList');
    if (!host) return;
    host.replaceChildren();
    if (!info || info.available !== true) {
      const empty = document.createElement('div');
      empty.className = 'config-empty';
      empty.textContent = t('accountNotAvailable');
      host.appendChild(empty);
      return;
    }
    // 卡 1：账号列表（account_list_text 编辑 + 保存，经 account_store.py 同步注册表）
    // 卡 2：账号 × 任务覆盖编辑器。store 缺失 = account_store.py 读取失败（项目无
    // account_scope_store / venv 缺 ok）——显示具体原因（输出频道有完整细节），绝不显示
    // 可编辑空卡（否则保存必然失败，制造「保存后被重置」的假象）。
    // schemas 未就绪 = probe 还在采集（任务/键筛选数据来自 probe）——显示加载态，
    // 不能显示「未检测到」（probe 完成前无法判定）。
    if (store && !Object.keys(state.schemas || {}).length) {
      const loading = document.createElement('div');
      loading.className = 'config-empty';
      loading.textContent = t('accountLoading');
      host.appendChild(loading);
      return;
    }
    if (store) {
      host.appendChild(buildAccountListCard(info, store));
      host.appendChild(buildAccountOverrideCard(info, store));
      host.appendChild(buildMapCard(info, store));
    } else if (info.hasStoreModule === false) {
      const warn = document.createElement('div');
      warn.className = 'config-broken';
      warn.textContent = `⚠ ${t('accountNoEditor')}`;
      host.appendChild(warn);
    } else {
      const warn = document.createElement('div');
      warn.className = 'config-broken';
      warn.textContent = `⚠ ${t('accountStoreUnavailable')}${storeError ? `\n${storeError}` : ''}\n${t('accountStoreSeeOutput')}`;
      host.appendChild(warn);
    }
  }

  function buildAccountListCard(info, store) {
    const card = document.createElement('section');
    card.className = 'gconfig-card';
    const head = document.createElement('header');
    head.className = 'gconfig-card__head';
    const title = document.createElement('div');
    title.className = 'gconfig-card__name';
    title.textContent = t('accountStoreTitle');
    head.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'gconfig-card__actions';
    const save = document.createElement('button');
    save.className = 'btn-mini';
    save.textContent = t('saveBtn');
    const textarea = document.createElement('textarea');
    textarea.rows = Math.min(6, Math.max(2, (store?.accountListText || '').split('\n').length));
    textarea.value = store?.accountListText || '';
    textarea.style.width = '100%';
    save.addEventListener('click', () => {
      post({ type: 'saveAccountList', text: textarea.value });
      textarea.disabled = true;
      setTimeout(() => { textarea.disabled = false; }, 600);
    });
    const open = document.createElement('button');
    open.className = 'btn-mini';
    open.textContent = t('openDataBtn');
    open.addEventListener('click', () => post({ type: 'openPath', path: info.storePath }));
    actions.append(save, open);
    head.appendChild(actions);
    const body = document.createElement('div');
    body.className = 'gconfig-card__body';
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('div');
    label.className = 'label';
    const kt = document.createElement('div');
    kt.className = 'k';
    kt.textContent = t('accountListLabel');
    label.appendChild(kt);
    row.appendChild(label);
    body.appendChild(row);
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'config-field';
    textarea.style.minHeight = '0';
    fieldWrap.appendChild(textarea);
    body.appendChild(fieldWrap);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = t('accountListHint');
    body.appendChild(hint);
    card.append(head, body);
    return card;
  }

  /** registry/账号名 解析出 accounts 表的实际键（acc_id，兼容旧结构的账号名直键） */
  function resolveAccId(store, username) {
    const registry = store?.registry || {};
    for (const [id, meta] of Object.entries(registry)) {
      if (meta && meta.username === username) return id;
      if (meta && Array.isArray(meta.aliases) && meta.aliases.includes(username)) return id;
    }
    const accounts = store?.accounts || {};
    return username in accounts ? username : '';
  }

  /** 覆盖值（acc_id 下该任务的键值表；无覆盖返回空表）。值按 schema 类型自愈矫正。 */
  function accountOverrideFor(store, username, taskClassName, fields) {
    const accId = resolveAccId(store, username);
    const taskMap = accId ? (store.accounts || {})[accId] : null;
    const raw = (taskMap && taskMap[taskClassName]) || {};
    const fieldsByKey = Object.fromEntries((fields || []).map(f => [f.key, f]));
    const fixed = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = fieldsByKey[key];
      fixed[key] = field ? coerceToFieldType(field, value) : value;
    }
    return fixed;
  }

  /**
   * 把存储值矫正回 schema 字段的类型：早先文本框渲染期间保存过字符串 "True"/"False"，
   * 会在账号覆盖里留下与任务 schema 类型不符的值（bool 键渲染回文本框、sub_configs
   * 分支判断失效）。以 field.default / field.value 的类型为准强制转换。
   */
  function coerceToFieldType(field, value) {
    if (value === undefined || value === null) return value;
    const reference = field.default !== undefined ? field.default : field.value;
    if (typeof reference === 'boolean' && typeof value !== 'boolean') {
      const lowered = String(value).trim().toLowerCase();
      if (lowered === 'true' || lowered === '1') return true;
      if (lowered === 'false' || lowered === '0' || lowered === '') return false;
      return value;
    }
    if (typeof reference === 'number' && typeof value === 'string') {
      const num = Number(value);
      if (!Number.isNaN(num)) return num;
    }
    return value;
  }

  /**
   * 可编辑的任务清单：仅列出「可进多账户」的任务（probe 按项目自己的
   * account_config_rules 算出每个任务的可编辑键集），并附 storageName/键集。
   */
  function editableTasks() {
    const enabled = state.multiAccount?.enabledTasks || {};
    return Object.entries(state.schemas)
      .filter(([key, schema]) => !schema.broken && schema.fields?.length && enabled[key]?.keys?.length)
      .map(([key, schema]) => ({
        key,
        className: enabled[key].storageName || key.split('::')[1] || key,
        name: schema.displayName || key,
        keys: enabled[key].keys,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  function buildAccountOverrideCard(info, store) {
    const card = document.createElement('section');
    card.className = 'gconfig-card';
    const head = document.createElement('header');
    head.className = 'gconfig-card__head gconfig-card__head--toggle';
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    const chev = document.createElement('span');
    chev.className = 'gconfig-card__chev';
    chev.textContent = '▾';
    const title = document.createElement('div');
    title.className = 'gconfig-card__name';
    title.textContent = t('overrideTitle');
    head.appendChild(title);
    const body = document.createElement('div');
    body.className = 'gconfig-card__body';
    // 整卡可折叠——点组头把表单收起只留标题行；状态落盘（uiState）重开复用
    const cardKey = 'cardCollapsed::accountOverride';
    const applyCardOpen = open => {
      chev.textContent = open ? '▾' : '▸';
      body.hidden = !open;
    };
    const setCardOpen = (open, persist = true) => {
      applyCardOpen(open);
      if (persist) uiState.set(cardKey, !open);
    };
    applyCardOpen(uiState.get(cardKey, false) !== true);
    head.addEventListener('click', e => {
      if (e.target.closest('button, select, input, textarea')) return;
      setCardOpen(body.hidden);
    });

    const accounts = (store.accountListText || '').split('\n').map(line => line.trim()).filter(Boolean);
    const taskEntries = editableTasks();
    // 全局组条目只列 enabledTasks 里标 global 的（probe 按项目 Proxy 声明/存储证据判定）——
    // 不是全部全局组（ok-end-field 只有键位/滑索两个组支持账号覆盖）
    const enabledGlobals = new Set(
      Object.entries(state.multiAccount?.enabledTasks || {})
        .filter(([, v]) => v && v.global === true)
        .map(([k]) => k),
    );
    const groupEntries = (state.globalGroups || [])
      .filter(g => enabledGlobals.has(g.name))
      .map(g => ({
        value: `global:${g.name}`,
        label: g.displayName || g.name,
        fields: g.fields || [],
        storageName: g.name,
      }));
    if (!accounts.length || (!taskEntries.length && !groupEntries.length)) {
      const empty = document.createElement('div');
      empty.className = 'config-empty';
      empty.textContent = t('accountNotAvailable');
      body.appendChild(empty);
      card.append(head, body);
      return card;
    }

    const pickRow = (labelText, select) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('div');
      label.className = 'label';
      const kt = document.createElement('div');
      kt.className = 'k';
      kt.textContent = labelText;
      label.appendChild(kt);
      // .config-field 作用域让 select 命中主样式（否则是浏览器原生外观）
      const wrap = document.createElement('div');
      wrap.className = 'config-field';
      wrap.appendChild(select);
      row.append(label, wrap);
      return row;
    };

    const accountSelect = document.createElement('select');
    for (const name of accounts) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      accountSelect.appendChild(opt);
    }
    const targetSelect = document.createElement('select');
    if (taskEntries.length) {
      const og = document.createElement('optgroup');
      og.label = t('taskLabel');
      for (const t of taskEntries) {
        const opt = document.createElement('option');
        opt.value = `task:${t.key}`;
        opt.textContent = t.name;
        og.appendChild(opt);
      }
      targetSelect.appendChild(og);
    }
    if (groupEntries.length) {
      const og = document.createElement('optgroup');
      og.label = t('globalGroupLabel');
      for (const g of groupEntries) {
        const opt = document.createElement('option');
        opt.value = g.value;
        opt.textContent = g.label;
        og.appendChild(opt);
      }
      targetSelect.appendChild(og);
    }
    if (!accounts.includes(accountSelection.account)) accountSelection.account = accounts[0];
    accountSelect.value = accountSelection.account;
    if (![...targetSelect.options].some(o => o.value === accountSelection.target)) {
      accountSelection.target = targetSelect.value;
    }
    targetSelect.value = accountSelection.target;

    const formHost = document.createElement('div');
    formHost.className = 'account-override-form';
    const rebuildForm = () => {
      const target = accountSelection.target || '';
      if (target.startsWith('global:')) {
        // 全局配置组的按账号覆盖（如滑索/键位）：fields 来自 probe 的 globalConfigGroups
        const groupName = target.slice('global:'.length);
        const group = (state.globalGroups || []).find(g => g.name === groupName);
        const override = accountOverrideFor(store, accountSelection.account, groupName);
        const fakeTask = { module: `__account__::${accountSelection.account}`, className: groupName };
        const fakeKey = taskKey(fakeTask);
        state.taskConfigs[fakeKey] = { params: { ...override } };
        const fakeSchema = {
          fields: (group?.fields || []).map(f => ({
            ...f,
            value: (f.key in override) ? override[f.key] : (f.default !== undefined ? f.default : f.value),
          })),
          configGroups: {},
          groupLabels: {},
          groupSelector: '',
        };
        formHost.replaceChildren(
          globalThis.TaskLauncherConfigPanel.buildConfigPanel(fakeTask, fakeSchema, { defaultGroupOpen: true }),
        );
        const clearG = document.createElement('div');
        clearG.style.padding = '6px 12px';
        const clearGBtn = document.createElement('button');
        clearGBtn.className = 'btn-mini';
        clearGBtn.textContent = t('clearOverrideBtn');
        clearGBtn.addEventListener('click', () => {
          post({ type: 'clearAccountOverride', account: accountSelection.account, taskName: groupName });
        });
        clearG.appendChild(clearGBtn);
        formHost.appendChild(clearG);
        return;
      }
      const taskKeySel = target.slice('task:'.length);
      const taskInfo = taskEntries.find(t => t.key === taskKeySel);
      const taskClassName = taskInfo
        ? taskInfo.className
        : (taskKeySel.split('::')[1] || '');
      const allowedKeys = new Set(taskInfo ? taskInfo.keys : []);
      const override = accountOverrideFor(
        store, accountSelection.account, taskClassName, state.schemas[taskKeySel]?.fields,
      );
      const schema = state.schemas[taskKeySel];
      const fakeTask = { module: `__account__::${accountSelection.account}`, className: taskClassName };
      const fakeKey = taskKey(fakeTask);
      state.taskConfigs[fakeKey] = { params: { ...override } };
      const fakeSchema = {
        // 只保留「可进多账户」的配置键（probe 按项目 account_config_rules 算出）
        fields: (schema?.fields || [])
          .filter(f => allowedKeys.has(f.key))
          .map(f => ({
            ...f,
            value: (f.key in override) ? override[f.key] : (f.default !== undefined ? f.default : f.value),
          })),
        configGroups: schema?.configGroups || {},
        groupLabels: schema?.groupLabels || {},
        groupSelector: schema?.groupSelector || '',
      };
      formHost.replaceChildren(
        globalThis.TaskLauncherConfigPanel.buildConfigPanel(fakeTask, fakeSchema, { defaultGroupOpen: true }),
      );
      const clear = document.createElement('div');
      clear.style.padding = '6px 12px';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn-mini';
      clearBtn.textContent = t('clearOverrideBtn');
      clearBtn.addEventListener('click', () => {
        post({ type: 'clearAccountOverride', account: accountSelection.account, taskName: taskClassName });
      });
      clear.appendChild(clearBtn);
      formHost.appendChild(clear);
    };
    accountSelect.addEventListener('change', () => {
      accountSelection.account = accountSelect.value;
      rebuildForm();
    });
    targetSelect.addEventListener('change', () => {
      accountSelection.target = targetSelect.value;
      rebuildForm();
    });
    body.append(
      pickRow(t('accountLabel'), accountSelect),
      pickRow(t('targetLabel'), targetSelect),
    );
    body.appendChild(formHost);
    rebuildForm();

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = t('overrideHint');
    body.appendChild(hint);

    card.append(head, body);
    return card;
  }

  // ── 游戏状态（状态条第一行 + 游戏分段卡片） ──────────────────────────

  function renderGame(game, overlay) {
    const connected = Boolean(game);
    const row = $('gameRow');
    row.classList.toggle('is-ok', connected);
    row.classList.toggle('is-warn', !connected);
    $('gameState').textContent = connected
      ? t('toolboxGameConnected', { title: game.title || String(game.hwnd), pid: game.pid })
      : t('gbarGameIdle');
    $('connectGame').hidden = connected;
    $('disconnectGame').hidden = !connected;

    $('gameCardTitle').textContent = connected ? (game.title || String(game.hwnd)) : t('toolboxGameSection');
    $('gameCardSub').textContent = connected
      ? `PID ${game.pid}${game.exe ? ` · ${game.exe}` : ''}`
      : t('toolboxGameNotConnected');
    $('gameCardConnect').hidden = connected;
    $('gameCardDisconnect').hidden = !connected;
    $('overlayToggle').checked = overlay === true;
  }

  /** 连接流程结束（成功或失败）后解锁连接按钮 */
  function onConnectDone() {
    $('connectGame').disabled = false;
    $('gameCardConnect').disabled = false;
  }

  // ── 参数抽屉（把卡片里的 config-panel 搬运进来，关闭时归还原位） ────

  let drawerTask = null;

  function showDrawer(open) {
    $('drawerBackdrop').hidden = !open;
    $('drawer').hidden = !open;
    $('drawer').setAttribute('aria-hidden', open ? 'false' : 'true');
    $('drawer').classList.toggle('is-open', open);
  }

  /** 抽屉里的面板放回卡片原位（原卡片已被重渲染丢弃时静默跳过） */
  function restorePanel() {
    const panel = $('drawerBody').firstElementChild;
    if (!panel) return;
    const origin = panel.__drawerOrigin;
    if (origin && origin.parent.isConnected) {
      origin.parent.insertBefore(panel, origin.next);
      panel.classList.remove('drawer-hosted');
    }
  }

  /** 把任务卡片里的参数面板搬进抽屉；卡片不在列表中（被搜索过滤）时返回 false */
  function mountPanel(task) {
    const card = elements.tasks.querySelector(`.task-card[data-task-key="${taskKey(task)}"]`);
    const panel = card && card.querySelector('.config-panel');
    if (!panel) return false;
    panel.__drawerOrigin = { parent: panel.parentNode, next: panel.nextSibling };
    panel.classList.add('drawer-hosted');
    $('drawerBody').replaceChildren(panel);
    return true;
  }

  function openDrawer(task) {
    if (!mountPanel(task)) return;
    drawerTask = task;
    const schema = state.schemas[taskKey(task)];
    $('drawerTitle').textContent = schema?.displayName || task.displayName || task.className;
    $('drawerAutoSave').textContent = t('saved');
    showDrawer(true);
  }

  function closeDrawer() {
    restorePanel();
    drawerTask = null;
    showDrawer(false);
  }

  /**
   * 任务列表重渲染（schemas/taskConfigs/搜索更新都会触发）后由 app.js 调用：
   * 旧卡片连同里面的参数面板一起被丢弃了，把当前任务的**新面板**重新搬进抽屉；
   * 任务已不在列表中（过滤/项目切换）则关闭抽屉。
   */
  function refreshDrawer() {
    if (!drawerTask) return;
    if (!mountPanel(drawerTask)) {
      drawerTask = null;
      showDrawer(false);
    }
  }

  // ── 初始化：静态文案 + 一次性事件 ────────────────────────────────────

  function bindGroupHead(headId, kind) {
    const head = $(headId);
    head.addEventListener('click', () => globalThis.TaskLauncherTaskCard.toggleGroup(kind));
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        globalThis.TaskLauncherTaskCard.toggleGroup(kind);
      }
    });
    $(`${headId}Label`).textContent = kind === 'trigger' ? t('triggerTask') : t('oneTimeTask');
  }

  function bindConnect(buttonId) {
    $(buttonId).addEventListener('click', () => {
      $(buttonId).disabled = true;
      post({ type: 'connectGame' });
    });
  }

  function bindDisconnect(buttonId) {
    $(buttonId).addEventListener('click', () => post({ type: 'disconnectGame' }));
  }

  function init() {
    document.title = t('consoleTitle');

    // 分段导航
    $('segTasks').textContent = t('consoleTabTasks');
    $('segGame').textContent = t('consoleTabGame');
    $('segConfig').textContent = t('consoleTabConfig');
    $('segAccounts').textContent = t('consoleTabAccounts');
    $('segTasks').addEventListener('click', () => switchSeg('tasks'));
    $('segGame').addEventListener('click', () => switchSeg('game'));
    $('segConfig').addEventListener('click', () => switchSeg('config'));
    $('segAccounts').addEventListener('click', () => switchSeg('accounts'));

    // 任务分段
    const search = $('taskSearch');
    search.placeholder = t('searchTasks');
    search.addEventListener('input', () => globalThis.TaskLauncherTaskCard.setSearch(search.value));
    const refresh = $('refresh');
    refresh.textContent = '↻';
    refresh.title = t('refresh');
    refresh.setAttribute('aria-label', t('refresh'));
    $('consoleHint').textContent = t('consoleHint');
    $('takeoverBanner').textContent = t('takeoverBanner');
    bindGroupHead('triggerHead', 'trigger');
    bindGroupHead('onetimeHead', 'onetime');

    // 状态条游戏行：点击行主体切到游戏分段（行内按钮的点击不冒泡切换）
    const gameRow = $('gameRow');
    gameRow.title = t('toolboxGameSection');
    gameRow.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      switchSeg('game');
    });
    gameRow.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        switchSeg('game');
      }
    });

    // 游戏连接（状态条行内按钮 + 游戏分段卡片按钮，同一组动作）
    bindConnect('connectGame');
    bindDisconnect('disconnectGame');
    bindConnect('gameCardConnect');
    bindDisconnect('gameCardDisconnect');
    $('connectGame').textContent = t('toolboxConnectGame');
    $('disconnectGame').textContent = t('toolboxDisconnect');
    $('gameCardConnect').textContent = t('toolboxConnectGame');
    $('gameCardDisconnect').textContent = t('toolboxDisconnect');
    $('overlayLabel').textContent = t('debugOverlay');
    $('overlayHint').textContent = t('debugOverlayHint');
    $('overlayToggle').addEventListener('change', () => {
      post({ type: 'setOverlay', enabled: $('overlayToggle').checked });
    });
    const characterButton = $('openCharacterManager');
    characterButton.textContent = t('toolboxOpenCharacterManager');
    characterButton.addEventListener('click', () => post({ type: 'openCharacterManager' }));

    // 抽屉
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawer();
    });
  }

  /** 每账号的地图 content（滑索/地图数据文本）：独立编辑卡 */
  function buildMapCard(info, store) {
    const card = document.createElement('section');
    card.className = 'gconfig-card';
    const head = document.createElement('header');
    head.className = 'gconfig-card__head';
    const title = document.createElement('div');
    title.className = 'gconfig-card__name';
    title.textContent = t('mapContentTitle');
    head.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'gconfig-card__actions';
    const save = document.createElement('button');
    save.className = 'btn-mini';
    save.textContent = t('saveBtn');
    actions.appendChild(save);
    head.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'gconfig-card__body';
    const accounts = (store.accountListText || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!accounts.length) {
      const empty = document.createElement('div');
      empty.className = 'config-empty';
      empty.textContent = t('accountNotAvailable');
      body.appendChild(empty);
      card.append(head, body);
      return card;
    }
    const accountSelect = document.createElement('select');
    for (const name of accounts) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      accountSelect.appendChild(opt);
    }
    const textarea = document.createElement('textarea');
    textarea.rows = 6;
    const loadContent = () => {
      const accId = resolveAccId(store, accountSelect.value);
      textarea.value = accId ? (store.mapContents || {})[accId] || '' : '';
    };
    loadContent();
    accountSelect.addEventListener('change', loadContent);
    save.addEventListener('click', () => {
      post({ type: 'saveAccountMap', account: accountSelect.value, content: textarea.value });
      textarea.disabled = true;
      setTimeout(() => { textarea.disabled = false; }, 600);
    });
    const wrap = document.createElement('div');
    wrap.className = 'config-field';
    textarea.style.minHeight = '0';
    wrap.appendChild(textarea);
    body.appendChild(wrap);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = t('mapContentHint');
    body.appendChild(hint);
    card.append(head, body);
    return card;
  }

  globalThis.TaskLauncherConsole = {
    init,
    switchSeg,
    renderGame,
    onConnectDone,
    openDrawer,
    closeDrawer,
    refreshDrawer,
    renderConfig,
    renderMultiAccount,
  };
})();
