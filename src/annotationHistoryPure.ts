/** Undo/redo history shared by the unified template/rect/point annotation editor. */

export type AnnotationMode = 'template' | 'rect' | 'point';

export interface HistoryTransaction<T> {
  id: number;
  mode: AnnotationMode;
  before: T;
  after: T;
  applied: boolean;
}

export interface HistoryAction<T> {
  transaction: HistoryTransaction<T>;
  value: T;
}

const MODES: readonly AnnotationMode[] = ['template', 'rect', 'point'];

export class AnnotationHistory<T> {
  private nextId = 1;
  private shared = true;
  private readonly undoGlobal: HistoryTransaction<T>[] = [];
  private readonly redoGlobal: HistoryTransaction<T>[] = [];
  private readonly undoByMode = new Map<AnnotationMode, HistoryTransaction<T>[]>();
  private readonly redoByMode = new Map<AnnotationMode, HistoryTransaction<T>[]>();

  constructor(shared = true) {
    this.shared = shared;
    for (const mode of MODES) {
      this.undoByMode.set(mode, []);
      this.redoByMode.set(mode, []);
    }
  }

  get sharedHistory(): boolean { return this.shared; }

  setSharedHistory(value: boolean): void {
    this.shared = value;
  }

  push(mode: AnnotationMode, before: T, after: T): HistoryTransaction<T> {
    const transaction: HistoryTransaction<T> = {
      id: this.nextId++,
      mode,
      before,
      after,
      applied: true,
    };
    this.undoGlobal.push(transaction);
    this.undoByMode.get(mode)!.push(transaction);
    // A new edit invalidates redo only for histories that can reach that edit.
    this.redoGlobal.length = 0;
    this.redoByMode.get(mode)!.length = 0;
    return transaction;
  }

  undo(activeMode: AnnotationMode): HistoryAction<T> | undefined {
    const source = this.shared ? this.undoGlobal : this.undoByMode.get(activeMode)!;
    const transaction = popMatching(source, item => item.applied && (this.shared || item.mode === activeMode));
    if (!transaction) return undefined;
    transaction.applied = false;
    this.redoGlobal.push(transaction);
    this.redoByMode.get(transaction.mode)!.push(transaction);
    return { transaction, value: transaction.before };
  }

  redo(activeMode: AnnotationMode): HistoryAction<T> | undefined {
    const source = this.shared ? this.redoGlobal : this.redoByMode.get(activeMode)!;
    const transaction = popMatching(source, item => !item.applied && (this.shared || item.mode === activeMode));
    if (!transaction) return undefined;
    transaction.applied = true;
    this.undoGlobal.push(transaction);
    this.undoByMode.get(transaction.mode)!.push(transaction);
    return { transaction, value: transaction.after };
  }

  canUndo(activeMode: AnnotationMode): boolean {
    const source = this.shared ? this.undoGlobal : this.undoByMode.get(activeMode)!;
    return source.some(item => item.applied && (this.shared || item.mode === activeMode));
  }

  canRedo(activeMode: AnnotationMode): boolean {
    const source = this.shared ? this.redoGlobal : this.redoByMode.get(activeMode)!;
    return source.some(item => !item.applied && (this.shared || item.mode === activeMode));
  }

  clear(): void {
    this.undoGlobal.length = 0;
    this.redoGlobal.length = 0;
    for (const mode of MODES) {
      this.undoByMode.get(mode)!.length = 0;
      this.redoByMode.get(mode)!.length = 0;
    }
  }
}

function popMatching<T>(stack: HistoryTransaction<T>[], predicate: (item: HistoryTransaction<T>) => boolean): HistoryTransaction<T> | undefined {
  while (stack.length) {
    const item = stack.pop()!;
    if (predicate(item)) return item;
  }
  return undefined;
}
