#!/usr/bin/env node
/** End-to-end regression tests for shared COCO authoring and box-only export. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const core = require('../out/cocoAnnotationData');
const pure = require('../out/boxResourcePure');
const store = require('../out/boxResourceStore');
const zlib = require('zlib');
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  let c = 0xffffffff;
  for (const byte of body) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function writePng(file, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  const raw = Buffer.alloc((width + 1) * height); // 每行一个 0 号 filter 字节
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}


const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-shared-coco-'));
const directory = 'ok_templates';
const folder = path.join(project, directory);
fs.mkdirSync(folder);
const image = path.join(folder, 'a.png');
const second = path.join(folder, 'b.png');
writePng(image, 100, 100);
writePng(second, 200, 200);
const boxesFile = path.join(folder, 'boxes.json');
const runtimeFile = path.join(project, 'src/scene/boxes.json');
const editorMessages = [];
const galleryMessages = [];
const errors = [];
const infos = [];
const openedFiles = [];
const previewSources = [];
const ui = {
  l10n: { t: text => text },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: project } }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showErrorMessage: text => errors.push(text),
    showInformationMessage: text => infos.push(text),
    showWarningMessage: async (_text, _options, action) => action,
  },
  Uri: { file: file => ({ fsPath: file }) },
  commands: { executeCommand: async (command, uri) => openedFiles.push({ command, uri }) },
};
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'vscode') return ui;
  return originalLoad.call(this, name, parent, isMain);
};
function loadController(file, name) {
  const filename = path.join(root, 'out', file + '.js');
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m.require = request => {
    if (request === './pngCrop') return {
      ...require('../out/imageHeader'), THUMB_HEIGHT: 84, cropTemplateThumbFileAsync: async () => undefined,
      annotatedImageFile: (imagePath, bbox) => { previewSources.push({ imagePath, bbox }); return path.join(folder, 'preview.png'); },
    };
    if (file === 'boxPanels' && request === './screenshotCapture') return { getProjectConfig: () => ({ projectDir: project }) };
    if (request === './localization') return { tr: text => text };
    return Module.prototype.require.call(m, request);
  };
  m._compile(fs.readFileSync(filename, 'utf8') + '\nexports.TestController = ' + name + ';', filename);
  return m.exports.TestController;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
(async () => {
  const disposables = [];
  try {
    const { TemplateAssetData } = require('../out/templateAssetData');
    const templates = new TemplateAssetData(project);
    templates.load();
    assert(templates.setAnnotationsForImage(image, [{ category: 'button', x: 10, y: 20, w: 30, h: 40 }]));
    templates.save();
    const templateText = fs.readFileSync(templates.annotationFile, 'utf8');
    assert.deepStrictEqual(store.authoringReadErrors(project, directory), []);
    assert.deepStrictEqual(store.publishRuntime(project, directory).errors, ['empty']);
    assert(!fs.existsSync(runtimeFile) && !fs.existsSync(boxesFile), 'empty publish does not create or erase files');

    const boxes = new TemplateAssetData(project, 'boxes.json');
    const Controller = loadController('annotationPanel', 'AnnotationController');
    const editor = new Controller({
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: message => { editorMessages.push(message); return Promise.resolve(true); },
    }, { fsPath: root }, boxes, folder, () => true, () => {}, true);
    disposables.push(editor);
    editor.open(image, [image, second]);
    await tick();
    await editor.onMessage({ type: 'ready' });
    assert(editorMessages.find(message => message.type === 'config' && message.boxMode), 'shared controller enables box name validation');
    assert.deepStrictEqual(editorMessages.filter(message => message.type === 'load').at(-1).annotations, []);
    await editor.onMessage({ type: 'save', annotations: [{ id: 1, category: ' screen.first ', x: 10, y: 20, w: 30, h: 40 }] });
    assert.deepStrictEqual(errors, [], 'first direct draw saves without a source file');
    let raw = JSON.parse(fs.readFileSync(boxesFile, 'utf8'));
    assert.deepStrictEqual(Object.keys(raw), Object.keys(JSON.parse(templateText)), 'box and template sources have exactly the same COCO fields');
    assert.deepStrictEqual(raw.annotations[0].bbox, [10,20,30,40]);
    assert.strictEqual(pure.authoringFile(project, folder), boxesFile, 'absolute template directories do not acquire a second project root');
    assert.deepStrictEqual(store.readAuthoringFile(project, folder), store.readAuthoringFile(project, directory));
    assert.strictEqual(raw.categories[0].name, 'screen.first');
    assert(!('version' in raw) && !('boxes' in raw));
    assert.strictEqual(fs.readFileSync(templates.annotationFile, 'utf8'), templateText, 'editing boxes preserves the independent template source');
    const BoxGallery = loadController('boxPanels', 'BoxGalleryViewProvider');
    const boxGallery = new BoxGallery({ fsPath: root }, folder);
    boxGallery.view = { webview: {} };
    await boxGallery.onMessage({ type: 'open', id: 'screen.first' });
    assert.deepStrictEqual(previewSources.pop(), { imagePath: image, bbox: [10, 20, 30, 40] }, 'View Original uses box authoring coordinates even when template names differ');
    assert.strictEqual(openedFiles.at(-1).command, 'vscode.open');
    const openedCount = openedFiles.length;
    await boxGallery.onMessage({ type: 'open', id: 'screen.runtime_only' });
    assert.strictEqual(openedFiles.length, openedCount, 'boxes without an authoring source cannot open a made-up image');
    const loadsBeforeWatch = editorMessages.filter(message => message.type === 'load').length;
    core.notifyAnnotationDataChanged(boxesFile);
    await tick();
    assert.strictEqual(editorMessages.filter(message => message.type === 'load').length, loadsBeforeWatch, 'a duplicate filesystem event does not reset editor undo after its own save');

    const Gallery = loadController('templateAssetPanel', 'AssetGalleryController');
    const gallery = new Gallery({ onDidReceiveMessage: () => ({ dispose() {} }), postMessage: message => { galleryMessages.push(message); return Promise.resolve(true); } },
      templates, folder, () => true, { fsPath: root }, undefined, true);
    disposables.push(gallery);
    // No thumbnail URI conversion is needed because this fixture skips thumbnail generation.
    await gallery.update();
    const templateEditor = new Controller({
      onDidReceiveMessage: () => ({ dispose() {} }), postMessage: message => { editorMessages.push(message); return Promise.resolve(true); },
    }, { fsPath: root }, templates, folder, () => true, () => {}, false);
    disposables.push(templateEditor);
    templateEditor.open(image, [image, second]);
    await tick();
    await templateEditor.onMessage({ type: 'generateBox', path: 'screen.generated', boxes: [{ x: 50, y: 50, w: 10, h: 20 }] });
    await tick();
    assert(galleryMessages.filter(message => message.type === 'templates').at(-1).templates.find(row => row.imagePath === image).categories.includes('screen.generated'), 'generating a box automatically refreshes the box source gallery');
    assert(editorMessages.filter(message => message.type === 'load' && message.annotations.some(ann => ann.category === 'screen.generated')).length, 'generating a box reloads an already open box editor');
    assert(editorMessages.some(message => message.type === 'boxPaths' && message.boxPaths['screen.generated']), 'name occupancy refreshes without resetting template undo');
    assert.strictEqual(fs.readFileSync(templates.annotationFile, 'utf8'), templateText);

    assert.strictEqual(store.addBox(project, directory, 'screen.generated', 'b.png', { x: 1, y: 2, w: 3, h: 4 }), 'duplicate');
    assert.strictEqual(store.addBox(project, directory, 'panels.bad', 'a.png', { x: 1, y: 2, w: 3, h: 4 }), 'reserved');
    assert.strictEqual(store.addBox(project, directory, 'screen.outside', 'a.png', { x: 99, y: 2, w: 3, h: 4 }), 'rect');
    assert(store.publishRuntime(project, directory).ok, 'first publish creates the runtime file');
    let runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert.deepStrictEqual(runtime.boxes.find(box => box.path === 'screen.first').rect, [0.1,0.2,0.4,0.6]);
    assert.strictEqual(runtime.version, 1);
    assert(!('image' in runtime.boxes[0]));
    assert.strictEqual(store.publishRuntime(project, directory, 'ok_templates/boxes.json').errors[0], 'same', 'publishing cannot overwrite its source');
    fs.writeFileSync(runtimeFile, '{broken');
    assert.deepStrictEqual(store.publishRuntime(project, directory).errors, ['runtimeRead']);
    fs.unlinkSync(runtimeFile);

    await gallery.handleSwapAnnotations(image, second);
    await tick();
    raw = JSON.parse(fs.readFileSync(boxesFile, 'utf8'));
    const moved = store.readAuthoringFile(project, directory).boxes.find(box => box.path === 'screen.first');
    assert.strictEqual(moved.image, 'b.png');
    assert.deepStrictEqual(moved.bbox, [20,40,60,80], 'box swapping uses template scale and save logic');
    assert(editorMessages.filter(message => message.type === 'load' && message.filename === 'a.png').at(-1).annotations.every(ann => ann.category === 'button'), 'template editor retains its own annotations');
    assert.strictEqual(fs.readFileSync(templates.annotationFile, 'utf8'), templateText);

    // External source writes follow the same refresh notification as internal saves.
    const exported = core.emptyCocoData();
    core.writeAnnotationText(boxesFile, JSON.stringify(exported));
    await tick();
    const publishedBefore = 'published table must survive';
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, publishedBefore);
    assert.deepStrictEqual(store.publishRuntime(project, directory).errors, ['empty']);
    assert.strictEqual(fs.readFileSync(runtimeFile, 'utf8'), publishedBefore);
    await gallery.publishBoxes();
    assert(infos.includes('No box annotations to publish.'), 'empty publish is an informational result');
    fs.unlinkSync(runtimeFile);

    for (const version of [1,2]) {
      const legacy = JSON.stringify({ version, images: [{ file: 'a.png', width:100, height:100 }], boxes:[{
        path:'screen.legacy',image:'a.png', ...(version===1 ? {rect:[0.1,0.2,0.4,0.6]} : {bbox:[10,20,30,40]}),
      }] });
      fs.writeFileSync(boxesFile, legacy);
      assert.deepStrictEqual(store.authoringReadErrors(project, directory), []);
      assert.strictEqual(fs.readFileSync(boxesFile, 'utf8'), legacy, 'legacy reads are read-only');
      assert.strictEqual(store.addBox(project, directory, 'screen.new', 'a.png', {x:1,y:2,w:3,h:4}), undefined);
      assert(JSON.parse(fs.readFileSync(boxesFile,'utf8')).annotations.length === 2);
      assert(fs.readdirSync(folder).some(name => name.startsWith('boxes.json.pre-coco.') && fs.readFileSync(path.join(folder,name),'utf8')===legacy), 'legacy conversion preserves a byte-for-byte backup');
    }
    const broken = JSON.stringify({ images:[{id:1,file_name:'a.png',width:100,height:100}], categories:[], annotations:[{id:1,image_id:1,category_id:99,bbox:[1,2,3,4]}] });
    fs.writeFileSync(boxesFile,broken);
    assert(store.authoringReadErrors(project,directory).length);
    assert.strictEqual(store.addBox(project,directory,'screen.new','a.png',{x:1,y:2,w:3,h:4}),'parse');
    assert.strictEqual(fs.readFileSync(boxesFile,'utf8'),broken, 'unreadable annotations are never treated as an empty catalog');

    assert.strictEqual(pure.boxPathError('screen.good'), undefined);
    assert.strictEqual(pure.boxPathError('main'), 'shallow');
    assert.strictEqual(pure.boxPathError('screen.2bad'), 'segment');
    assert.strictEqual(pure.resolveBoxRuntimePlan(project, 'custom/boxes.json', 'other/boxes.json').layer, 'convention');
    assert.strictEqual(pure.resolveBoxRuntimePlan(project, undefined, 'other/boxes.json').layer, 'configPy');
    assert.strictEqual(pure.resolveBoxRuntimePlan(project).layer, 'probe');
    assert.deepStrictEqual(errors, []);
    console.log('shared COCO authoring, first save/publish, live refresh, swapping, legacy preservation: OK');
    // Template display must retain readable annotations while rejecting invalid source writes.
    for (const text of [
      templateText.replace('"category_id": 1', '"category_id": 99'),
      templateText.replace('30,', '300,'),
    ]) {
      assert.notStrictEqual(text, templateText);
      fs.writeFileSync(templates.annotationFile, text);
      templates.load();
      assert(templates.readErrors.length);
      assert.strictEqual(templates.getAnnotationsForImage(image, true).length, 1);
      assert.throws(() => templates.save(), /Unreadable annotation file/);
      await assert.rejects(templates.saveToAssets(path.join(project, 'invalid-assets')), /annotation source is invalid/);
      assert.strictEqual(fs.readFileSync(templates.annotationFile, 'utf8'), text);
      assert(!fs.existsSync(path.join(project, 'invalid-assets')));
    }
    const templateGallery = new Gallery({ onDidReceiveMessage: () => ({ dispose() {} }), postMessage: () => Promise.resolve(true) },
      templates, folder, () => true, { fsPath: root });
    disposables.push(templateGallery);
    await templateGallery.update();
    assert(errors.includes('The annotation source is invalid. Fix the source file before saving or exporting.'));
    const reservedSources = [
      ['coco_annotations.json', { images: [{ id: 1, file_name: '1.png', width: 100, height: 100 }], annotations: [], categories: [] }],
      ['boxes.json', { images: [{ id: 1, file_name: '1.png', width: 100, height: 100 }], annotations: [], categories: [] }],
      ['boxes.json', { version: 1, boxes: [{ path: 'screen.old', image: '1.png', rect: [0, 0, 1, 1] }] }],
      ['boxes.json', { version: 2, images: [{ file: '1.png', width: 100, height: 100 }], boxes: [] }],
    ];
    for (const [index, [fileName, content]] of reservedSources.entries()) {
      const isolatedRoot = path.join(project, 'reservations-' + index);
      const isolatedDir = path.join(isolatedRoot, 'ok_templates');
      fs.mkdirSync(isolatedDir, { recursive: true });
      const reservedFile = path.join(isolatedDir, fileName);
      const text = JSON.stringify(content);
      fs.writeFileSync(reservedFile, text);
      const importing = new TemplateAssetData(isolatedRoot, fileName === 'boxes.json' ? 'coco_annotations.json' : 'boxes.json');
      assert.strictEqual(importing.nextImageName(), '2');
      assert.strictEqual(importing.importImageFile(image), path.join(isolatedDir, '2.png'));
      assert(!fs.existsSync(path.join(isolatedDir, '1.png')));
      assert.strictEqual(fs.readFileSync(reservedFile, 'utf8'), text);
      assert.strictEqual(importing.data.images.length, 0);
    }
  } finally {
    for (const disposable of disposables) disposable.dispose();
    Module._load = originalLoad;
    fs.rmSync(project, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode=1; });
