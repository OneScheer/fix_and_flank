import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, terrainName, terrainOf } from '../src/sim/map.js';
import { H, LEGEND, balance, loadJson, makeMap } from './helpers.js';

test('training map parses: 12 x 12 hexes, a BLUFOR squad and a dug-in OPFOR team', () => {
  const map = parseMap(loadJson('data/maps/training.json'), balance);
  assert.equal(map.width, 12);
  assert.equal(map.height, 12);
  assert.equal(map.units.filter((u) => u.side === 'BLUFOR' && (u.kind ?? 'team') === 'team').length, 2);
  assert.equal(map.units.filter((u) => u.kind === 'leader').length, 1, 'and the SL');
  const opfor = map.units.find((u) => u.side === 'OPFOR');
  assert.equal(terrainName(map, H(...opfor.pos)), 'trench');
});

test('terrain lookups come from the balance table', () => {
  const map = makeMap(['.T~n']);
  assert.equal(terrainName(map, H(1, 0)), 'woods');
  assert.equal(terrainOf(map, balance, H(1, 0)).blocksLos, true);
  assert.equal(terrainOf(map, balance, H(2, 0)).move, 'impassable');
  assert.equal(terrainOf(map, balance, H(3, 0)).casualtyOn, balance.terrain.trench.casualtyOn);
});

test('bad maps are rejected with a clear error', () => {
  const base = { width: 2, height: 1, legend: LEGEND };
  assert.throws(() => parseMap({ ...base, rows: ['...'] }, balance), /Row 0 has 3 hexes/);
  assert.throws(() => parseMap({ ...base, rows: ['.?'] }, balance), /Unknown hex '\?'/);
  assert.throws(() => parseMap({ ...base, legend: { '.': 'lava' }, rows: ['..'] }, balance), /unknown terrain 'lava'/);
  assert.throws(() => parseMap({ ...base, rows: ['.~'], units: [{ side: 'BLUFOR', team: 'A', pos: [1, 0] }] }, balance), /impassable/);
  assert.throws(() => parseMap({ ...base, rows: ['..'], units: [{ side: 'B', team: 'A', pos: [0, 0] }, { side: 'B', team: 'C', pos: [0, 0] }] }, balance), /Two units/);
});
