/**
 * Pure tree model for the Run view. UI-free so it can be unit-tested without vscode.
 * Node ids are stable strings used as TreeItem.id / contextValue prefixes.
 */
import type { ExecutorStateSummary } from './status';
import type { GlobalConfigGroup, TaskInfo, TaskSchema } from './types';

export type RunNodeKind =
  | 'game'
  | 'executor'
  | 'triggers'
  | 'trigger'
  | 'onetimes'
  | 'group'
  | 'task'
  | 'globals'
  | 'globalGroup'
  | 'accounts'
  | 'account';

export interface RunTreeNode {
  id: string;
  kind: RunNodeKind;
  label: string;
  description?: string;
  /** VS Code contextValue for menus (e.g. run.task.running) */
  contextValue: string;
  collapsible: boolean;
  checkbox?: boolean;
  checked?: boolean;
  icon?: string;
  children?: RunTreeNode[];
  /** Task key module::className when applicable */
  taskKey?: string;
  groupName?: string;
  accountName?: string;
}

export interface GameSnapshot {
  connected: boolean;
  title?: string;
  detail?: string;
}

export interface RunTreeInput {
  game: GameSnapshot;
  executor: ExecutorStateSummary;
  tasks: TaskInfo[];
  schemas: Record<string, TaskSchema>;
  enabledTriggers: Set<string> | string[];
  currentTaskKey?: string | null;
  onetimeQueue?: string[];
  globalGroups: GlobalConfigGroup[];
  globalOverrides: Record<string, Record<string, unknown>>;
  accounts?: { available: boolean; names: string[]; active?: string };
}

export function taskKeyOf(task: TaskInfo): string {
  return `${task.module}::${task.className}`;
}

function enabledSet(input: RunTreeInput): Set<string> {
  return input.enabledTriggers instanceof Set
    ? input.enabledTriggers
    : new Set(input.enabledTriggers);
}

function groupOf(task: TaskInfo, schemas: Record<string, TaskSchema>): string {
  const schema = schemas[taskKeyOf(task)];
  return (schema?.groupName || '').trim() || '';
}

function taskDescription(
  task: TaskInfo,
  input: RunTreeInput,
  enabled: Set<string>,
): string {
  const key = taskKeyOf(task);
  const isTrigger = task.kind === 'trigger';
  if (input.currentTaskKey === key) {
    return input.executor.paused ? '已暂停' : (isTrigger ? '轮询中' : '运行中');
  }
  if (isTrigger) {
    if (!enabled.has(key)) return '未启用';
    return input.executor.status === 'running' ? '已入列' : '已启用';
  }
  const queue = input.onetimeQueue || [];
  const idx = queue.indexOf(key);
  if (idx >= 0) return `排队 #${idx + 1}`;
  return '';
}

function taskContext(task: TaskInfo, input: RunTreeInput): string {
  const key = taskKeyOf(task);
  if (input.currentTaskKey === key) return 'run.task.running';
  if (task.kind === 'trigger') return 'run.task.trigger';
  return 'run.task.onetime';
}

