const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const position = require('../out/positionResourcePure');
const publishStore = require('../out/positionPublishStore');

const images = [{ file: 'screen.png', width: 1920, height: 1080 }];
const published = position.publishPositions([
  {
    path: 'screen.main_viewport',
    image: 'screen.png',
    kind: 'rect',
    rect: { x: 192, y: 108, w: 1536, h: 864 },
  },
  {
    path: 'panels.esc.mail',
    image: 'screen.png',
    kind: 'point',
    point: { x: 1672, y: 943 },
  },
], images);

assert.deepStrictEqual(published.errors, []);
assert.deepStrictEqual(published.file.positions, [
  { path: 'panels.esc.mail', coordinates: [0.870833, 0.873148] },
  { path: 'screen.main_viewport', coordinates: [0.1, 0.1, 0.9, 0.9] },
]);

const json = position.serializePositionJson(published.file);
assert(json.includes('"version": 2'));
assert(json.includes('"panels.esc.mail"'));

const map = position.serializePositionMapPython(published.file);
assert(map.includes('class ScreenPosition:'));
assert(map.includes('main_viewport = ScreenRatio(0.1, 0.1, 0.9, 0.9)'));
assert(map.includes('class Position_6_panels__3_esc:'));
assert(map.includes('mail = ScreenRatio(0.870833, 0.873148)'));
assert(map.includes('self.panels = Position_6_panels(parent)'));

const ratio = position.serializeScreenRatioPython();
assert(ratio.includes('if len(coordinates) not in (2, 4):'));
assert(ratio.includes('Only a rect ScreenRatio can be converted to a Box'));

assert.strictEqual(position.positionPathError('screen.main_viewport'), undefined);
assert.strictEqual(position.positionPathError('screen'), 'shallow');
assert.strictEqual(position.positionPathError('screen.bad-name'), 'segment');
assert.strictEqual(position.positionPathError('screen.class'), 'segment');
assert.strictEqual(position.positionPathError('screen._parent'), 'segment');
assert.strictEqual(position.positionPathError('screen.__class__'), 'segment');
assert.strictEqual(position.positionPathError('screen.__slots__'), 'segment');

const collision = position.publishPositions([
  { path: 'screen.same', image: 'screen.png', kind: 'rect', rect: { x: 1, y: 2, w: 3, h: 4 } },
  { path: 'screen.same', image: 'screen.png', kind: 'point', point: { x: 10, y: 20 } },
], images);
assert(collision.errors.includes('duplicate:screen.same'));
assert.strictEqual(collision.file.positions.length, 1);

const collisionSafe = position.publishPositions([
  { path: 'a_b.c.first', image: 'screen.png', kind: 'point', point: { x: 100, y: 100 } },
  { path: 'a.b_c.second', image: 'screen.png', kind: 'point', point: { x: 200, y: 200 } },
  { path: 'foo.child.lower', image: 'screen.png', kind: 'point', point: { x: 300, y: 300 } },
  { path: 'Foo.child.upper', image: 'screen.png', kind: 'point', point: { x: 400, y: 400 } },
], images);
assert.deepStrictEqual(collisionSafe.errors, []);
const collisionSafeMap = position.serializePositionMapPython(collisionSafe.file);
assert(collisionSafeMap.includes('class Position_3_a_b:'));
assert(collisionSafeMap.includes('class Position_1_a:'));
assert(collisionSafeMap.includes('class Position_3_foo:'));
assert(collisionSafeMap.includes('class Position_3_Foo:'));
assert(!collisionSafeMap.includes('class ABCPosition:'));

function pointCoco() {
  return {
    images: [{ id: 1, file_name: 'screen.png', width: 100, height: 100 }],
    categories: [{ id: 1, name: 'screen.anchor', supercategory: 'screen' }],
    annotations: [{
      id: 1,
      image_id: 1,
      category_id: 1,
      bbox: [50, 50, 0, 0],
      area: 0,
      iscrowd: 0,
    }],
  };
}

function rectCoco() {
  return {
    images: [{ id: 1, file_name: 'screen.png', width: 100, height: 100 }],
    categories: [{ id: 1, name: 'screen.box', supercategory: 'screen' }],
    annotations: [{
      id: 1,
      image_id: 1,
      category_id: 1,
      bbox: [10, 20, 30, 40],
      area: 1200,
      iscrowd: 0,
    }],
  };
}

function makePublishFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-position-publish-'));
  const directory = 'templates';
  const templates = path.join(root, directory);
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(templates, 'points.json'), JSON.stringify(pointCoco(), null, 2));
  fs.writeFileSync(path.join(templates, 'boxes.json'), JSON.stringify(rectCoco(), null, 2));
  return { root, directory };
}

