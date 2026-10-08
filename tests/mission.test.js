// Mission end conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, validateAction } from '../src/sim/actions.js';
import { commitOrders } from '../src/sim/orders.js';
import { parseMap } from '../src/sim/map.js';
import { createRng } from '../src/sim/rng.js';
import { createState } from '../src/sim/state.js';
import { H, LEGEND, balance, loadJson, open, toPhase, unit } from './helpers.js';

const MISSION = { attacker: 'BLUFOR', defender: 'OPFOR', turns: 3 };
function missionState(units, { rows = open(6, 6), objective = [3, 1], mission = MISSION } = {}) {
  const map = parseMap({ width: rows[0].length, height: rows.length, legend: LEGEND, rows, units, objective, mission }, balance);
  return createState({ balance, map, seed: 1 });
}
const commit = (s, a = []) => commitOrders(s, a, createRng(s.rngState));

test('holding the objective with a fireteam at the end of a turn wins', () => {
  let s = missionState([unit('BLUFOR', 'ALPHA', 3, 2), unit('OPFOR', 'ALPHA', 0, 5)]);
  s = commit(s, [{ type: 'move', unit: 0, to: H(3, 1) }]).state;
  assert.equal(s.result, null, 'not before the turn ends');
  const r = commit(s);
  assert.deepEqual(r.state.result, { winner: 'BLUFOR', why: 'BLUFOR ALPHA holds the objective' });
  assert.ok(r.events.some((e) => e.type === 'game_over' && e.winner === 'BLUFOR'));
  assert.equal(r.state.activeSide, null);
});

test('the SL alone does not hold the objective', () => {
  let s = missionState([unit('BLUFOR', 'ALPHA', 0, 5), unit('BLUFOR', 'SL', 3, 1, { kind: 'leader' }), unit('OPFOR', 'ALPHA', 5, 5)]);
  for (let i = 0; i < 20 && !s.result; i++) s = commit(s).state;
  assert.equal(s.result.winner, 'OPFOR', 'the turns ran out with only the SL on it');
});

test('the defender wins when the last turn ends without the objective taken', () => {
  let s = missionState([unit('BLUFOR', 'ALPHA', 0, 5), unit('OPFOR', 'ALPHA', 5, 5)]);
  for (let i = 0; i < 20 && !s.result; i++) s = commit(s).state;
  assert.deepEqual(s.result, { winner: 'OPFOR', why: 'BLUFOR did not take the objective in 3 turns' });
  assert.equal(s.turn, 3);
});

test('eliminating every enemy fireteam ends it at once; nothing more can be ordered', () => {
  const s = missionState([unit('BLUFOR', 'ALPHA', 2, 2), unit('OPFOR', 'ALPHA', 3, 2)]);
  s.units[1].status = 'pinned';
  s.units[1].soldiers = ['AR'];
  for (let seed = 1; seed <= 20; seed++) {
    const r = applyAction(s, { type: 'move', unit: 0, to: H(3, 2) }, createRng(seed));
    if (r.state.units[1].status !== 'eliminated') continue;
    assert.deepEqual(r.state.result, { winner: 'BLUFOR', why: 'all OPFOR fireteams eliminated' });
    assert.match(validateAction(r.state, { type: 'pass', unit: 0 }).reason, /mission is over/);
    assert.deepEqual(commit(r.state).events, [], 'committing after the end does nothing');
    return;
  }
  assert.fail('never eliminated');
});

test('losing every fireteam loses, even with the SL alive', () => {
  const s = toPhase(missionState([unit('BLUFOR', 'ALPHA', 3, 3), unit('BLUFOR', 'SL', 0, 5, { kind: 'leader' }), unit('OPFOR', 'ALPHA', 3, 2)]), 'enemy action');
  s.units[0].status = 'pinned';
  s.units[0].soldiers = ['AR'];
  for (let seed = 1; seed <= 20; seed++) {
    const r = applyAction(s, { type: 'move', unit: 2, to: H(3, 3) }, createRng(seed));
    if (r.state.units[0].status !== 'eliminated') continue;
    assert.equal(r.state.result.winner, 'OPFOR');
    return;
  }
  assert.fail('never eliminated');
});

test('a map without a mission never ends', () => {
  let s = missionState([unit('BLUFOR', 'ALPHA', 0, 5), unit('OPFOR', 'ALPHA', 5, 5)], { mission: null });
  for (let i = 0; i < 30; i++) s = commit(s).state;
  assert.equal(s.result, null);
  assert.ok(s.turn > 10);
});

test('mission 1 loads with its mission and drills', () => {
  const json = loadJson('data/maps/trenchline.json');
  const map = parseMap(json, balance);
  assert.equal(map.mission.turns, 12);
  assert.deepEqual(map.objective, [6, 3]);
  const s = createState({ balance, map, seed: 1 });
  assert.equal(s.units.filter((u) => u.side === 'OPFOR').length, 1);
  assert.ok(json.drills.frontal && json.drills.fixAndFlank);
});
