'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const workspaceRoot = path.join(root, 'workspace');
const sourceImage = { file: 'screen.png', width: 1000, height: 500 };
let selection = ['template', 'rect', 'point'];
let expectedResourceLabels = ['translated:Template', 'translated:Box', 'translated:Point'];
let quickPickCalls = 0;
let templateAnnotations = [{ id: 1, image_id: 1 }];
let rectAnnotations = [{ id: 1 }];
let pointErrors = [];
let pointItems = [
  { path: 'screen.click', image: 'screen.png', x: 500, y: 250 },
];
const notices = [];
const templateData = {
  root: workspaceRoot,
  readErrors: [],
  load() {},
  get data() {
    return {
      images: [{ id: 1, file_name: 'screen.png', width: 1000, height: 500 }],
      annotations: templateAnnotations,
      categories: [{ id: 1, name: 'screen.template' }],
    };
  },
};
const boxData = {
  readErrors: [],
  get data() { return { annotations: rectAnnotations }; },
};
const vscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
  },
  window: {
    showQuickPick: async (items, options) => {
      quickPickCalls++;
      assert.strictEqual(options.canPickMany, true);
      assert.deepStrictEqual(Array.from(items, item => item.label), expectedResourceLabels);
      return selection.map(resource => items.find(item => item.resource === resource)).filter(Boolean);
    },
    showWarningMessage: message => notices.push(message),
    showErrorMessage: message => notices.push(message),
  },
};
const dependencies = {
  vscode,
  './localization': { tr: key => 'translated:' + key },
  './projectConfig': { templatesDirectory: () => 'ok_templates' },
  './providers': { featureAliases: () => ['Features'] },
  './boxResourceStore': {
    boxAnnotationData: () => boxData,
    readAuthoringFile: () => ({ images: [sourceImage], boxes: [
      { path: 'screen.panel', image: 'screen.png', bbox: [10, 20, 30, 40] },
    ] }),
  },
  './pointResourceStore': {
    readPoints: () => ({ errors: pointErrors, file: { images: [sourceImage], points: pointItems } }),
  },
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
    data: templateData,
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

  // The initial picker only shows non-empty, readable authoring resources.
  selection = ['template', 'rect', 'point'];
  expectedResourceLabels = ['translated:Template'];
  rectAnnotations = [];
  pointItems = [];
  await run(['configure template', 'write template']);

  templateAnnotations = [];
  expectedResourceLabels = [];
  const beforeEmptyPick = quickPickCalls;
  await run([]);
  assert.strictEqual(quickPickCalls, beforeEmptyPick, 'no picker should open when every resource is empty');
  assert.strictEqual(notices.pop(), 'translated:No annotations available to publish.');

  for (const invalidType of ['rect', 'point']) {
    boxData.readErrors = invalidType === 'rect' ? ['json'] : [];
    pointErrors = invalidType === 'point' ? ['json'] : [];
    await run([]);
    assert.strictEqual(quickPickCalls, beforeEmptyPick, 'an invalid empty position source should not open a picker');
    assert.strictEqual(notices.pop(), 'translated:The annotation source is invalid. Fix the source file before saving or exporting.');
  }

  templateAnnotations = [{ id: 1, image_id: 1 }];
  rectAnnotations = [{ id: 1 }];
  pointItems = [{ path: 'screen.click', image: 'screen.png', x: 500, y: 250 }];
  templateData.readErrors = ['json'];
  boxData.readErrors = ['json'];
  pointErrors = ['json'];
  const beforeInvalidPick = quickPickCalls;
  await run([]);
  assert.strictEqual(quickPickCalls, beforeInvalidPick, 'no picker should open when every resource source is invalid');
  assert.strictEqual(notices.pop(), 'translated:The annotation source is invalid. Fix the source file before saving or exporting.');

  templateData.readErrors = [];
  boxData.readErrors = [];
  pointErrors = [];
  expectedResourceLabels = ['translated:Template', 'translated:Box', 'translated:Point'];

  // A damaged source must not hide another type's valid annotations.
  rectAnnotations = [];
  pointErrors = ['json'];
  selection = ['template'];
  expectedResourceLabels = ['translated:Template'];
  const beforeMixedPick = quickPickCalls;
  await run(['configure template', 'write template']);
  assert.strictEqual(quickPickCalls, beforeMixedPick + 1, 'valid templates remain selectable alongside empty boxes and invalid points');

  rectAnnotations = [{ id: 1 }];
  pointItems = [];
  pointErrors = [];
  templateData.readErrors = ['json'];
  selection = ['rect'];
  expectedResourceLabels = ['translated:Box'];
  await run(['configure positions', 'write positions']);
  assert.strictEqual(quickPickCalls, beforeMixedPick + 2, 'valid boxes remain selectable alongside invalid templates and empty points');

  templateData.readErrors = [];
  pointItems = [{ path: 'screen.click', image: 'screen.png', x: 500, y: 250 }];
  expectedResourceLabels = ['translated:Template', 'translated:Box', 'translated:Point'];

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
  console.log('resource host contract tests passed: publish filtering, current source, reference expressions, cancellation and write ordering');
})().catch(error => { console.error(error); process.exitCode = 1; });
