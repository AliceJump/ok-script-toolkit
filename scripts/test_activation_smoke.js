/**
 * 激活冒烟测试（无 VS Code 进程）：用一个宽松的 vscode 模拟模块加载 package.json main（out/entrypoint.js），
 * 调用 activate()，断言 package.json 里声明的每个命令都注册了、每个视图都有 provider。
 *
 * 局限：这不是 @vscode/test-electron 的真集成测试——不渲染 webview、不跑 Python、不做截图回归。
 * 依赖里没有 test-electron，且 CI/沙箱无显示器也无法下载 VS Code，见 docs/testing.md。
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const registered = new Set();
const providers = new Set();

// 任意属性 / 调用都返回自身的“万能”对象；then 返回 undefined 以免被当成 Promise
function loose(name = 'mock') {
  const fn = function () { return loose(name + '()'); };
  const store = new Map();
  return new Proxy(fn, {
    set(_t, prop, value) { store.set(prop, value); return true; },
    defineProperty(_t, prop, desc) { store.set(prop, desc.value); return true; },
    get(_t, prop) {
      if (store.has(prop)) return store.get(prop);
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'dispose') return () => {};
      if (prop === 'length') return 0;
      return loose(`${name}.${String(prop)}`);
    },
    construct() { return loose(`new ${name}`); },
  });
}
class EventEmitter {
  constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; }
  fire(v) { for (const f of this.l) f(v); }
  dispose() {}
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okst-smoke-'));
const config = { get: (_k, d) => d, has: () => false, inspect: () => undefined, update: async () => {} };
const vscodeMock = new Proxy({
  EventEmitter,
  Disposable: class { constructor(f) { this.f = f; } dispose() { this.f && this.f(); } static from() { return { dispose() {} }; } },
  Uri: { file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }), joinPath: (u, ...s) => ({ fsPath: path.join(u.fsPath, ...s), path: path.join(u.fsPath, ...s) }), parse: (s) => ({ fsPath: s, toString: () => s }) },
  l10n: { t: (s, a) => (typeof s === 'string' ? s : s.message), bundle: undefined, uri: undefined },
  env: { language: 'en', clipboard: { writeText: async () => {} } },
  commands: {
    registerCommand: (id) => { registered.add(id); return { dispose() {} }; },
    registerTextEditorCommand: (id) => { registered.add(id); return { dispose() {} }; },
    executeCommand: async () => undefined,
  },
  window: new Proxy({
    registerWebviewViewProvider: (id) => { providers.add(id); return { dispose() {} }; },
    createTreeView: (id) => { providers.add(id); return loose('treeView'); },
    registerTreeDataProvider: (id) => { providers.add(id); return { dispose() {} }; },
    activeTextEditor: undefined,
    visibleTextEditors: [],
  }, { get: (t, p) => (p in t ? t[p] : loose(`window.${String(p)}`)) }),
  workspace: new Proxy({
    workspaceFolders: [{ uri: { fsPath: tmp, path: tmp, toString: () => tmp }, name: 'smoke', index: 0 }],
    getConfiguration: () => config,
    textDocuments: [],
  }, { get: (t, p) => (p in t ? t[p] : loose(`workspace.${String(p)}`)) }),
}, { get: (t, p) => (p in t ? t[p] : loose(`vscode.${String(p)}`)) });

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.call(this, request, ...rest);
};

(async () => {
  const ext = require(path.join(root, pkg.main));
  const context = {
    subscriptions: [], extensionUri: { fsPath: root, path: root }, extensionPath: root,
    globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
    workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
    globalStorageUri: { fsPath: tmp }, storageUri: { fsPath: tmp }, logUri: { fsPath: tmp },
    asAbsolutePath: (p) => path.join(root, p), secrets: loose('secrets'), environmentVariableCollection: loose('env'),
  };
  await ext.activate(context);
  const declared = pkg.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !registered.has(c));
  assert.deepStrictEqual(missing, [], `declared but not registered: ${missing}`);
  const views = Object.values(pkg.contributes.views).flat().map((v) => v.id);
  const noProvider = views.filter((v) => !providers.has(v));
  assert.deepStrictEqual(noProvider, [], `views without provider: ${noProvider}`);
  assert.ok(context.subscriptions.length > 0);
  if (ext.deactivate) await ext.deactivate();
  console.log(`ok  activation smoke (${declared.length} commands, ${views.length} views)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
