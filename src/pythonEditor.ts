import * as vscode from 'vscode';
import { tr } from './localization';

/* ---------------- 最近 Python 编辑器跟踪（模块级单例） ---------------- */

let lastPythonEditor: vscode.TextEditor | undefined;
let editorTrackerReady = false;

export function ensureEditorTracker(): void {
  if (editorTrackerReady) return;
  editorTrackerReady = true;
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.languageId === 'python') lastPythonEditor = editor;
  });
  const cur = vscode.window.activeTextEditor;
  if (cur && cur.document.languageId === 'python') lastPythonEditor = cur;
}

/** 把文本插入最近活动的 Python 编辑器光标处；无可用编辑器时回退为复制 */
export async function insertIntoPythonEditor(text: string): Promise<void> {
  ensureEditorTracker();
  let editor = lastPythonEditor;
  if (!editor || editor.document.isClosed || !vscode.window.visibleTextEditors.includes(editor)) {
    const act = vscode.window.activeTextEditor;
    editor = act && !act.document.isClosed && act.document.languageId === 'python' ? act
      : vscode.window.visibleTextEditors.find((visible) => !visible.document.isClosed
        && visible.document.languageId === 'python' && visible.document === lastPythonEditor?.document);
  }
  if (editor) {
    lastPythonEditor = editor;
    try {
      if (await editor.insertSnippet(new vscode.SnippetString(text))) return;
    } catch { /* An editor can disappear while the insertion is in flight. */ }
  }
  await vscode.env.clipboard.writeText(text);
  void vscode.window.showWarningMessage(tr('No Python editor is available; copied instead: {text}', { text }));
}

