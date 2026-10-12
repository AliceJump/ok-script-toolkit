/**
 * 悬停里的命令链接（纯函数，不依赖 vscode，便于快照测试）。
 * MarkdownString 只放行 HOVER_ENABLED_COMMANDS 里的本插件命令（isTrusted.enabledCommands）。
 */
export const HOVER_ENABLED_COMMANDS = [
  'okScriptToolkit.revealResource',
  'okScriptToolkit.findTemplateReferences',
] as const;

function commandUri(command: string, args: unknown[]): string {
  // encodeURIComponent 不编码 ( ) ，它们会提前闭合 markdown 链接
  const query = encodeURIComponent(JSON.stringify(args)).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `command:${command}?${query}`;
}

/** 模板悬停底部的链接行：在资源中定位 · 查找引用 */
export function featureHoverLinks(name: string, labels: { reveal: string; refs: string }): string {
  return [
    `[$(search) ${labels.reveal}](${commandUri('okScriptToolkit.revealResource', [name])})`,
    `[$(references) ${labels.refs}](${commandUri('okScriptToolkit.findTemplateReferences', [name])})`,
  ].join(' · ');
}
