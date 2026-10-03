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

function makePublishFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-position-publish-'));
  const directory = 'templates';
  const templates = path.join(root, directory);
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(templates, 'points.json'), JSON.stringify({
    version: 1,
    images: [{ file: 'screen.png', width: 100, height: 100 }],
    points: [{ path: 'screen.anchor', image: 'screen.png', x: 50, y: 50 }],
  }, null, 2));
  return { root, directory };
}

{
  const { root, directory } = makePublishFixture();
  try {
    fs.writeFileSync(path.join(root, directory, 'boxes.json'), '{ invalid json');
    const collected = publishStore.collectPositionRuntime(root, directory);
    assert.strictEqual(collected.file.positions.length, 0);
    assert(collected.errors.some(error => error.startsWith('boxes:')));

    const result = publishStore.publishPositionJson(root, directory);
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
    const result = publishStore.publishPositionJson(root, directory);
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
    const result = publishStore.publishPositionPython(root, directory);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.errors, ['write']);
    assert.strictEqual(fs.readFileSync(ratioFile, 'utf8'), oldRatio);
    assert.strictEqual(fs.readFileSync(mapFile, 'utf8'), oldMap);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('position resource tests passed');
