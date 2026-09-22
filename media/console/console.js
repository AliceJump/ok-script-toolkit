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
  const { t, post, state, elements, taskKey } = globalThis.TaskLauncherCore;

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
    $('segTasks').addEventListener('click', () => switchSeg('tasks'));
    $('segGame').addEventListener('click', () => switchSeg('game'));

    // 任务分段
    const search = $('taskSearch');
    search.placeholder = t('searchTasks');
    search.addEventListener('input', () => globalThis.TaskLauncherTaskCard.setSearch(search.value));
    const refresh = $('refresh');
    refresh.textContent = '↻';
    refresh.title = t('refresh');
    refresh.setAttribute('aria-label', t('refresh'));
    $('consoleHint').textContent = t('consoleHint');
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

  globalThis.TaskLauncherConsole = {
    init,
    switchSeg,
    renderGame,
    onConnectDone,
    openDrawer,
    closeDrawer,
    refreshDrawer,
  };
})();
