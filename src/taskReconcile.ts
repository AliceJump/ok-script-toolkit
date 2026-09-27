/** The runtime schema keys are the exact identifiers accepted by run_executor. */
export interface ListedTask {
  module: string;
  className: string;
  displayName: string;
  kind?: 'onetime' | 'trigger';
}

export interface ListedSchema {
  displayName?: string;
  kind?: 'onetime' | 'trigger';
}

/** Cache is only a hint for the first paint: the fresh AST list owns membership. */
export function reconcileCachedTaskList(
  astTasks: ListedTask[],
  cachedSchemas: Record<string, ListedSchema>,
): ListedTask[] {
  if (Object.keys(cachedSchemas).length === 0) return astTasks;
  return astTasks.map((task) => {
    const schema = cachedSchemas[`${task.module}::${task.className}`];
    return schema ? {
      ...task,
      displayName: schema.displayName || task.displayName,
      kind: schema.kind || task.kind || 'onetime',
    } : task;
  });
}

/** Keep the AST list for the first paint, then replace it with runtime tasks. */
export function reconcileTaskList(
  astTasks: ListedTask[],
  schemas: Record<string, ListedSchema>,
): ListedTask[] {
  if (Object.keys(schemas).length === 0) return astTasks;
  const astByKey = new Map(astTasks.map((task) => [`${task.module}::${task.className}`, task]));
  const result: ListedTask[] = [];
  for (const [key, schema] of Object.entries(schemas)) {
    const separator = key.lastIndexOf('::');
    if (separator <= 0 || separator >= key.length - 2) continue;
    const module = key.slice(0, separator);
    const className = key.slice(separator + 2);
    const ast = astByKey.get(key);
    result.push({
      module,
      className,
      displayName: schema.displayName || ast?.displayName || className,
      kind: schema.kind || ast?.kind || 'onetime',
    });
  }
  return result;
}
