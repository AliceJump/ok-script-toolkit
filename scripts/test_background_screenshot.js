const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeTmpDir } = require('./test-tmp');

const root = makeTmpDir('background-screenshot');
const outputs = [];
const errors = [];
let behavior = async output => {
  fs.writeFileSync(output, 'frame');
  return { ok: true };
};
const moduleStub = { exports: {} };
const vscode = {
  workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
  window: {
    showWarningMessage() {},
    showErrorMessage(message) { errors.push(message); },
    showInformationMessage() {},
  },
};
const source = fs.readFileSync(path.join(__dirname, '../out/backgroundScreenshot.js'), 'utf8');
vm.runInNewContext(source, {
  exports: moduleStub.exports,
  require(name) {
    if (name === 'vscode') return vscode;
    if (name === './localization') return { tr: (key, args) => `${key} ${args?.error || ''}` };
    if (name === './projectConfig') return { resolveProjectDir: () => root, templatesDirectory: () => 'templates' };
    if (name === './screenshotCapture') return {
      captureGameWindow(output) { outputs.push(output); return behavior(output); },
    };
    return require(name);
  },
  Date: class extends Date { constructor() { super('2026-10-12T12:00:00Z'); } },
}, { filename: 'backgroundScreenshot.js' });
const capture = moduleStub.exports.captureTemplateScreenshotInBackground;

(async () => {
  assert.strictEqual(await capture(), true);
  assert.strictEqual(await capture(), true);
  assert.notStrictEqual(outputs[0], outputs[1], 'Captures within the same second must keep both images');
  assert.strictEqual(fs.readFileSync(outputs[0], 'utf8'), 'frame');
  assert.strictEqual(fs.readFileSync(outputs[1], 'utf8'), 'frame');

  let finish;
  behavior = () => new Promise(resolve => { finish = resolve; });
  const pending = capture();
  const requestCount = outputs.length;
  assert.strictEqual(await capture(), false, 'Repeated hotkeys must not queue overlapping captures');
  assert.strictEqual(outputs.length, requestCount);
  finish({ ok: false, reason: 'cancelled' });
  assert.strictEqual(await pending, false);

  behavior = async () => { throw new Error('capture unavailable'); };
  assert.strictEqual(await capture(), false);
  assert(errors.some(message => message.includes('capture unavailable')));

  behavior = async () => ({ ok: true });
  assert.strictEqual(await capture(), true, 'A failed capture must release the busy guard');
  vscode.workspace.workspaceFolders = [];
  assert.strictEqual(await capture(), false);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  assert.strictEqual(await capture(), true, 'Missing workspace must not keep the guard locked');
  console.log('test_background_screenshot: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
