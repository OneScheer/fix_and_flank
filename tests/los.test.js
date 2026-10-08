// Hex milestone 3 acceptance: LOS through woods and buildings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOfSight, visibleFrom } from '../src/sim/los.js';
import { parseMap } from '../src/sim/map.js';
import { createRng } from '../src/sim/rng.js';
import { H, LEGEND, balance, loadJson, makeMap } from './helpers.js';

const los = (map, a, b) => lineOfSight(map, balance, a, b);
const mapWith = (rows, hexsides = []) => parseMap({ width: rows[0].length, height: rows.length, legend: LEGEND, rows, hexsides }, balance);

test('open ground: clear, with the range in hexes', () => {
  const r = los(makeMap(['........']), H(0, 0), H(7, 0));
  assert.equal(r.clear, true);
  assert.equal(r.range, 7);
});

test('woods in between block sight, and say where', () => {
  const r = los(makeMap(['...T....']), H(0, 0), H(7, 0));
  assert.equal(r.clear, false);
  assert.equal(r.reason, 'woods at 3,0');
  assert.deepEqual(r.blockedAt, H(3, 0));
});

test('a building in between blocks sight', () => {
  assert.equal(los(makeMap(['....B...']), H(0, 0), H(7, 0)).reason, 'building at 4,0');
});

test('scrub, rubble, trench and water do not block sight', () => {
  for (const c of [':', '%', 'n', '~']) {
    assert.equal(los(makeMap([`...${c}....`]), H(0, 0), H(7, 0)).clear, true, c);
  }
});

test('the observer\'s and the target\'s own hexes never block: you can see out of and into woods', () => {
  const map = makeMap(['T......T']);
  assert.equal(los(map, H(0, 0), H(7, 0)).clear, true);
  assert.equal(los(makeMap(['TT......']), H(0, 0), H(7, 0)).clear, false, 'but woods behind the edge do');
});

test('adjacent hexes always see each other', () => {
  assert.equal(los(makeMap(['TT']), H(0, 0), H(1, 0)).clear, true);
});

test('a hedge blocks sight across it, except for units at the hedge itself', () => {
  // Hedge on the edge between 3,0 and 4,0.
  const map = mapWith(['........'], [{ hex: [3, 0], sides: ['E'], feature: 'hedge' }]);
  assert.match(los(map, H(0, 0), H(7, 0)).reason, /hedge between 3,0 and 4,0/);
  assert.equal(los(map, H(3, 0), H(7, 0)).clear, true, 'at the hedge, looking over it');
  assert.equal(los(map, H(0, 0), H(4, 0)).clear, true, 'seeing a unit at the hedge');
});

test('walls and parapets do not block sight', () => {
  const map = mapWith(['........'], [
    { hex: [2, 0], sides: ['E'], feature: 'wall' },
    { hex: [5, 0], sides: ['W'], feature: 'parapet' },
  ]);
  assert.equal(los(map, H(0, 0), H(7, 0)).clear, true);
});

test('a line along hex edges is clear if either way of drawing it is', () => {
  // Straight down the column from 2,0 to 2,4 runs between the hexes of rows 1 and 3.
  const map = makeMap(['.....', '.T...', '.....', '.T...', '.....']);
  const r = los(map, H(2, 0), H(2, 4));
  assert.equal(r.clear, true, 'woods on one side only');
  const both = makeMap(['.....', '.TT..', '.....', '.TT..', '.....']);
  assert.equal(los(both, H(2, 0), H(2, 4)).clear, false, 'woods on both sides');
});

test('beyond the sight range there is no line of sight', () => {
  const n = balance.vision.maxRangeHexes + 2;
  const r = los(makeMap(['.'.repeat(n)]), H(0, 0), H(n - 1, 0));
  assert.equal(r.reason, 'out of sight range');
});

test('line of sight is symmetric on the training map', () => {
  const map = parseMap(loadJson('data/maps/training.json'), balance);
  const rng = createRng(11);
  let blocked = 0;
  for (let i = 0; i < 3000; i++) {
    const a = H(rng.int(map.width), rng.int(map.height));
    const b = H(rng.int(map.width), rng.int(map.height));
    const ab = los(map, a, b).clear;
    assert.equal(ab, los(map, b, a).clear, `${a.col},${a.row} <-> ${b.col},${b.row}`);
    if (!ab) blocked++;
  }
  assert.ok(blocked > 200, `${blocked} blocked lines in the sample`);
});

test('visibleFrom lists exactly the hexes with line of sight', () => {
  const map = makeMap(['...T....', '........']);
  const seen = visibleFrom(map, balance, H(0, 0));
  assert.ok(seen.some((h) => h.col === 3 && h.row === 0), 'the woods hex itself');
  assert.ok(!seen.some((h) => h.col === 6 && h.row === 0), 'behind the woods');
});