/** Build the full Run tree from a snapshot. */
export function buildRunTree(input: RunTreeInput): RunTreeNode[] {
  const enabled = enabledSet(input);
  const triggers = input.tasks.filter((t) => t.kind === 'trigger');
  const onetimes = input.tasks.filter((t) => t.kind !== 'trigger');
  const enabledCount = triggers.filter((t) => enabled.has(taskKeyOf(t))).length;

  const game: RunTreeNode = {
    id: 'game',
    kind: 'game',
    label: '游戏',
    description: input.game.connected
      ? (input.game.title ? `已连接 · ${input.game.title}` : '已连接')
      : '未连接',
    contextValue: input.game.connected ? 'run.game.connected' : 'run.game.disconnected',
    collapsible: false,
    icon: input.game.connected ? 'vm-active' : 'vm',
  };

  const execLabel = (() => {
    const s = input.executor;
    if (s.status === 'idle') return '未启动';
    if (s.status === 'connecting') return '启动中…';
    if (s.paused) return s.current ? `已暂停 · ${s.current}` : '已暂停';
    if (s.current) return `运行中 · ${s.current}`;
    return '就绪';
  })();
  const executor: RunTreeNode = {
    id: 'executor',
    kind: 'executor',
    label: '执行器',
    description: execLabel,
    contextValue: `run.executor.${input.executor.status}${input.executor.paused ? '.paused' : ''}`,
    collapsible: false,
    icon: input.executor.status === 'running'
      ? (input.executor.paused ? 'debug-pause' : 'play-circle')
      : 'circle-outline',
  };

  const triggerChildren: RunTreeNode[] = triggers.map((task) => {
    const key = taskKeyOf(task);
    return {
      id: `trigger:${key}`,
      kind: 'trigger' as const,
      label: task.displayName,
      description: taskDescription(task, input, enabled),
      contextValue: taskContext(task, input),
      collapsible: false,
      checkbox: true,
      checked: enabled.has(key),
      icon: 'zap',
      taskKey: key,
    };
  });

  const triggerRoot: RunTreeNode = {
    id: 'triggers',
    kind: 'triggers',
    label: '触发任务',
    description: triggers.length
      ? `${enabledCount}/${triggers.length} 已启用`
      : '无',
    contextValue: 'run.triggers',
    collapsible: true,
    icon: 'zap',
    children: triggerChildren,
  };

  // Group onetimes by schema.groupName; empty → 未分组
  const groups = new Map<string, TaskInfo[]>();
  for (const task of onetimes) {
    const g = groupOf(task, input.schemas) || '未分组';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(task);
  }
  const groupNames = [...groups.keys()].sort((a, b) => {
    if (a === '未分组') return 1;
    if (b === '未分组') return -1;
    return a.localeCompare(b, 'zh');
  });

  const queueLen = (input.onetimeQueue || []).length;
  const onetimeChildren: RunTreeNode[] = groupNames.map((name) => {
    const tasks = groups.get(name)!;
    const children = tasks.map((task) => {
      const key = taskKeyOf(task);
      return {
        id: `task:${key}`,
        kind: 'task' as const,
        label: task.displayName,
        description: taskDescription(task, input, enabled),
        contextValue: taskContext(task, input),
        collapsible: false,
        icon: input.currentTaskKey === key ? 'play' : 'circle-large-outline',
        taskKey: key,
      };
    });
    return {
      id: `group:${name}`,
      kind: 'group' as const,
      label: name,
      description: String(tasks.length),
      contextValue: 'run.group',
      collapsible: true,
      icon: 'folder',
      groupName: name,
      children,
    };
  });

  const onetimeRoot: RunTreeNode = {
    id: 'onetimes',
    kind: 'onetimes',
    label: '一次性任务',
    description: onetimes.length
      ? `${onetimes.length}${queueLen ? ` · 队列 ${queueLen}` : ''}`
      : '无',
    contextValue: 'run.onetimes',
    collapsible: true,
    icon: 'list-ordered',
    children: onetimeChildren,
  };

  const overrideCount = Object.values(input.globalOverrides || {})
    .reduce((n, g) => n + Object.keys(g || {}).length, 0);
  const globalChildren: RunTreeNode[] = (input.globalGroups || []).map((g) => {
    const overrides = Object.keys(input.globalOverrides?.[g.name] || {}).length;
    return {
      id: `global:${g.name}`,
      kind: 'globalGroup' as const,
      label: g.displayName || g.name,
      description: overrides ? `${overrides} 处覆盖` : undefined,
      contextValue: 'run.globalGroup',
      collapsible: false,
      icon: 'settings-gear',
      groupName: g.name,
    };
  });
  const globals: RunTreeNode = {
    id: 'globals',
    kind: 'globals',
    label: '全局配置',
    description: input.globalGroups.length
      ? `${input.globalGroups.length} 组${overrideCount ? ` · ${overrideCount} 处覆盖` : ''}`
      : '无',
    contextValue: 'run.globals',
    collapsible: true,
    icon: 'settings-gear',
    children: globalChildren,
  };

  const accountNames = input.accounts?.names || [];
  const accountChildren: RunTreeNode[] = accountNames.map((name) => ({
    id: `account:${name}`,
    kind: 'account' as const,
    label: name,
    description: input.accounts?.active === name ? '当前' : undefined,
    contextValue: 'run.account',
    collapsible: false,
    icon: 'account',
    accountName: name,
  }));
  const accounts: RunTreeNode = {
    id: 'accounts',
    kind: 'accounts',
    label: '账号',
    description: input.accounts?.available
      ? (input.accounts.active
        ? `${input.accounts.active} · ${accountNames.length}`
        : String(accountNames.length))
      : '不可用',
    contextValue: 'run.accounts',
    collapsible: accountNames.length > 0,
    icon: 'organization',
    children: accountChildren,
  };

  return [game, executor, triggerRoot, onetimeRoot, globals, accounts];
}
