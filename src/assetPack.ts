/**
 * assetPack.ts — saveToAssets 打包 page 渲染的 worker 池（主线程侧）。
 *
 * 调度模型：renderPagesViaPool 按 worker 数开若干条 async 流水线，每条从
 * 任务列表顺序取 page 提交给空闲 worker；worker 直接写盘，回包仅携带元信息。
 * 任一 worker 崩溃/退出时其在飞任务置失败，整个渲染以异常结束，由调用方
 * （templateAssetData.saveToAssets）按文件存在性对缺失 page 做主线程内联回退。
 *
 * 本模块不 import vscode，保证可在纯 node 环境单测。
 */
import { Worker } from 'worker_threads';
import * as path from 'path';

export interface AssetPackPageTask {
  W: number;
  H: number;
  outPath: string;
  sources: Array<{ imagePath: string; rects: Array<[number, number, number, number]> }>;
}

/** worker 池不可用（未初始化 / worker 启动失败 / 全部退出） */
export class AssetPackUnavailableError extends Error {}

/** 用户取消（渲染中途检测到取消信号） */
export class AssetPackCancelledError extends Error {}

interface PageReply {
  id: number;
  bytes: number;
  skipped: string[];
  error?: string;
}

interface PendingEntry {
  resolve: (reply: PageReply) => void;
  reject: (err: Error) => void;
}

interface QueuedEntry extends PendingEntry {
  id: number;
  task: AssetPackPageTask;
}

interface PoolWorkerState {
  worker: Worker;
  busy: boolean;
  inflight: Set<number>;
}

let poolExtPath = '';
let poolMax = 2;
let poolEnabled = false;
let poolStates: PoolWorkerState[] = [];
const pendingReplies = new Map<number, PendingEntry>();
const taskQueue: QueuedEntry[] = [];
let nextTaskId = 1;

/** 扩展激活时调用一次；maxWorkers 即 page 渲染并行度（内存峰值≈N×(画布+一张解码图)） */
export function initAssetPackPool(extensionPath: string, maxWorkers = 2): void {
  poolExtPath = extensionPath;
  poolMax = Math.max(1, maxWorkers);
  poolEnabled = true;
}

export function isAssetPackPoolInitialized(): boolean {
  return poolEnabled;
}

function workerScriptPath(): string {
  // out/assetPackWorker.js 是本仓库 tsc 编译产物，与 out/extension.js 同目录
  return path.join(poolExtPath, 'out', 'assetPackWorker.js');
}

function ensureWorkers(): void {
  if (!poolEnabled) return;
  while (poolStates.length < poolMax) {
    let worker: Worker;
    try {
      worker = new Worker(workerScriptPath());
    } catch {
      // worker 脚本缺失（如未编译的开发目录）：标记不可用，调用方走内联回退
      poolEnabled = false;
      return;
    }
    const state: PoolWorkerState = { worker, busy: false, inflight: new Set() };
    worker.on('message', (msg: PageReply) => {
      state.busy = false;
      state.inflight.delete(msg.id);
      const settle = pendingReplies.get(msg.id);
      pendingReplies.delete(msg.id);
      if (settle) {
        if (msg.error) settle.reject(new Error(`asset pack worker: ${msg.error}`));
        else settle.resolve(msg);
      }
      pump();
    });
    const fail = (message: string) => {
      const idx = poolStates.indexOf(state);
      if (idx >= 0) poolStates.splice(idx, 1);
      for (const id of state.inflight) {
        const settle = pendingReplies.get(id);
        pendingReplies.delete(id);
        settle?.reject(new Error(message));
      }
      state.inflight.clear();
      state.busy = false;
      pump();
    };
    worker.on('error', (err) => fail(`asset pack worker crashed: ${String(err)}`));
    worker.on('exit', () => fail('asset pack worker exited'));
    poolStates.push(state);
  }
}

function dispatch(state: PoolWorkerState, entry: QueuedEntry): void {
  pendingReplies.set(entry.id, { resolve: entry.resolve, reject: entry.reject });
  try {
    state.worker.postMessage({
      id: entry.id,
      W: entry.task.W,
      H: entry.task.H,
      outPath: entry.task.outPath,
      sources: entry.task.sources,
    });
    state.busy = true;
    state.inflight.add(entry.id);
  } catch (err) {
    state.busy = false;
    pendingReplies.delete(entry.id);
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function pump(): void {
  if (!poolEnabled) return;
  ensureWorkers();
  if (poolStates.length === 0) {
    // 无存活 worker：排队任务立即失败，避免调用方悬挂
    while (taskQueue.length > 0) {
      taskQueue.shift()!.reject(new AssetPackUnavailableError('no live asset pack worker'));
    }
    return;
  }
  for (const state of poolStates) {
    if (state.busy || taskQueue.length === 0) continue;
    dispatch(state, taskQueue.shift()!);
  }
}

function submit(task: AssetPackPageTask): Promise<PageReply> {
  return new Promise<PageReply>((resolve, reject) => {
    const entry: QueuedEntry = { id: nextTaskId++, task, resolve, reject };
    const free = poolStates.find((s) => !s.busy);
    if (free) dispatch(free, entry);
    else taskQueue.push(entry);
  });
}

/**
 * 并行渲染全部 page。worker 数即并行度；onProgress 在每个 page 完成时回调
 * （完成顺序可能乱序，done 单调递增）。cancelled 返回 true 时停止派发并抛出
 * AssetPackCancelledError（已在飞的 page 会跑完，文件照常落盘）。
 *
 * 失败语义：任一任务失败即整体抛错，已写盘的 page 保留，调用方按文件存在性
 * 决定哪些 page 需要内联回退重渲。
 */
export async function renderPagesViaPool(
  tasks: AssetPackPageTask[],
  onProgress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<void> {
  if (!poolEnabled) throw new AssetPackUnavailableError('asset pack pool not initialized');
  if (tasks.length === 0) return;
  ensureWorkers();
  if (poolStates.length === 0) throw new AssetPackUnavailableError('asset pack worker failed to start');

  let next = 0;
  let done = 0;
  const runner = async (): Promise<void> => {
    while (next < tasks.length) {
      if (cancelled?.()) throw new AssetPackCancelledError('save to assets cancelled');
      const idx = next++;
      await submit(tasks[idx]);
      done++;
      try { onProgress?.(done, tasks.length); } catch { /* 进度回调异常不阻断渲染 */ }
    }
  };
  const lanes = Math.max(1, Math.min(poolMax, tasks.length));
  await Promise.all(Array.from({ length: lanes }, () => runner()));
}

/** 销毁 worker 池：失败所有等待中的任务并终止线程 */
export function disposeAssetPackPool(): void {
  poolEnabled = false;
  for (const settle of pendingReplies.values()) {
    settle.reject(new AssetPackUnavailableError('asset pack pool disposed'));
  }
  pendingReplies.clear();
  while (taskQueue.length > 0) {
    taskQueue.shift()!.reject(new AssetPackUnavailableError('asset pack pool disposed'));
  }
  for (const s of poolStates) {
    try { s.worker.terminate(); } catch { /* 忽略 */ }
  }
  poolStates = [];
}