{
  const { root, directory } = makePublishFixture();
  try {
    const rectOnly = publishStore.collectPositionRuntime(root, directory, { rect: true, point: false });
    assert.deepStrictEqual(rectOnly.errors, []);
    assert.deepStrictEqual(rectOnly.file.positions.map(item => item.path), ['screen.box']);

    const pointOnly = publishStore.collectPositionRuntime(root, directory, { rect: false, point: true });
    assert.deepStrictEqual(pointOnly.errors, []);
    assert.deepStrictEqual(pointOnly.file.positions.map(item => item.path), ['screen.anchor']);

    const both = publishStore.collectPositionRuntime(root, directory, { rect: true, point: true });
    assert.deepStrictEqual(both.errors, []);
    assert.deepStrictEqual(both.file.positions.map(item => item.path), ['screen.anchor', 'screen.box']);

    const none = publishStore.collectPositionRuntime(root, directory, { rect: false, point: false });
    assert.deepStrictEqual(none.errors, ['selection']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, directory } = makePublishFixture();
  try {
    fs.writeFileSync(path.join(root, directory, 'boxes.json'), '{ invalid json');
    const collected = publishStore.collectPositionRuntime(root, directory, { rect: true, point: true });
    assert.strictEqual(collected.file.positions.length, 0);
    assert(collected.errors.some(error => error.startsWith('boxes:')));

    const pointOnly = publishStore.publishPositionJson(
      root,
      directory,
      { rect: false, point: true },
      publishStore.DEFAULT_POSITION_JSON,
    );
    assert.strictEqual(pointOnly.ok, true);

    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    const result = publishStore.publishPositionJson(
      root,
      directory,
      { rect: true, point: true },
      publishStore.DEFAULT_POSITION_JSON,
    );
    assert.strictEqual(result.ok, false);
    assert(result.errors.some(error => error.startsWith('boxes:')));
    assert.strictEqual(fs.existsSync(path.join(root, 'src', 'scene', 'positions.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, directory } = makePublishFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-position-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'src', 'scene'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = publishStore.publishPositionJson(
      root,
      directory,
      { rect: true, point: true },
      publishStore.DEFAULT_POSITION_JSON,
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.errors, ['target']);
    assert.strictEqual(fs.existsSync(path.join(outside, 'positions.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

{
  const { root, directory } = makePublishFixture();
  const scene = path.join(root, 'src', 'scene');
  const ratioFile = path.join(scene, 'ScreenRatio.py');
  const mapFile = path.join(scene, 'PositionMap.py');
  fs.mkdirSync(scene, { recursive: true });
  const oldRatio = `${publishStore.GENERATED_MARKER}\n# old ratio\n`;
  const oldMap = `${publishStore.GENERATED_MARKER}\n# old map\n`;
  fs.writeFileSync(ratioFile, oldRatio);
  fs.writeFileSync(mapFile, oldMap);

  const originalRename = fs.renameSync;
  let failedMapRename = false;
  fs.renameSync = function patchedRename(from, to) {
    if (!failedMapRename && path.basename(String(to)) === 'PositionMap.py') {
      failedMapRename = true;
      const error = new Error('forced PositionMap write failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    const result = publishStore.publishPositionPython(
      root,
      directory,
      { rect: true, point: true },
      publishStore.DEFAULT_POSITION_PY_DIR,
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.errors, ['write']);
    assert.strictEqual(fs.readFileSync(ratioFile, 'utf8'), oldRatio);
    assert.strictEqual(fs.readFileSync(mapFile, 'utf8'), oldMap);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The only user-facing Publish entry is in the original-image/annotation panel.
// It must expose all three resource types as a multi-select; Resource Preview is preview-only.
{
  const root = path.join(__dirname, '..');
  const host = fs.readFileSync(path.join(root, 'src', 'templateAssetPanel.ts'), 'utf8');
  const assetHtml = fs.readFileSync(path.join(root, 'media', 'templateAssetPanel', 'index.html'), 'utf8');
  const previewHtml = fs.readFileSync(path.join(root, 'media', 'templatePanel', 'index.html'), 'utf8');
  assert(host.includes('canPickMany: true'));
  assert(host.includes("label: 'Template'"));
  assert(host.includes("label: 'Rect'"));
  assert(host.includes("label: 'Point'"));
  assert(host.includes("selected.has('template')"));
  assert(host.includes("rect: selected.has('rect')"));
  assert(host.includes("point: selected.has('point')"));
  assert(assetHtml.includes('id="saveBtn">Publish</button>'));
  assert(!previewHtml.includes('Publish positions'));
  assert(!previewHtml.includes('publishPositionsBtn'));
}

console.log('position resource tests passed');
