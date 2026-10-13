const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
function load(name, dependencies, extra = '', isolated = false) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'out', name + '.js'), 'utf8') + extra, {
    exports, require: key => {
      if (Object.hasOwn(dependencies, key)) return dependencies[key];
      if (isolated && key.startsWith('.')) throw new Error('Missing editor dependency mock: ' + key);
      return require(key.startsWith('.') ? path.join(root, 'out', key) : key);
    },
  });
  return exports;
}
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class MarkdownString {
  constructor() { this.value = ''; }
  appendCodeblock(value) { this.value += value + '\n'; }
  appendMarkdown(value) { this.value += value; }
}
const notices = [];
const vscode = { CompletionItem, MarkdownString, CompletionItemKind: { Field: 1, Value: 2 },
  Hover: class { constructor(contents) { this.contents = contents; } },
  window: { showWarningMessage: message => notices.push(message) },
};
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-resource-navigation-'));
const folder = path.join(project, 'ok_templates');
fs.mkdirSync(folder);
const image = path.join(folder, 'source.png');
const nextImage = path.join(folder, 'next.png');
fs.writeFileSync(image, 'image'); fs.writeFileSync(nextImage, 'image');
const config = { templatesDirectory: () => 'ok_templates', labelEnumAliases: () => ['Features'],
  loadProjectConfig: () => ({}), ideSetting: () => undefined };
