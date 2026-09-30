import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurn, step } from '../src/sim/step.js';
import { createRng } from '../src/sim/rng.js';
import { grass, makeState, trainingState } from './helpers.js';

const unit = (side, team, role, x, y) => ({ side, team, role, pos: [x, y] });
const move = (side, team, x, y, speed = 'walk') => ({ type: 'move', side, team, dest: { x, y }, speed });

function tilesPerTurn(s, speed) {
  return (s.balance.movement.speedMps[speed] / s.balance.map.tileMeters) * s.balance.turn.durationSec;
}

test('a turn is ticksPerTurn steps and advances the turn counter', () => {
  const s = makeState(grass(5, 5));
  const { state, events } = resolveTurn(s, []);
  assert.equal(state.turn, 1);
  assert.equal(state.tick, 0);
  assert.deepEqual(events, []);
});

test('resolveTurn does not change its input', () => {
  const s = makeState(grass(40, 3), [unit('BLUFOR', 'ALPHA', 'TL', 0, 1)]);
  const before = structuredClone({ ...s, map: null, balance: null });
  resolveTurn(s, [move('BLUFOR', 'ALPHA', 30, 1)]);
  assert.deepEqual({ ...s, map: null, balance: null }, before);
});

for (const speed of ['walk', 'run', 'crawl']) {
  test(`${speed} covers the expected distance in one turn on grass`, () => {
    const s = makeState(grass(60, 3), [unit('BLUFOR', 'ALPHA', 'TL', 0, 1)]);
    const { state } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 59, 1, speed)]);
    assert.equal(state.soldiers[0].pos.x, Math.floor(tilesPerTurn(s, speed)));
  });
}

test('move orders continue across turns until arrival', () => {
  const s = makeState(grass(30, 3), [unit('BLUFOR', 'ALPHA', 'TL', 0, 1)]);
  let r = resolveTurn(s, [move('BLUFOR', 'ALPHA', 12, 1, 'walk')]);
  assert.ok(r.state.soldiers[0].move, 'still moving after turn 1');
  r = resolveTurn(r.state, []);
  assert.deepEqual(r.state.soldiers[0].pos, { x: 12, y: 1 });
  assert.equal(r.state.soldiers[0].move, null);
  assert.ok(r.events.some((e) => e.type === 'arrived' && e.id === 0));
});

test('both sides move in the same turn', () => {
  const s = makeState(grass(20, 20), [unit('BLUFOR', 'ALPHA', 'TL', 0, 19), unit('OPFOR', 'ALPHA', 'TL', 19, 0)]);
  const { state } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 0, 0, 'run'), move('OPFOR', 'ALPHA', 19, 19, 'run')]);
  assert.ok(state.soldiers[0].pos.y < 19);
  assert.ok(state.soldiers[1].pos.y > 0);
});

test('soldiers never share a tile; a blocked soldier waits and reports why', () => {
  // Corridor one tile wide: two soldiers walk into each other head on.
  const rows = ['##########', '..........', '##########'];
  const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 0, 1), unit('OPFOR', 'ALPHA', 'TL', 9, 1)]);
  let state = s;
  const rng = createRng(1);
  const orders = [move('BLUFOR', 'ALPHA', 9, 1, 'run'), move('OPFOR', 'ALPHA', 0, 1, 'run')];
  const events = [];
  for (let t = 0; t < 20; t++) {
    const r = step(state, t === 0 ? orders : [], rng);
    state = r.state;
    events.push(...r.events);
    const [a, b] = state.soldiers;
    assert.ok(a.pos.x !== b.pos.x || a.pos.y !== b.pos.y, `shared tile at tick ${t}`);
  }
  assert.equal(events.filter((e) => e.type === 'blocked').length, 2, 'one blocked event each, not one per tick');
});

test('a follower can step into a tile vacated in the same tick', () => {
  const s = makeState(grass(20, 1), [unit('BLUFOR', 'ALPHA', 'TL', 1, 0), unit('BLUFOR', 'ALPHA', 'RFL', 0, 0)]);
  const { state, events } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 15, 0, 'run')]);
  assert.equal(events.filter((e) => e.type === 'blocked').length, 0);
  assert.equal(state.soldiers[1].pos.x, state.soldiers[0].pos.x - 1);
});

test('a follower is not held up when the soldier ahead has a higher id', () => {
  // TL (id 0) is behind RFL (id 1); single-pass id order would block TL every step.
  const s = makeState(grass(20, 1), [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('BLUFOR', 'ALPHA', 'RFL', 1, 0)]);
  const { state, events } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 14, 0, 'run')]);
  assert.equal(events.filter((e) => e.type === 'blocked').length, 0);
  assert.equal(state.soldiers[0].pos.x, state.soldiers[1].pos.x - 1);
});

test('events carry turn and tick', () => {
  const s = makeState(grass(10, 1), [unit('BLUFOR', 'ALPHA', 'TL', 0, 0)]);
  const { events } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 9, 0, 'run')]);
  const moved = events.filter((e) => e.type === 'moved');
  assert.ok(moved.length > 0);
  assert.ok(moved.every((e) => e.turn === 0 && Number.isInteger(e.tick) && e.tick < s.ticksPerTurn));
});

// Milestone 2 acceptance: deterministic replay of the same orders.
test('replaying the same orders on the training map gives identical states and events', () => {
  const plan = [
    [move('BLUFOR', 'ALPHA', 37, 50, 'run'), move('BLUFOR', 'BRAVO', 62, 58, 'walk'), move('OPFOR', 'ALPHA', 40, 12, 'run')],
    [move('BLUFOR', 'BRAVO', 64, 30, 'crawl')],
    [],
    [move('BLUFOR', 'ALPHA', 40, 23, 'run'), { type: 'hold', side: 'BLUFOR', team: 'BRAVO' }],
    [],
  ];
  function play(seed) {
    let state = trainingState(seed);
    const log = [];
    for (const orders of plan) {
      const r = resolveTurn(state, orders);
      state = r.state;
      log.push(r.events);
    }
    return { soldiers: state.soldiers, turn: state.turn, rngState: state.rngState, log };
  }
  const a = play(1234);
  const b = play(1234);
  assert.deepEqual(a, b);
  assert.ok(a.log.flat().filter((e) => e.type === 'moved').length > 50, 'the plan actually moves soldiers');
});
