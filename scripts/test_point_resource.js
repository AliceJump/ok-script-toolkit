const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const points = require('../out/pointResourceStore');

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); let c = 0xffffffff;
  for (const byte of body) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function writePng(file, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-point-coco-'));
const directory = 'ok_templates';
const folder = path.join(project, directory);
fs.mkdirSync(folder);
const image = path.join(folder, 'a.png');
writePng(image, 100, 80);
const pointFile = path.join(folder, 'points.json');

// Point authoring is COCO-only. A point is represented by a zero-size bbox [x,y,0,0].
fs.writeFileSync(pointFile, JSON.stringify({
  images: [{ id: 1, file_name: 'a.png', width: 100, height: 80 }],
  categories: [{ id: 1, name: 'screen.existing', supercategory: 'screen' }],
  annotations: [{ id: 1, image_id: 1, category_id: 1, bbox: [10, 20, 0, 0], area: 0, iscrowd: 0 }],
}));
let read = points.readPoints(project, directory);
assert.deepStrictEqual(read.errors, []);
assert.deepStrictEqual(read.file.points, [{ path: 'screen.existing', image: 'a.png', x: 10, y: 20 }]);

assert.strictEqual(points.savePointsForImage(project, directory, image, [
  { path: 'screen.existing', x: 10, y: 20 },
  { path: 'screen.new', x: 30, y: 40 },
]), undefined);
const raw = JSON.parse(fs.readFileSync(pointFile, 'utf8'));
assert.deepStrictEqual(Object.keys(raw).sort(), ['annotations', 'categories', 'images']);
assert(!('version' in raw) && !('points' in raw));
assert(raw.annotations.every(ann => ann.bbox[2] === 0 && ann.bbox[3] === 0 && ann.area === 0), 'all points use zero-size COCO bboxes');
const names = new Map(raw.categories.map(category => [category.id, category.name]));
const byName = new Map(raw.annotations.map(ann => [names.get(ann.category_id), ann.bbox]));
assert.deepStrictEqual(byName.get('screen.existing'), [10,20,0,0]);
assert.deepStrictEqual(byName.get('screen.new'), [30,40,0,0]);

// Revision-guarded point saves must not overwrite a newer external revision.
const pointRevision = fs.readFileSync(pointFile, 'utf8');
const externalPointRevision = pointRevision + '\n';
fs.writeFileSync(pointFile, externalPointRevision, 'utf8');
assert.strictEqual(points.savePointsForImageIfRevision(project, directory, image, [
  { path: 'screen.existing', x: 11, y: 21 },
  { path: 'screen.new', x: 31, y: 41 },
], pointRevision), 'changed');
assert.strictEqual(fs.readFileSync(pointFile, 'utf8'), externalPointRevision,
  'stale point save preserves the external revision');
assert.strictEqual(points.savePointsForImageIfRevision(project, directory, image, [
  { path: 'screen.existing', x: 11, y: 21 },
  { path: 'screen.new', x: 31, y: 41 },
], externalPointRevision), undefined);
read = points.readPoints(project, directory);
assert.deepStrictEqual(read.file.points.map(point => [point.path, point.x, point.y]).sort(), [
  ['screen.existing', 11, 21],
  ['screen.new', 31, 41],
]);

read = points.readPoints(project, directory);
assert.deepStrictEqual(read.errors, []);
assert.strictEqual(read.file.points.length, 2);
assert.deepStrictEqual(points.pointPathOccupancy(project, directory), { 'screen.existing': 'a.png', 'screen.new': 'a.png' });

// The point source is strict about point-only geometry.
raw.annotations[0].bbox[2] = 1;
fs.writeFileSync(pointFile, JSON.stringify(raw));
assert(points.readPoints(project, directory).errors.includes('pointGeometry'));

// Legacy point v1 is intentionally rejected and never migrated implicitly.
const legacyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-point-legacy-'));
const legacyFolder = path.join(legacyProject, directory);
fs.mkdirSync(legacyFolder);
const legacyImage = path.join(legacyFolder, 'a.png');
writePng(legacyImage, 100, 80);
const legacyFile = path.join(legacyFolder, 'points.json');
const legacyText = JSON.stringify({
  version: 1,
  images: [{ file: 'a.png', width: 100, height: 80 }],
  points: [{ path: 'screen.old', image: 'a.png', x: 10, y: 20 }],
});
fs.writeFileSync(legacyFile, legacyText);
assert(points.readPoints(legacyProject, directory).errors.length > 0);
assert.strictEqual(points.savePointsForImage(legacyProject, directory, legacyImage, [{ path: 'screen.new', x: 1, y: 2 }]), 'parse');
assert.strictEqual(fs.readFileSync(legacyFile, 'utf8'), legacyText);

fs.rmSync(project, { recursive: true, force: true });
fs.rmSync(legacyProject, { recursive: true, force: true });
console.log('point resource COCO-only tests passed');
