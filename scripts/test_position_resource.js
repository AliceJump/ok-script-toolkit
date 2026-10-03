const assert = require('assert');
const position = require('../out/positionResourcePure');

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
assert(map.includes('class PanelsEscPosition:'));
assert(map.includes('mail = ScreenRatio(0.870833, 0.873148)'));
assert(map.includes('self.panels = PanelsPosition(parent)'));

const ratio = position.serializeScreenRatioPython();
assert(ratio.includes('if len(coordinates) not in (2, 4):'));
assert(ratio.includes('Only a rect ScreenRatio can be converted to a Box'));

assert.strictEqual(position.positionPathError('screen.main_viewport'), undefined);
assert.strictEqual(position.positionPathError('screen'), 'shallow');
assert.strictEqual(position.positionPathError('screen.bad-name'), 'segment');

// Rect and point authoring files have independent name scopes, but one PositionMap cannot expose
// two attributes at the same path. That conflict is intentionally deferred to export.
const collision = position.publishPositions([
  { path: 'screen.same', image: 'screen.png', kind: 'rect', rect: { x: 1, y: 2, w: 3, h: 4 } },
  { path: 'screen.same', image: 'screen.png', kind: 'point', point: { x: 10, y: 20 } },
], images);
assert(collision.errors.includes('duplicate:screen.same'));
assert.strictEqual(collision.file.positions.length, 1);

console.log('position resource tests passed');
