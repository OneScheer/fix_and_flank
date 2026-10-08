import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction } from '../src/sim/actions.js';
import { coverAgainst, describeCover } from '../src/sim/cover.js';
import { neighborOn, opposite, sidesFacing } from '../src/sim/hex.js';
import { parseMap, sideFeature } from '../src/sim/map.js';
import { createRng } from '../src/sim/rng.js';
import { mayFire } from '../src/sim/state.js';
import { H, LEGEND, balance, loadJson, makeState, open, unit } from './helpers.js';

const mapWith = (rows, hexsides) => parseMap({ width: rows[0].length, height: rows.length, legend: LEGEND, rows, hexsides }, balance);

test('sides: names, opposites, neighbors', () => {
  assert.equal(opposite('E'), 'W');
  assert.equal(opposite('NE'), 'SW');
  assert.deepEqual(neighborOn(H(4, 4), 'E'), H(5, 4));
  assert.deepEqual(neighborOn(H(4, 4), 'SE'), H(4, 5));
  assert.deepEqual(neighborOn(H(4, 5), 'NE'), H(5, 4));
});

test('the side facing a shooter, and both sides when the line runs through a corner', () => {
  assert.deepEqual(sidesFacing(H(4, 4), H(8, 4)), ['E']);
  assert.deepEqual(sidesFacing(H(4, 4), H(4, 5)), ['SE']);
  assert.deepEqual(sidesFacing(H(4, 4), H(3, 5)), ['SW']);
  // Straight south (two rows down, same column) runs through the bottom corner.
  assert.deepEqual(sidesFacing(H(4, 4), H(4, 6)), ['SE', 'SW']);
});

// A trench hex with parapets on its two southern sides.
const trench = () => mapWith(['.......', '.......', '...n...', '.......', '.......', '.......'],
  [{ hex: [3, 2], sides: ['SW', 'SE'], feature: 'parapet' }]);

test('a trench with a parapet: hard to hurt from the front, only the trench from the flank', () => {
  const map = trench();
  const front = coverAgainst(map, balance, H(3, 2), H(3, 5));
  assert.equal(front.casualtyOn, balance.hexsides.parapet.casualtyOn);
  assert.equal(front.source, 'hexside');
  assert.equal(describeCover(front), `behind a parapet (${front.side} side)`);
  const flank = coverAgainst(map, balance, H(3, 2), H(6, 2));
  assert.equal(flank.casualtyOn, balance.terrain.trench.casualtyOn);
  assert.equal(describeCover(flank), 'in trench');
  const rear = coverAgainst(map, balance, H(3, 2), H(3, 0));
  assert.equal(rear.source, 'terrain');
  assert.ok(front.casualtyOn > flank.casualtyOn, 'flanking pays');
});

test('a parapet belongs to its own hex only; a wall counts on both sides', () => {
  const map = mapWith(['.....', '.....', '.....'], [
    { hex: [1, 1], sides: ['E'], feature: 'parapet' },
    { hex: [3, 1], sides: ['W'], feature: 'wall' },
  ]);
  assert.equal(sideFeature(map, H(1, 1), 'E'), 'parapet');
  assert.equal(sideFeature(map, H(2, 1), 'W'), null, 'the parapet is not shared');
  assert.equal(sideFeature(map, H(3, 1), 'W'), 'wall');
  assert.equal(sideFeature(map, H(2, 1), 'E'), 'wall', 'the wall is shared');
  assert.equal(coverAgainst(map, balance, H(2, 1), H(4, 1)).casualtyOn, balance.hexsides.wall.casualtyOn);
  assert.equal(coverAgainst(map, balance, H(3, 1), H(0, 1)).casualtyOn, balance.hexsides.wall.casualtyOn);
});

test('terrain cover still counts when it is better than the side feature', () => {
  const map = mapWith(['.%..'], [{ hex: [1, 0], sides: ['E'], feature: 'hedge' }]);
  const c = coverAgainst(map, balance, H(1, 0), H(3, 0));
  assert.equal(c.source, 'terrain');
  assert.equal(c.casualtyOn, balance.terrain.rubble.casualtyOn);
});

test('bad hexside entries are rejected', () => {
  assert.throws(() => mapWith(['..'], [{ hex: [0, 0], sides: ['N'], feature: 'wall' }]), /unknown side 'N'/);
  assert.throws(() => mapWith(['..'], [{ hex: [0, 0], sides: ['E'], feature: 'moat' }]), /unknown feature 'moat'/);
});

test('training map: the OPFOR trench faces south', () => {
  const map = parseMap(loadJson('data/maps/training.json'), balance);
  const op = map.units.find((u) => u.side === 'OPFOR');
  const hex = H(...op.pos);
  assert.equal(coverAgainst(map, balance, hex, H(4, 9)).feature, 'parapet');
  assert.equal(coverAgainst(map, balance, hex, H(10, 2)).feature, null, 'open from the east flank');
});

test('a unit that moved this turn cannot fire until next turn', () => {
  let s = makeState(open(6, 6), [unit('BLUFOR', 'ALPHA', 2, 5), unit('OPFOR', 'ALPHA', 2, 0)]);
  assert.equal(mayFire(s.units[0]).ok, true);
  s = applyAction(s, { type: 'move', unit: 0, to: H(2, 4) }, createRng(1)).state;
  assert.match(mayFire(s.units[0]).reason, /moved this turn/);
  s = applyAction(s, { type: 'pass', unit: 1 }, createRng(1)).state; // turn ends
  assert.equal(s.turn, 2);
  assert.equal(mayFire(s.units[0]).ok, true);
  s.units[0].status = 'pinned';
  assert.match(mayFire(s.units[0]).reason, /pinned and cannot fire/);
});
