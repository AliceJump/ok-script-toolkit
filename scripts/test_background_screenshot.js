const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeTmpDir } = require('./test-tmp');

const root = makeTmpDir('background-screenshot');
const outputs = [];
const errors = [];
const infos = [];
let behavior = async output => {
  fs.writeFileSync(output, 'frame');
  return { ok: true };
};

const registered = [];
const inboxStore = {
  newFilePath(extension = 'png') {
    const name = `shot_${registered.length}.${extension}`;
    return path.join(root, name);
  },
  register(filePath) {
    registered.push(filePath);
  },
};

const moduleStub = { exports: {} };
const vscode = {
  workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
  window: {
    showWarningMessage(message) { errors.push(message); },
    showErrorMessage(message) { errors.push(message); },
    showInformationMessage(message) { infos.push(message); },
  },
};
const source = fs.readFileSync(path.join(__dirname, '../out/backgroundScreenshot.js'), 'utf8');
vm.runInNewContext(source, {
  exports: moduleStub.exports,
  require(name) {
    if (name === 'vscode') return vscode;
    if (name === './localization') return {
      tr: (key, args) => `${key} ${args?.error || args?.name || ''}`.trim(),
    };
    if (name === './screenshotCapture') return {
      captureGameWindow(output) { outputs.push(output); return behavior(output); },
    };
    return require(name);
  },
}, { filename: 'backgroundScreenshot.js' });

const { bindInboxScreenshotStore, captureInboxScreenshotInBackground, captureTemplateScreenshotInBackground } = moduleStub.exports;

(async () => {
  assert.strictEqual(await captureInboxScreenshotInBackground(), false, 'Unbound store must fail closed');
  assert(errors.some(message => message.includes('Screenshot inbox is not ready')));

  bindInboxScreenshotStore(inboxStore);
  errors.length = 0;

  assert.strictEqual(await captureInboxScreenshotInBackground(), true);
  assert.strictEqual(await captureTemplateScreenshotInBackground(), true, 'Deprecated alias must keep working');
  assert.notStrictEqual(outputs[0], outputs[1], 'Captures within the same second must keep both images');
  assert.ok(outputs[0].endsWith('.bmp'), 'Inbox capture must request lossless BMP');
  assert.strictEqual(fs.readFileSync(outputs[0], 'utf8'), 'frame');
  assert.strictEqual(fs.readFileSync(outputs[1], 'utf8'), 'frame');
  assert.deepStrictEqual(registered, outputs.slice(0, 2));
  assert(infos.some(message => message.includes('Screenshot saved to inbox')));

  let finish;
  behavior = () => new Promise(resolve => { finish = resolve; });
  const pending = captureInboxScreenshotInBackground();
  const requestCount = outputs.length;
  assert.strictEqual(await captureInboxScreenshotInBackground(), false, 'Repeated hotkeys must not queue overlapping captures');
  assert.strictEqual(outputs.length, requestCount);
  finish({ ok: false, reason: 'cancelled' });
  assert.strictEqual(await pending, false);

  behavior = async () => { throw new Error('capture unavailable'); };
  assert.strictEqual(await captureInboxScreenshotInBackground(), false);
  assert(errors.some(message => message.includes('capture unavailable')));

  behavior = async () => ({ ok: true });
  assert.strictEqual(await captureInboxScreenshotInBackground(), true, 'A failed capture must release the busy guard');
  vscode.workspace.workspaceFolders = [];
  assert.strictEqual(await captureInboxScreenshotInBackground(), false);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  assert.strictEqual(await captureInboxScreenshotInBackground(), true, 'Missing workspace must not keep the guard locked');
  console.log('test_background_screenshot: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
