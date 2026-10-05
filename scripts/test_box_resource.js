#!/usr/bin/env node
/** Regression tests for the current rect authoring model. No legacy runtime protocol exists. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const pure = require('../out/boxResourcePure');
const store = require('../out/boxResourceStore');
const { CocoAnnotationData, writeAnnotationTextIfUnchanged } = require('../out/cocoAnnotationData');

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
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-rect-authoring-'));
const directory = 'ok_templates';
const folder = path.join(project, directory);
fs.mkdirSync(folder);
writePng(path.join(folder, 'a.png'), 100, 100);
writePng(path.join(folder, 'b.png'), 200, 200);

try {
  const source = path.join(folder, 'boxes.json');

  // The compare-and-write handoff must preserve a writer that recreates the path
  // after the expected revision was moved aside but before our prepared file is installed.
  const casFile = path.join(folder, 'cas.json');
  fs.writeFileSync(casFile, 'expected', 'utf8');
  const originalLink = fs.linkSync;
  let injectedExternalWrite = false;
  fs.linkSync = function (from, to) {
    if (!injectedExternalWrite && path.resolve(String(to)) === path.resolve(casFile)) {
      injectedExternalWrite = true;
      fs.writeFileSync(casFile, 'external', 'utf8');
      const error = new Error('already exists');
      error.code = 'EEXIST';
      throw error;
    }
    return originalLink.apply(this, arguments);
  };
  try {
    assert.strictEqual(writeAnnotationTextIfUnchanged(casFile, 'ours', 'expected', false), false);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.strictEqual(fs.readFileSync(casFile, 'utf8'), 'external',
    'a writer that recreates the path during handoff must win instead of being overwritten');

  // Recovery must use the same hard-link -> exclusive-copy fallback as installation.
  const recoveryFile = path.join(folder, 'recovery.json');
  fs.writeFileSync(recoveryFile, 'expected', 'utf8');
  fs.linkSync = function (from, to) {
    if (String(from).includes('.previous') && path.resolve(String(to)) === path.resolve(recoveryFile)) {
      const error = new Error('hard links unavailable');
      error.code = 'EPERM';
      throw error;
    }
    return originalLink.apply(this, arguments);
  };
  try {
    assert.strictEqual(writeAnnotationTextIfUnchanged(recoveryFile, 'ours', 'stale', false), false);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.strictEqual(fs.readFileSync(recoveryFile, 'utf8'), 'expected',
    'revision mismatch restores the previous bytes through the copy fallback');

  // If installation fails after the old file is moved aside, restore it but keep the original error.
  const installFailureFile = path.join(folder, 'install-failure.json');
  fs.writeFileSync(installFailureFile, 'expected', 'utf8');
  fs.linkSync = function (from, to) {
    if (String(from).includes('.tmp') && path.resolve(String(to)) === path.resolve(installFailureFile)) {
      const error = new Error('prepared install failed');
      error.code = 'EIO';
      throw error;
    }
    return originalLink.apply(this, arguments);
  };
  try {
    assert.throws(
      () => writeAnnotationTextIfUnchanged(installFailureFile, 'ours', 'expected', false),
      error => error && error.code === 'EIO' && error.message === 'prepared install failed',
    );
  } finally {
    fs.linkSync = originalLink;
  }
  assert.strictEqual(fs.readFileSync(installFailureFile, 'utf8'), 'expected',
    'failed install restores the original file before rethrowing the install error');

  // If restoration itself fails, never delete the only preserved previous copy.
  const recoveryFailureFile = path.join(folder, 'recovery-failure.json');
  fs.writeFileSync(recoveryFailureFile, 'expected', 'utf8');
  const originalCopy = fs.copyFileSync;
  fs.linkSync = function (from, to) {
    if (String(from).includes('.previous') && path.resolve(String(to)) === path.resolve(recoveryFailureFile)) {
      const error = new Error('hard links unavailable');
      error.code = 'EPERM';
      throw error;
    }
    return originalLink.apply(this, arguments);
  };
  fs.copyFileSync = function (from, to) {
    if (String(from).includes('.previous') && path.resolve(String(to)) === path.resolve(recoveryFailureFile)) {
      const error = new Error('restore copy failed');
      error.code = 'EIO';
      throw error;
    }
    return originalCopy.apply(this, arguments);
  };
  try {
    assert.throws(
      () => writeAnnotationTextIfUnchanged(recoveryFailureFile, 'ours', 'stale', false),
      error => error && error.code === 'EIO' && error.message === 'restore copy failed',
    );
  } finally {
    fs.linkSync = originalLink;
    fs.copyFileSync = originalCopy;
  }
  assert.strictEqual(fs.existsSync(recoveryFailureFile), false);
  const preservedPrevious = fs.readdirSync(folder).find(name => name.startsWith('.recovery-failure.json.') && name.endsWith('.previous'));
  assert(preservedPrevious, 'failed recovery preserves the previous copy for manual recovery');
  assert.strictEqual(fs.readFileSync(path.join(folder, preservedPrevious), 'utf8'), 'expected');
  fs.rmSync(path.join(folder, preservedPrevious), { force: true });

  assert.deepStrictEqual(store.authoringReadErrors(project, directory), []);
  assert.deepStrictEqual(store.readAuthoringFile(project, directory), { images: [], boxes: [] });

  assert.strictEqual(store.addBox(project, directory, 'screen.first', 'a.png', { x: 10, y: 20, w: 30, h: 40 }), undefined);
  assert.strictEqual(store.addBox(project, directory, 'panels.allowed', 'a.png', { x: 1, y: 2, w: 3, h: 4 }), undefined,
    'rect and point resources share the same namespace grammar; panels.* is not reserved');
  assert.strictEqual(store.addBox(project, directory, 'screen.first', 'b.png', { x: 1, y: 2, w: 3, h: 4 }), 'duplicate');
  assert.strictEqual(store.addBox(project, directory, 'screen', 'b.png', { x: 1, y: 2, w: 3, h: 4 }), 'shallow');
  assert.strictEqual(store.addBox(project, directory, 'screen.bad-name', 'b.png', { x: 1, y: 2, w: 3, h: 4 }), 'segment');
  assert.strictEqual(store.addBox(project, directory, 'screen.outside', 'a.png', { x: 99, y: 2, w: 3, h: 4 }), 'rect');

  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  assert(Array.isArray(raw.images));
  assert(Array.isArray(raw.annotations));
  assert(Array.isArray(raw.categories));
  assert(!Object.prototype.hasOwnProperty.call(raw, 'version'));
  assert(!Object.prototype.hasOwnProperty.call(raw, 'boxes'));

  // CocoAnnotationData guarded saves use the same expected revision and leave newer disk data intact.
  const guardedData = new CocoAnnotationData(project, directory, 'boxes.json');
  guardedData.load();
  const guardedRevision = guardedData.revision;
  const externalRevision = guardedRevision + '\n';
  fs.writeFileSync(source, externalRevision, 'utf8');
  assert.strictEqual(guardedData.saveIfRevision(guardedRevision), false);
  assert.strictEqual(fs.readFileSync(source, 'utf8'), externalRevision);
  fs.writeFileSync(source, guardedRevision, 'utf8');

  const authoring = store.readAuthoringFile(project, directory);
  assert.deepStrictEqual(authoring.boxes.map(box => box.path).sort(), ['panels.allowed', 'screen.first']);
  assert.deepStrictEqual(authoring.boxes.find(box => box.path === 'screen.first').bbox, [10, 20, 30, 40]);
  assert.strictEqual(store.boxesForImage(authoring, 'A.PNG').length, 2);
  assert.deepStrictEqual(store.authoringImageSize(project, directory, 'a.png'), { width: 100, height: 100 });

  const snapshot = store.captureAuthoring(project, directory);
  assert(snapshot && typeof snapshot.text === 'string');
  assert(store.removeImageBoxes(project, directory, 'a.png'));
  assert.deepStrictEqual(store.readAuthoringFile(project, directory).boxes, []);
  assert(store.restoreAuthoring(project, directory, snapshot));
  assert.deepStrictEqual(store.readAuthoringFile(project, directory).boxes.map(box => box.path).sort(), ['panels.allowed', 'screen.first']);

  // Template recovery is read-only and only exposes annotations whose retained image exists and bbox fits it.
  const templateSource = path.join(folder, 'coco_annotations.json');
  fs.writeFileSync(templateSource, JSON.stringify({
    images: [
      { id: 1, file_name: 'a.png', width: 100, height: 100 },
      { id: 2, file_name: 'bad.png', width: 'invalid', height: 100 },
    ],
    categories: [{ id: 1, name: 'template.valid', supercategory: '' }],
    annotations: [
      { id: 1, image_id: 1, category_id: 1, bbox: [1, 2, 3, 4], area: 12, iscrowd: 0 },
      { id: 2, image_id: 1, category_id: 1, bbox: [90, 90, 20, 20], area: 400, iscrowd: 0 },
      { id: 3, image_id: 999, category_id: 1, bbox: [1, 1, 2, 2], area: 4, iscrowd: 0 },
      { id: 4, image_id: 2, category_id: 1, bbox: [1, 1, 2, 2], area: 4, iscrowd: 0 },
    ],
  }), 'utf8');
  const templateData = new CocoAnnotationData(project, directory);
  templateData.load();
  assert(templateData.readErrors.length > 0, 'invalid COCO remains invalid and cannot be saved');
  assert.deepStrictEqual(templateData.data.images.map(image => image.id), [1],
    'recovery display excludes structurally invalid images');
  assert.deepStrictEqual(templateData.data.annotations.map(annotation => annotation.id), [1],
    'recovery display filters missing-image, filtered-image, and out-of-bounds annotations');

  // Unsupported legacy / malformed rect sources remain invalid for read/publish,
  // but edit paths may discard them and overwrite with current COCO data.
  fs.writeFileSync(source, JSON.stringify({ version: 1, boxes: [{ path: 'legacy.box' }] }), 'utf8');
  assert(store.authoringReadErrors(project, directory).length > 0);
  assert.strictEqual(store.addBox(project, directory, 'screen.replaced_legacy', 'a.png', { x: 2, y: 3, w: 4, h: 5 }), undefined);
  let replaced = JSON.parse(fs.readFileSync(source, 'utf8'));
  assert.deepStrictEqual(replaced.categories.map(item => item.name), ['screen.replaced_legacy']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(replaced, 'boxes'), false);

  fs.writeFileSync(source, '{ broken json', 'utf8');
  assert(store.authoringReadErrors(project, directory).includes('json'));
  assert.strictEqual(store.removeImageBoxes(project, directory, 'a.png'), true);
  replaced = JSON.parse(fs.readFileSync(source, 'utf8'));
  assert.deepStrictEqual(replaced, { images: [], annotations: [], categories: [] });

  // Real read failures remain hard failures and must never be treated as an empty file to overwrite.
  fs.writeFileSync(source, JSON.stringify({ images: [], annotations: [], categories: [] }), 'utf8');
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (file) {
    if (path.resolve(String(file)) === path.resolve(source)) {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalRead.apply(this, arguments);
  };
  try {
    assert.deepStrictEqual(store.authoringReadErrors(project, directory), ['read']);
    assert.strictEqual(store.addBox(project, directory, 'screen.blocked', 'a.png', { x: 1, y: 1, w: 2, h: 2 }), 'parse');
    assert.strictEqual(store.removeImageBoxes(project, directory, 'a.png'), false);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(source, 'utf8')), { images: [], annotations: [], categories: [] });

  assert.strictEqual(pure.boxPathError('panels.point'), undefined);
  assert.deepStrictEqual(
    pure.unionPixelBoxes([{ x: 1, y: 2, w: 3, h: 4 }, { x: 0, y: 1, w: 2, h: 2 }]),
    { x: 0, y: 1, w: 4, h: 5 },
  );
  assert(pure.parseBoxCoco(JSON.stringify({ version: 1, boxes: [] })).errors.length > 0,
    'legacy version/boxes schemas are rejected instead of migrated');

  assert.strictEqual('publishRuntime' in store, false, 'legacy box runtime publisher stays deleted');
  assert.strictEqual('readRuntimeFile' in store, false, 'legacy box runtime reader stays deleted');
  assert.strictEqual('runtimeOnlyPaths' in store, false, 'legacy runtime reconciliation stays deleted');

  console.log('box resource tests passed');
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}