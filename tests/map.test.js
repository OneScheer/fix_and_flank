import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, tileAt, isPassable, stepCost } from '../src/sim/map.js';
import { LEGEND, balance, loadJson, makeMap } from './helpers.js';

const movement = balance.movement;

test('training map parses at the default 80 x 80 size', () => {
  const map = parseMap(loadJson('data/maps/training.json'));
  assert.equal(map.width, balance.map.defaultWidth);
  assert.equal(map.height, balance.map.defaultHeight);
  assert.equal(map.tiles.length, 80 * 80);
  assert.ok(map.units.some((u) => u.side === 'BLUFOR'));
  assert.ok(map.units.some((u) => u.side === 'OPFOR'));
});

test('missing tile fields get defaults', () => {
  const t = tileAt(makeMap(['.']), 0, 0);
  assert.deepEqual({ ...t }, { terrain: 'grass', height: 0, cover: 'none', concealment: 'none', feature: 'none' });
});

test('parsed maps are frozen', () => {
  const map = makeMap(['..']);
  assert.ok(Object.isFrozen(map) && Object.isFrozen(map.tiles) && Object.isFrozen(map.tiles[0]));
});

test('bad maps are rejected with a clear error', () => {
  const base = { width: 2, height: 1, legend: LEGEND };
  assert.throws(() => parseMap({ ...base, rows: ['...'] }), /Row 0 has 3 tiles/);
  assert.throws(() => parseMap({ ...base, rows: ['.?'] }), /Unknown tile '\?'/);
  assert.throws(() => parseMap({ ...base, rows: ['..', '..'] }), /2 rows, expected 1/);
  assert.throws(() => parseMap({ ...base, legend: { '.': { terrain: 'lava' } }, rows: ['..'] }), /bad terrain 'lava'/);
  assert.throws(() => parseMap({ ...base, rows: ['.~'], units: [{ side: 'BLUFOR', team: 'A', role: 'TL', pos: [1, 0] }] }), /impassable/);
  assert.throws(
    () => parseMap({ ...base, rows: ['..'], units: [{ side: 'B', team: 'A', role: 'TL', pos: [0, 0] }, { side: 'B', team: 'A', role: 'AR', pos: [0, 0] }] }),
    /Two units/,
  );
});

test('passability: water, high walls and windows block; doors and low walls do not', () => {
  const map = makeMap(['.~#WD-']);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((x) => isPassable(tileAt(map, x, 0))), [true, false, false, false, true, true]);
});

test('step cost scales with terrain, diagonals and low obstacles', () => {
  const map = makeMap(['.T-', '...']);
  const at = (x, y) => ({ x, y });
  assert.equal(stepCost(map, movement, at(0, 1), at(1, 1)), 1);
  assert.equal(stepCost(map, movement, at(0, 1), at(1, 0)), Math.SQRT2 * movement.terrainCost.forest);
  assert.equal(stepCost(map, movement, at(1, 1), at(2, 0)), Math.SQRT2 * movement.lowObstacleCost);
});

test('diagonal steps cannot cut the corner of a wall', () => {
  const map = makeMap(['.#', '..']);
  assert.equal(stepCost(map, movement, { x: 0, y: 0 }, { x: 1, y: 1 }), Infinity);
});
