import { tr } from '../localization';

/** 状态横幅里的「下一步」按钮：webview 只回传动作 id，宿主决定怎么做 */
export type StatusAction = 'showLogs' | 'openProjectSetting' | 'openPythonSetting' | 'startExecutor' | 'refresh' | 'stopExecutor';

export function statusActionLabel(action: StatusAction): string {
  switch (action) {
    case 'showLogs': return tr('Show Logs');
    case 'openProjectSetting': return tr('Set Project Path');
    case 'openPythonSetting': return tr('Set Python Path');
    case 'startExecutor': return tr('Retry');
    case 'refresh': return tr('Reload Tasks');
    case 'stopExecutor': return tr('Stop Executor');
  }
}

/** 宿主侧执行器状态摘要：供状态栏、视图徽标和 context key 使用 */
export interface ExecutorStateSummary {
  status: 'idle' | 'connecting' | 'running';
  paused: boolean;
  /** 当前任务显示名（空闲为空） */
  current: string;
  /** 一次性任务等待数 */
  queued: number;
  /** 已启用的触发任务数 */
  triggers: number;
}

