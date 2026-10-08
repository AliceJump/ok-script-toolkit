'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
let selection = ['template', 'rect', 'point'];
const notices = [];
const vscode = {
  window: {
    showQuickPick: async (items, options) => {
      assert.strictEqual(options.canPickMany, true);
      assert.deepStrictEqual(Array.from(items, item => item.label), ['translated:Template', 'translated:Box', 'translated:Point']);
      return selection.map(resource => items.find(item => item.resource === resource));
    },
    showWarningMessage: message => notices.push(message),
    showErrorMessage: message => notices.push(message),
  },
};
const sourceImage = { file: 'screen.png', width: 1000, height: 500 };
const dependencies = {
  vscode,
  './localization': { tr: key => 'translated:' + key },
  './projectConfig': { templatesDirectory: () => 'ok_templates' },
  './providers': { featureAliases: () => ['Features'] },
  './boxResourceStore': { readAuthoringFile: () => ({ images: [sourceImage], boxes: [
    { path: 'screen.panel', image: 'screen.png', bbox: [10, 20, 30, 40] },
  ] }) },
  './pointResourceStore': { readPoints: () => ({ errors: [], file: { images: [sourceImage], points: [
    { path: 'screen.click', image: 'screen.png', x: 500, y: 250 },
  ] } }) },
};
function controller(file, className) {
  const exports = {};
  const filename = path.join(root, 'out', file + '.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `\nexports.Controller = ${className};`, {
    exports,
    require: name => dependencies[name] || (name.startsWith('.') ? {} : require(name)),
  }, { filename });
  return exports.Controller.prototype;
}
const publish = controller('templateAssetPanel', 'AssetGalleryController');
const preview = controller('templatePanel', 'GalleryController');
function plain(value) { return JSON.parse(JSON.stringify(value)); }
(async () => {
  const effects = [];
  let templatePlan = {};
  let positionPlan = {};
  let positionSuccess = true;
  const host = {
    prepareTemplatePublish: async () => { effects.push('configure template'); return templatePlan; },
    preparePositionPublish: async picked => {
      assert.strictEqual(picked.rect, selection.includes('rect'));
      assert.strictEqual(picked.point, selection.includes('point'));
      effects.push('configure positions'); return positionPlan;
    },
    executePositionPublish: async () => { effects.push('write positions'); return positionSuccess; },
    executeTemplatePublish: async () => { effects.push('write template'); },
  };
  async function run(expected) {
    effects.length = 0;
    await publish.handlePublish.call(host);
    assert.deepStrictEqual(effects, expected);
  }
  await run(['configure template', 'configure positions', 'write positions', 'write template']);
  positionPlan = undefined;
  await run(['configure template', 'configure positions']);
  positionPlan = {};
  templatePlan = undefined;
  await run(['configure template']);
  templatePlan = {};
  positionSuccess = false;
  await run(['configure template', 'configure positions', 'write positions']);
  positionSuccess = true;
  selection = ['template'];
  await run(['configure template', 'write template']);
  selection = ['point'];
  await run(['configure positions', 'write positions']);
  selection = [];
  await run([]);

  // Empty or invalid authoring data cannot silently replace a published template library.
  const data = { load() {}, readErrors: [], listImages: () => [] };
  assert.strictEqual(await publish.prepareTemplatePublish.call({ data }), undefined);
  assert.strictEqual(notices.pop(), 'translated:No Template annotations to publish.');
  data.readErrors = ['json'];
  assert.strictEqual(await publish.prepareTemplatePublish.call({ data }), undefined);
  assert.strictEqual(notices.pop(), 'translated:The annotation source is invalid. Fix the source file before saving or exporting.');

  const feature = { name: 'button', width: 20, height: 30, bbox: [12, 18, 20, 30], imagePath: path.join(root, 'assets/packed.png') };
  const features = { root, refresh() {}, all: () => [feature] };
  const template = preview.templateMetas.call({ features })[0];
  assert.strictEqual(template.expression, 'Features.button');
  assert.strictEqual(template.imagePath, feature.imagePath);
  feature.bbox[0] = 99;
  assert.strictEqual(template.bbox[0], 12, 'preview preserves its runtime snapshot geometry');
  const rect = preview.rectMetas.call({ features })[0];
  assert.strictEqual(rect.width, 30, 'Rect cards report the crop width rather than source-screen width');
  assert.strictEqual(rect.height, 40);
  assert.strictEqual(rect.expression, 'self.pos.screen.panel.to_box()');
  const point = preview.pointMetas.call({ features })[0];
  assert.strictEqual(point.expression, 'self.pos.screen.click');
  assert.deepStrictEqual(plain(point.bbox), [440, 220, 120, 60]);
  await preview.onMessage.call({}, { type: 'publish' });
  console.log('resource host contract tests passed: current source, reference expressions, cancellation and write ordering');
})().catch(error => { console.error(error); process.exitCode = 1; });
