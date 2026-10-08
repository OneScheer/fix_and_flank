import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, commitOrders, projectOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { H, makeState, open, trainingState, unit } from './helpers.js';

const commit = (s, actions) => commitOrders(s, actions, createRng(s.rngState));
const move = (id, col, row) => ({ type: 'move', unit: id, to: H(col, row) });

// BLUFOR ALPHA (0), BRAVO (1), SL (2); OPFOR ALPHA (3).
function squad() {
  return makeState(open(8, 8), [
    unit('BLUFOR', 'ALPHA', 3, 6), unit('BLUFOR', 'BRAVO', 4, 6), unit('BLUFOR', 'SL', 3, 7, { kind: 'leader' }),
    unit('OPFOR', 'ALPHA', 3, 0),
  ]);
}

test('a side orders all its units at once; the orders run in the order given, then the other side acts', () => {
  const s = squad();
  const r = commit(s, [move(1, 4, 5), move(0, 3, 5)]);
  const moved = r.events.filter((e) => e.type === 'moved').map((e) => e.unit);
  assert.deepEqual(moved, [1, 0], 'BRAVO first, as ordered');
  assert.deepEqual(r.state.units[0].pos, H(3, 5));
  assert.deepEqual(r.state.units[1].pos, H(4, 5));
  assert.equal(r.state.activeSide, 'OPFOR');
  assert.equal(r.events.find((e) => e.type === 'side_start').side, 'OPFOR');
});

test('units without an order hold', () => {
  const s = squad();
  const r = commit(s, [move(0, 3, 5)]);
  const passes = r.events.filter((e) => e.type === 'activated' && e.action === 'pass').map((e) => e.unit);
  assert.deepEqual(passes, [1, 2]);
  assert.deepEqual(r.state.units[1].pos, s.units[1].pos);
});

test('then OPFOR commits, and the turn ends', () => {
  let s = commit(squad(), []).state;
  const r = commit(s, []);
  assert.ok(r.events.some((e) => e.type === 'turn_end'));
  assert.equal(r.state.turn, 2);
  assert.equal(r.state.activeSide, 'BLUFOR');
});

test('planning: a unit can move into a hex another unit leaves earlier in the plan', () => {
  const s = squad();
  // ALPHA steps up; the SL and then BRAVO take its old hex (a team may share with the SL).
  const plan = [move(0, 3, 5), move(2, 3, 6), move(1, 3, 6)];
  assert.ok(checkPlan(s, plan).every((c) => c.ok), JSON.stringify(checkPlan(s, plan)));
  const p = projectOrders(s, plan);
  assert.deepEqual(p.units[1].pos, H(3, 6));
  const r = commit(s, plan);
  assert.equal(r.events.filter((e) => e.type === 'rejected').length, 0);
  assert.deepEqual(r.state.units[1].pos, H(3, 6));
});

test('planning flags orders that clash with earlier ones', () => {
  const s = squad();
  const plan = [move(0, 3, 5), move(1, 3, 5)];
  const c = checkPlan(s, plan);
  assert.equal(c[0].ok, true);
  assert.match(c[1].reason, /friendly team/);
});

test('an order that has become impossible is skipped with the reason, and that unit holds', () => {
  const s = squad();
  const r = commit(s, [move(0, 3, 5), move(1, 3, 5)]);
  const rej = r.events.find((e) => e.type === 'rejected');
  assert.match(rej.reason, /friendly team/);
  assert.deepEqual(r.state.units[1].pos, s.units[1].pos);
  assert.equal(r.state.units[1].activated, true, 'it held instead');
  assert.equal(r.state.activeSide, 'OPFOR');
});

test('committing the same plan from the same seed gives the same result', () => {
  const play = () => {
    let s = trainingState(3);
    const log = [];
    for (const plan of [[move(0, 4, 10), move(3, 5, 10)], [], [move(0, 4, 9), move(1, 6, 10)], []]) {
      const r = commit(s, plan);
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, turn: s.turn, log };
  };
  assert.deepEqual(play(), play());
  assert.equal(play().turn, 3);
});
