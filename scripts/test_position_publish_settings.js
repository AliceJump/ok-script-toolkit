'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-position-settings-'));
const personal = { positionJsonPath: 'mine/positions.json' };
const convention = { position: { jsonPath: 'project/positions.json', pythonDirectory: 'project/scene' } };
const writes = [];
let input;
let choice = 'personal';
const vscode = {
  QuickPickItemKind: { Separator: -1 },
  window: {
    showQuickPick: async items => items.find(item => item.action === choice),
    showInputBox: async options => { assert.strictEqual(options.validateInput(''), undefined); return input; },
  },
};
const projectConfig = {
  ...require('../out/projectConfigPure'),
  ideSetting: key => personal[key],
  loadProjectConfig: () => convention,
  resolveProjectDir: () => root,
  setIdeSetting: async (key, value) => { writes.push([key, value]); personal[key] = value; },
};
const filename = path.resolve(__dirname, '../out/positionPublishSettings.js');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  exports: moduleUnderTest.exports,
  require: name => name === 'vscode' ? vscode
    : name === './localization' ? { tr: key => key }
    : name === './projectConfig' ? projectConfig
    : name === './positionPublishStore' ? { DEFAULT_POSITION_JSON: 'src/scene/positions.json', DEFAULT_POSITION_PY_DIR: 'src/scene' }
    : name === './saveToAssetsPure' ? require('../out/saveToAssetsPure') : require(name),
}, { filename });
const settings = moduleUnderTest.exports;
(async () => {
  try {
    for (const value of ['', ' ', './generated/scene', 'generated\\scene']) assert.strictEqual(settings.positionPublishTargetInputError(value, root), undefined, value);
    for (const value of ['/outside', 'C:\\outside', '\\\\server\\share']) assert.strictEqual(settings.positionPublishTargetInputError(value, root), 'relative', value);
    for (const value of ['.', './', '../outside', 'generated/../scene']) assert.strictEqual(settings.positionPublishTargetInputError(value, root), 'outside', value);
    const uri = { fsPath: root };
    assert.strictEqual(settings.positionPublishTargetSetting('json', uri, root).source, 'Personal');
    input = '   ';
    await settings.editPositionPublishTarget('json', uri, root);
    assert.deepStrictEqual(writes.pop(), ['positionJsonPath', undefined]);
    assert.strictEqual(settings.positionPublishTargetSetting('json', uri, root).source, 'Project');
    input = 'mine\\scene';
    await settings.editPositionPublishTarget('python', uri, root);
    assert.deepStrictEqual(writes.pop(), ['positionPythonDirectory', 'mine/scene']);
    input = undefined;
    await settings.editPositionPublishTarget('python', uri, root);
    assert.strictEqual(writes.length, 0, 'cancel preserves the preference');
    choice = 'resetPersonal';
    await settings.editPositionPublishTarget('python', uri, root);
    assert.strictEqual(settings.positionPublishTargetSetting('python', uri, root).source, 'Project');
    convention.position = {};
    assert.strictEqual(settings.positionPublishTargetSetting('python', uri, root).source, 'Default');
    console.log('position publishing preference tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
