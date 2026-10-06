const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const indexPath = path.join(root, 'media', 'annotationPanel', 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const inlineScripts = [...indexHtml.matchAll(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/g)];
const cycleScript = inlineScripts.find(match => match[1].includes('MODE_BUTTON_IDS'))?.[1];
assert(cycleScript, 'annotation mode cycle script should remain embedded in the annotation panel resource');

const dom = new JSDOM(`<!doctype html><body>
  <div id="bboxModal"></div>
  <button id="templateModeBtn" class="active"></button>
  <button id="rectModeBtn"></button>
  <button id="pointModeBtn"></button>
</body>`, { runScripts: 'outside-only' });
const { window } = dom;
const { document } = window;
const modeIds = ['templateModeBtn', 'rectModeBtn', 'pointModeBtn'];

for (const id of modeIds) {
  document.getElementById(id).addEventListener('click', () => {
    for (const otherId of modeIds) document.getElementById(otherId).classList.remove('active');
    document.getElementById(id).classList.add('active');
  });
}

window.eval(cycleScript);

function activeMode() {
  return modeIds.find(id => document.getElementById(id).classList.contains('active'));
}

function configure(keybindings) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'config', keybindings },
  }));
}

function press(key, init = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
}

const defaultConfig = { cycleMode: 'm' };
configure(defaultConfig);
assert.strictEqual(defaultConfig.modeTemplate, '', 'retired Template binding should be blanked before app.js receives config');
assert.strictEqual(defaultConfig.modeRect, '', 'retired Box binding should be blanked before app.js receives config');
assert.strictEqual(defaultConfig.modePoint, '', 'retired Point binding should be blanked before app.js receives config');
assert.strictEqual(activeMode(), 'templateModeBtn');
press('m');
assert.strictEqual(activeMode(), 'rectModeBtn', 'first cycle should move Template -> Box');
press('m');
assert.strictEqual(activeMode(), 'pointModeBtn', 'second cycle should move Box -> Point');
press('m');
assert.strictEqual(activeMode(), 'templateModeBtn', 'third cycle should wrap Point -> Template');

let releasedKeyEvents = 0;
document.addEventListener('keydown', event => {
  if (['1', '2', '3', 'x'].includes(event.key)) releasedKeyEvents += 1;
});
press('1');
assert.strictEqual(activeMode(), 'templateModeBtn', 'legacy number shortcuts must no longer switch modes');
assert.strictEqual(releasedKeyEvents, 1, 'released number shortcut must remain available to other commands');

const customConfig = { cycleMode: 'q', modeTemplate: '3', modeRect: 'x', modePoint: '2', nextImage: '1' };
configure(customConfig);
assert.strictEqual(customConfig.modeTemplate, '', 'persisted Template shortcut must be retired');
assert.strictEqual(customConfig.modeRect, '', 'persisted Box shortcut must be retired');
assert.strictEqual(customConfig.modePoint, '', 'persisted Point shortcut must be retired');
assert.strictEqual(customConfig.nextImage, '1', 'unrelated shortcut reuse must be preserved');
press('m');
assert.strictEqual(activeMode(), 'templateModeBtn', 'previous cycle key must stop working after reconfiguration');
press('q');
assert.strictEqual(activeMode(), 'rectModeBtn', 'configured cycle key should switch modes');
press('x');
assert.strictEqual(activeMode(), 'rectModeBtn', 'persisted legacy per-mode binding must not switch modes');
assert.strictEqual(releasedKeyEvents, 2, 'retired custom shortcut must remain available to other commands');
press('1');
assert.strictEqual(activeMode(), 'rectModeBtn', 'reused legacy number key must not switch annotation mode');
assert.strictEqual(releasedKeyEvents, 3, 'reused number key must propagate to the configured command handler');

document.getElementById('bboxModal').classList.add('visible');
press('q');
assert.strictEqual(activeMode(), 'rectModeBtn', 'mode switching must stay disabled while the edit dialog is open');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const defaults = pkg.contributes.configuration.properties['okScriptToolkit.annotationKeybindings'].default;
assert.strictEqual(defaults.cycleMode, 'm', 'default cycle shortcut should be M');
assert(!Object.prototype.hasOwnProperty.call(defaults, 'modeTemplate'));
assert(!Object.prototype.hasOwnProperty.call(defaults, 'modeRect'));
assert(!Object.prototype.hasOwnProperty.call(defaults, 'modePoint'));

console.log('annotation mode cycle shortcut tests passed');
