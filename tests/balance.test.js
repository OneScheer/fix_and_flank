// Hex milestone 7 acceptance (automated): over 200 seeded runs of mission 1
// against the AI, a scripted frontal assault wins under 25 percent and a
// scripted fix-and-flank plan wins over 70 percent. When balance.json
// changes, this is the test to re-run (`npm run balance` prints the detail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOrders } from '../src/ai/basic.js';
import { fixAndFlank, frontalAssault, playOut } from '../src/ai/drills.js';
import { parseMap } from '../src/sim/map.js';
import { commitOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { createState } from '../src/sim/state.js';
import { balance, loadJson } from './helpers.js';

const RUNS = 200;
const json = loadJson('data/maps/trenchline.json');
const map = parseMap(json, balance);

export function winRate(makePlan, runs = RUNS, first = 1) {
  let wins = 0;
  for (let seed = first; seed < first + runs; seed++) {
    const end = playOut(createState({ balance, map, seed }), makePlan(json.drills), chooseOrders, commitOrders, createRng);
    assert.ok(end.result, `seed ${seed}: the mission ended`);
    if (end.result.winner === 'BLUFOR') wins++;
  }
  return wins / runs;
}

test(`a scripted frontal assault wins under 25% (${RUNS} seeds)`, () => {
  const rate = winRate(frontalAssault);
  assert.ok(rate < 0.25, `frontal assault won ${(rate * 100).toFixed(1)}%`);
});

test(`a scripted fix-and-flank plan wins over 70% (${RUNS} seeds)`, () => {
  const rate = winRate(fixAndFlank);
  assert.ok(rate > 0.7, `fix and flank won ${(rate * 100).toFixed(1)}%`);
});

test('the balance runs replay identically', () => {
  const end = (seed) => playOut(createState({ balance, map, seed }), fixAndFlank(json.drills), chooseOrders, commitOrders, createRng);
  assert.deepEqual(end(17).units, end(17).units);
  assert.deepEqual(end(17).result, end(17).result);
});