const resources = load('resourceAuthoring', { './projectConfig': config });
function write(kind, name, bbox, file = 'source.png') {
  fs.writeFileSync(path.join(folder, kind + '.json'), JSON.stringify({
    images: [{ id: 1, file_name: file, width: 1000, height: 800 }],
    categories: [{ id: 1, name, supercategory: '' }],
    annotations: [{ id: 1, image_id: 1, category_id: 1, bbox, area: bbox[2] * bbox[3], iscrowd: 0 }],
  }));
}
(async () => {
  try {
    write('boxes', 'screen.panel', [10, 20, 30, 40]);
    write('points', 'screen.click', [90, 80, 0, 0]);
    write('coco_annotations', 'button', [1, 2, 3, 4]);
    const before = ['boxes', 'points', 'coco_annotations'].map(name => fs.readFileSync(path.join(folder, name + '.json'), 'utf8'));
    assert.strictEqual(resources.findAuthoringResource(project, 'point', 'screen.click').imagePath, image);
    assert.strictEqual(resources.findAuthoringResource(project, 'template', 'button').imagePath, image);
    assert.strictEqual(resources.findAuthoringResource(project, 'rect', 'missing'), undefined);
    let renders = 0;
    const providers = load('providers', {
      vscode, './projectConfig': config, './resourceAuthoring': resources,
      './langData': {},
      './localization': { tr: key => key },
      './pngCrop': { annotatedImageToDataUrlCached: () => { renders++; return 'data:image/png;base64,preview'; } },
    }, '', true);
    const features = { root: project, entry: name => name === 'screen' ? { name } : undefined };
    const provider = new providers.LangCompletionProvider({}, features);
    const items = text => provider.provideCompletionItems({ lineAt: () => ({ text }) }, { line: 0, character: text.length });
    const namespace = items('self.pos.')[0];
    assert.strictEqual(namespace.label, 'screen');
    assert.strictEqual(namespace.detail, undefined);
    provider.resolveCompletionItem(namespace);
    assert.strictEqual(namespace.documentation, undefined, 'namespace must not resolve a same-name Template');
    const leaves = items('self.pos.screen.');
    assert.strictEqual(renders, 0, 'listing completion items does not decode any images');
    const box = leaves.find(item => item.label === 'panel');
    const point = leaves.find(item => item.label === 'click');
    assert.strictEqual(box.detail, 'Box · 30×40');
    assert.strictEqual(point.detail, 'Point · (90, 80)');
    provider.resolveCompletionItem(point);
    assert(point.documentation.value.includes('self.pos.screen.click'));
    assert(!point.documentation.value.includes('.to_box()'));
    assert(point.documentation.value.includes('Point · (90, 80)'));
    assert(point.documentation.value.includes('data:image/png'));
    provider.resolveCompletionItem(box);
    assert(box.documentation.value.includes('self.pos.screen.panel.to_box()'));
    const hover = new providers.LangHoverProvider({}, features);
    const doc = { lineAt: () => ({ text: 'self.pos.screen.click' }) };
    assert.strictEqual(hover.provideHover(doc, { line: 0, character: 18 }).contents.value, point.documentation.value,
      'completion and hover use the same resource details');
    assert.deepStrictEqual(['boxes', 'points', 'coco_annotations'].map(name => fs.readFileSync(path.join(folder, name + '.json'), 'utf8')), before,
      'lookup and documentation do not rewrite authoring data');

    // Runtime atlas geometry and a stale card must never decide which image gets edited.
    write('coco_annotations', 'button', [20, 30, 40, 50], 'next.png');
    const opened = [];
    const gallery = load('templatePanel', {
      vscode, './providers': { featureAliases: () => ['Features'] }, './resourceAuthoring': resources,
      './pythonEditor': {}, './pngCrop': {}, './projectConfig': config, './webviewHtml': {},
      './boxResourceStore': {}, './pointResourceStore': {},
      './localization': { tr: key => key },
      './annotationPanel': { AnnotationPanel: { show: (...args) => opened.push(args) } },
      './templateAssetData': { TemplateAssetData: class { load() {} listImages() { return [image, nextImage]; } } },
      './cocoAnnotationData': require('../out/cocoAnnotationData'),
    }, '\nexports.Controller = GalleryController;', true).Controller.prototype;
    const host = { features, mode: 'template', thumbDir: folder, extensionUri: {}, openOriginal: gallery.openOriginal };
    host.metas = () => [{ name: 'button', kind: 'template', imagePath: image, bbox: [0, 0, 1, 1] }];
    await gallery.onMessage.call(host, { type: 'open', name: 'button', imagePath: 'forged.png' });
    assert.strictEqual(opened[0][3], nextImage);
    assert.strictEqual(opened[0][6], 'template'); assert.strictEqual(opened[0][7], 'button');
    write('coco_annotations', 'renamed', [20, 30, 40, 50], 'next.png');
    await gallery.onMessage.call(host, { type: 'open', name: 'button' });
    assert.strictEqual(opened.length, 1, 'removed resource does not open stale atlas coordinates');
    assert.strictEqual(notices.length, 1);

    write('points', 'screen.panel', [90, 80, 0, 0]);
    const ambiguous = items('self.pos.screen.').find(item => item.label === 'panel');
    assert.strictEqual(ambiguous.detail, undefined, 'duplicate Box / Point names do not choose one type arbitrarily');
    provider.resolveCompletionItem(ambiguous);
    assert.strictEqual(ambiguous.documentation, undefined);
    assert.strictEqual(resources.findAuthoringResource(project, 'point', 'screen.panel').kind, 'point',
      'mode-specific original editing can still resolve a same-name point');

    const { renderAnnotatedPixels } = require('../out/annotatedImage');
    const original = { width: 800, height: 800, rgba: Buffer.alloc(800 * 800 * 4, 80) };
    for (const bbox of [[400, 400, 0, 0], [0, 0, 0, 0], [800, 800, 0, 0]]) {
      const pixels = renderAnnotatedPixels(original, bbox);
      assert(pixels && pixels.width <= 400 && pixels.height <= 400, 'points at every image boundary have a visible preview');
      assert(pixels.rgba.some((value, index) => index % 4 === 0 && value === 255), 'point marker is rendered');
    }
    assert.strictEqual(renderAnnotatedPixels(original, [800, 0, 2, 2]), undefined);
    console.log('resource navigation: current authoring lookup, lazy leaf details, source editing and point previews passed');
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
