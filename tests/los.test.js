// Milestone 3 acceptance: LOS across walls, bushes, and height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOfSight, rayTiles } from '../src/sim/los.js';
import { parseMap } from '../src/sim/map.js';
import { createRng } from '../src/sim/rng.js';
import { LEGEND, balance, loadJson, makeMap } from './helpers.js';

const at = (x, y, stance = 'stand') => ({ pos: { x, y }, stance });
const los = (map, a, b) => lineOfSight(map, balance, a, b);

// Row-based test maps: observer on the left edge, target on the right edge.
const row = (s) => makeMap([s]);

test('open ground is clear', () => {
  const r = los(row('..........'), at(0, 0), at(9, 0));
  assert.equal(r.clear, true);
  assert.equal(r.reason, null);
  assert.equal(r.concealment, 0);
  assert.equal(r.rangeM, 9 * balance.map.tileMeters);
});

test('ray visits every tile between two points, not the end points', () => {
  assert.deepEqual(rayTiles({ x: 0, y: 0 }, { x: 3, y: 0 }).map((s) => s.tile), [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
  assert.deepEqual(rayTiles({ x: 0, y: 0 }, { x: 1, y: 1 }), [{ pair: [{ x: 1, y: 0 }, { x: 0, y: 1 }] }]);
});

// ---- walls ----

test('a high wall blocks sight at every stance, and says where', () => {
  const map = row('....#.....');
  for (const stance of ['stand', 'crouch', 'prone']) {
    const r = los(map, at(0, 0, stance), at(9, 0, stance));
    assert.equal(r.clear, false);
    assert.equal(r.reason, 'wall at 4,0');
    assert.deepEqual(r.blockedAt, { x: 4, y: 0 });
  }
});

test('a door is a gap in the wall', () => {
  const map = makeMap([
    '....#....',
    '....D....',
    '....#....',
  ]);
  assert.equal(los(map, at(0, 1), at(8, 1)).clear, true);
  assert.equal(los(map, at(0, 0), at(8, 0)).clear, false);
});

test('sight does not leak through the corner between two diagonal wall tiles', () => {
  // The ray (0,0) -> (1,1) passes exactly through the corner shared by (1,0) and (0,1).
  const diag = makeMap([
    '.#',
    '#.',
  ]);
  assert.equal(los(diag, at(0, 0), at(1, 1)).clear, false);
  const oneSide = makeMap([
    '.#',
    '..',
  ]);
  assert.equal(los(oneSide, at(0, 0), at(1, 1)).clear, true);
});

// ---- height and stance ----

test('a low wall hides prone soldiers but not standing ones', () => {
  const map = row('....-.....');
  assert.equal(los(map, at(0, 0, 'stand'), at(9, 0, 'stand')).clear, true);
  assert.equal(los(map, at(0, 0, 'prone'), at(9, 0, 'prone')).clear, false);
  assert.equal(los(map, at(0, 0, 'prone'), at(9, 0, 'prone')).reason, 'low wall at 4,0');
});

test('crouched behind a low wall: visible, but only partly', () => {
  const map = row('........-.');
  const r = los(map, at(0, 0, 'stand'), at(9, 0, 'crouch'));
  assert.equal(r.clear, true);
  assert.equal(r.partial, true);
  assert.equal(los(row('..........'), at(0, 0, 'stand'), at(9, 0, 'crouch')).partial, false);
});

test('prone right behind a low wall is hidden even from a standing observer', () => {
  const map = row('........-.');
  assert.equal(los(map, at(0, 0, 'stand'), at(9, 0, 'prone')).clear, false);
});

test('standing sees through a window, prone does not', () => {
  const map = makeMap([
    '....#....',
    '....W....',
    '....#....',
  ]);
  assert.equal(los(map, at(0, 1, 'stand'), at(8, 1, 'stand')).clear, true);
  assert.equal(los(map, at(0, 1, 'prone'), at(8, 1, 'prone')).reason, 'window at 4,1');
});

test('standing on the low wall tile itself does not block its own view', () => {
  const map = row('-........-');
  assert.equal(los(map, at(0, 0, 'prone'), at(9, 0, 'prone')).clear, true);
});

// ---- bushes and forest (concealment) ----

test('one or two tiles of forest can be seen through, three cannot', () => {
  const c = balance.vision.concealmentDensity.full;
  const two = los(row('...TT.....'), at(0, 0), at(9, 0));
  assert.equal(two.clear, true);
  assert.ok(Math.abs(two.concealment - 2 * c) < 1e-9);
  const three = los(row('...TTT....'), at(0, 0), at(9, 0));
  assert.equal(three.clear, false);
  assert.equal(three.reason, 'too much concealment (forest) at 5,0');
});

test('scrub conceals less than forest', () => {
  const scrubMap = parseMap({
    width: 10, height: 1, rows: ['...SSS....'],
    legend: { ...LEGEND, S: { terrain: 'scrub', concealment: 'partial' } },
  });
  const r = los(scrubMap, at(0, 0), at(9, 0));
  assert.equal(r.clear, true);
  assert.ok(r.concealment > 0 && r.concealment < 3 * balance.vision.concealmentDensity.full);
});

test('bushes block sight but concealment is not height: a prone and a standing soldier are treated the same', () => {
  const map = row('..TTT.....');
  assert.equal(los(map, at(0, 0, 'stand'), at(9, 0, 'stand')).clear, false);
  assert.equal(los(map, at(0, 0, 'prone'), at(9, 0, 'prone')).clear, false);
});

test('a soldier inside a forest can see out from the edge and is seen', () => {
  const map = row('TTTT......');
  // Observer at the edge (own tile does not count), target in the open.
  assert.equal(los(map, at(3, 0), at(9, 0)).clear, true);
  // Two tiles deep: one forest tile in between, still clear.
  assert.equal(los(map, at(2, 0), at(9, 0)).clear, true);
  // Four tiles deep: three forest tiles in between, blocked.
  assert.equal(los(map, at(0, 0), at(9, 0)).clear, false);
});

// ---- range and symmetry ----

test('beyond max range there is no line of sight', () => {
  const tiles = Math.ceil(balance.vision.maxRangeM / balance.map.tileMeters) + 2;
  const map = row('.'.repeat(tiles));
  const r = los(map, at(0, 0), at(tiles - 1, 0));
  assert.equal(r.clear, false);
  assert.equal(r.reason, 'out of range');
});

test('line of sight is symmetric on the training map', () => {
  const map = parseMap(loadJson('data/maps/training.json'));
  const rng = createRng(3);
  const stances = ['stand', 'crouch', 'prone'];
  let blocked = 0;
  for (let i = 0; i < 2000; i++) {
    const a = at(rng.int(map.width), rng.int(map.height), stances[rng.int(3)]);
    const b = at(rng.int(map.width), rng.int(map.height), stances[rng.int(3)]);
    if (a.pos.x === b.pos.x && a.pos.y === b.pos.y) continue;
    const ab = los(map, a, b);
    const ba = los(map, b, a);
    assert.equal(ab.clear, ba.clear, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    if (!ab.clear) blocked++;
  }
  assert.ok(blocked > 100, 'the sample includes blocked lines');
});
