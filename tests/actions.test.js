// Hex milestone 2 acceptance: activation order rules, and deterministic
// replay of an action list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, moveOptions, rallyTargets, validateAction } from '../src/sim/actions.js';
import { chanceAtLeast } from '../src/sim/dice.js';
import { key } from '../src/sim/hex.js';
import { createRng } from '../src/sim/rng.js';
import { H, balance, makeState, open, trainingState, unit } from './helpers.js';

const act = (state, action) => applyAction(state, action, createRng(state.rngState));
const pass = (id) => ({ type: 'pass', unit: id });
const move = (id, col, row) => ({ type: 'move', unit: id, to: H(col, row) });

// BLUFOR ALPHA (0), BRAVO (1), CHARLIE (2); OPFOR ALPHA (3).
function threeVsOne() {
  return makeState(open(10, 10), [
    unit('BLUFOR', 'ALPHA', 2, 8), unit('BLUFOR', 'BRAVO', 4, 8), unit('BLUFOR', 'CHARLIE', 6, 8),
    unit('OPFOR', 'ALPHA', 4, 1),
  ]);
}

// ---- activation order ----

test('BLUFOR has the initiative: it acts first in turn 1', () => {
  const s = threeVsOne();
  assert.equal(s.turn, 1);
  assert.equal(s.activeSide, 'BLUFOR');
});

test('sides alternate; when one runs out, the other activates the rest in a row; then a new turn', () => {
  let s = threeVsOne();
  const order = [];
  for (const id of [0, 3, 1, 2]) {
    order.push(s.activeSide);
    s = act(s, pass(id)).state;
  }
  assert.deepEqual(order, ['BLUFOR', 'OPFOR', 'BLUFOR', 'BLUFOR']);
  assert.equal(s.turn, 2);
  assert.equal(s.activeSide, 'BLUFOR');
  assert.ok(s.units.every((u) => !u.activated));
});

test('the turn ends with events, and the new turn starts with the initiative side', () => {
  let s = makeState(open(5, 5), [unit('BLUFOR', 'ALPHA', 0, 4), unit('OPFOR', 'ALPHA', 4, 0)]);
  s = act(s, pass(0)).state;
  const r = act(s, pass(1));
  assert.deepEqual(r.events.map((e) => e.type), ['activated', 'turn_end', 'turn_start']);
  assert.equal(r.state.activeSide, 'BLUFOR');
});

test('out of turn and second activations are rejected and do not use up an activation', () => {
  const s = threeVsOne();
  let r = act(s, pass(3));
  assert.equal(r.events[0].type, 'rejected');
  assert.match(r.events[0].reason, /BLUFOR's activation/);
  assert.equal(r.state, s, 'state unchanged');
  r = act(act(s, pass(0)).state, pass(3));
  r = act(r.state, pass(0));
  assert.match(r.events[0].reason, /already acted/);
});

test('eliminated teams are skipped', () => {
  const s = threeVsOne();
  s.units[3].status = 'eliminated';
  const r = act(s, pass(0));
  assert.equal(r.state.activeSide, 'BLUFOR', 'OPFOR has nobody to activate');
});

// ---- move ----

test('move: one hex to an adjacent, enterable hex', () => {
  const s = makeState(['....', '.~..', '....'], [unit('BLUFOR', 'ALPHA', 1, 2), unit('BLUFOR', 'BRAVO', 2, 2), unit('OPFOR', 'ALPHA', 3, 0)]);
  const r = act(s, move(0, 0, 2));
  assert.deepEqual(r.state.units[0].pos, H(0, 2));
  assert.deepEqual(r.events.find((e) => e.type === 'moved').to, H(0, 2));
  assert.match(validateAction(s, move(0, 1, 1)).reason, /water is impassable/);
  assert.match(validateAction(s, move(0, 2, 2)).reason, /friendly team/);
  assert.match(validateAction(s, move(0, 3, 2)).reason, /is not next to/);
});

test('pinned teams cannot move but can pass', () => {
  const s = threeVsOne();
  s.units[0].status = 'pinned';
  assert.match(validateAction(s, move(0, 2, 7)).reason, /pinned/);
  assert.equal(validateAction(s, pass(0)).ok, true);
  assert.deepEqual(moveOptions(s, s.units[0]).moves, []);
});

test('moving into an enemy hex is not allowed yet (assault comes later)', () => {
  const s = makeState(open(4, 4), [unit('BLUFOR', 'ALPHA', 1, 1), unit('OPFOR', 'ALPHA', 2, 1)]);
  assert.match(validateAction(s, move(0, 2, 1)).reason, /enemy in that hex/);
});

// ---- fast move ----

test('fast move: two hexes, the team is exposed until its next activation', () => {
  let s = makeState(open(6, 6), [unit('BLUFOR', 'ALPHA', 2, 5), unit('OPFOR', 'ALPHA', 2, 0)]);
  s = act(s, { type: 'fastMove', unit: 0, path: [H(2, 4), H(2, 3)] }).state;
  assert.deepEqual(s.units[0].pos, H(2, 3));
  assert.equal(s.units[0].exposed, true);
  s = act(s, pass(1)).state; // OPFOR; turn ends
  assert.equal(s.units[0].exposed, true, 'still exposed through the enemy activations');
  s = act(s, pass(0)).state;
  assert.equal(s.units[0].exposed, false, 'cleared when it acts again');
});

test('fast move stops on entering rough terrain; no more than two hexes', () => {
  const s = makeState(['......', '..T...', '......', '......'], [unit('BLUFOR', 'ALPHA', 2, 3), unit('OPFOR', 'ALPHA', 5, 0)]);
  assert.match(validateAction(s, { type: 'fastMove', unit: 0, path: [H(2, 2), H(2, 1), H(2, 0)] }).reason, /at most 2 hexes/);
  // (2,2) -> woods at (2,1) as the last hex is fine
  assert.equal(validateAction(s, { type: 'fastMove', unit: 0, path: [H(2, 2), H(2, 1)] }).ok, true);
  const s2 = makeState(['......', '......', '..T...', '......'], [unit('BLUFOR', 'ALPHA', 2, 3), unit('OPFOR', 'ALPHA', 5, 0)]);
  assert.match(validateAction(s2, { type: 'fastMove', unit: 0, path: [H(2, 2), H(2, 1)] }).reason, /entering woods ends a fast move/);
});

test('move options: 6 neighbors for a move, more hexes for a fast move, rough terrain respected', () => {
  const s = makeState(['.......', '.......', '...T...', '.......', '.......'], [unit('BLUFOR', 'ALPHA', 3, 3), unit('OPFOR', 'ALPHA', 0, 0)]);
  const o = moveOptions(s, s.units[0]);
  assert.equal(o.moves.length, 6);
  assert.ok(o.fast.size > 6);
  for (const path of o.fast.values()) {
    assert.equal(validateAction(s, { type: 'fastMove', unit: 0, path }).ok, true, path.map(key).join(' '));
  }
  assert.ok(![...o.fast.values()].some((p) => p.length === 2 && key(p[0]) === '3,2'), 'nothing beyond the woods hex');
});

// ---- determinism ----

test('replaying the same action list gives the same states and events', () => {
  // Training map ids: BLUFOR ALPHA 0, BRAVO 1, OPFOR ALPHA 2, BLUFOR SL 3.
  const plan = [
    { type: 'fastMove', unit: 0, path: [H(4, 10), H(4, 9)] },
    pass(2),
    move(1, 6, 10),
    move(3, 5, 10),
    { type: 'fastMove', unit: 0, path: [H(4, 8), H(4, 7)] },
    pass(2),
    move(1, 6, 9),
    { type: 'fastMove', unit: 3, path: [H(5, 9), H(5, 8)] },
  ];
  const play = (seed) => {
    let s = trainingState(seed);
    const log = [];
    for (const a of plan) {
      const r = act(s, a);
      assert.notEqual(r.events[0].type, 'rejected', JSON.stringify(r.events[0]));
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, turn: s.turn, active: s.activeSide, log };
  };
  assert.deepEqual(play(7), play(7));
  assert.equal(play(7).turn, 3);
});

test('applyAction does not change its input', () => {
  const s = trainingState();
  const before = structuredClone(s.units);
  act(s, move(0, 4, 10));
  assert.deepEqual(s.units, before);
});

// ---- suppressed, pinned, the squad leader ----

// BLUFOR SL (0), ALPHA (1), BRAVO (2); OPFOR ALPHA (3).
function squad() {
  return makeState(open(8, 8), [
    unit('BLUFOR', 'SL', 3, 6, { kind: 'leader' }), unit('BLUFOR', 'ALPHA', 3, 5), unit('BLUFOR', 'BRAVO', 5, 6),
    unit('OPFOR', 'ALPHA', 3, 0),
  ]);
}

test('suppressed teams cannot move; pinned teams cannot either', () => {
  const s = squad();
  s.units[1].status = 'suppressed';
  assert.match(validateAction(s, move(1, 2, 5)).reason, /suppressed and cannot move/);
  s.units[1].status = 'pinned';
  assert.match(validateAction(s, move(1, 2, 5)).reason, /pinned and cannot move/);
});

test('the SL is one man and can share a hex with one fireteam; two teams cannot share', () => {
  const s = squad();
  assert.deepEqual(s.units[0].soldiers, ['SL']);
  assert.equal(s.units[0].kind, 'leader');
  assert.equal(validateAction(s, move(0, 3, 5)).ok, true, 'SL joins ALPHA');
  const t = act(s, move(0, 3, 5)).state;
  assert.deepEqual(t.units[0].pos, t.units[1].pos);
  const u = makeState(open(8, 8), [unit('BLUFOR', 'ALPHA', 3, 5), unit('BLUFOR', 'BRAVO', 4, 5), unit('OPFOR', 'ALPHA', 3, 0)]);
  assert.match(validateAction(u, move(1, 3, 5)).reason, /friendly team/);
});

test('rally: only the SL, only suppressed or pinned friends within range', () => {
  const s = squad();
  assert.match(validateAction(s, { type: 'rally', unit: 0, target: 1 }).reason, /not suppressed/);
  s.units[1].status = 'pinned';
  s.units[2].status = 'suppressed';
  assert.equal(validateAction(s, { type: 'rally', unit: 0, target: 1 }).ok, true);
  assert.match(validateAction(s, { type: 'rally', unit: 0, target: 2 }).reason, /more than 1 hex away/);
  assert.deepEqual(rallyTargets(s, s.units[0]).map((u) => u.id), [1]);
  s.units[0].status = 'pinned';
  assert.match(validateAction(s, { type: 'rally', unit: 0, target: 1 }).reason, /pinned and cannot rally/);
});

test('rally rolls a d6: on succeedOn or better the team improves one step, and uses the SL activation', () => {
  let ok = 0;
  const n = 600;
  for (let seed = 1; seed <= n; seed++) {
    const s = squad();
    s.rngState = seed;
    s.units[1].status = 'pinned';
    const r = act(s, { type: 'rally', unit: 0, target: 1 });
    const e = r.events.find((x) => x.type === 'rally');
    assert.equal(e.need, balance.rally.succeedOn);
    assert.equal(e.success, e.roll >= e.need);
    assert.equal(r.state.units[1].status, e.success ? 'suppressed' : 'pinned');
    assert.equal(r.state.units[0].activated, true);
    if (e.success) ok++;
  }
  const expected = chanceAtLeast(balance.rally.succeedOn);
  assert.ok(Math.abs(ok / n - expected) < 0.06, `rallied ${ok}/${n}, expected about ${expected}`);
});

test('at the start of a turn suppressed and pinned units roll to recover', () => {
  let s = makeState(open(5, 5), [unit('BLUFOR', 'ALPHA', 0, 4), unit('OPFOR', 'ALPHA', 4, 0)]);
  s.units[0].status = 'pinned';
  s.units[1].status = 'suppressed';
  s = act(s, pass(0)).state;
  const r = act(s, pass(1));
  const rolls = r.events.filter((e) => e.type === 'recover');
  assert.equal(rolls.length, 2);
  for (const e of rolls) {
    assert.equal(e.success, e.roll >= balance.status.recoverOn);
    assert.equal(r.state.units[e.unit].status, e.to);
  }
});

test('dice and rally replay identically from the same seed', () => {
  const play = () => {
    let s = squad();
    s.units[1].status = 'pinned';
    const log = [];
    for (const a of [{ type: 'rally', unit: 0, target: 1 }, pass(3), pass(1), pass(2)]) {
      const r = act(s, a);
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, rng: s.rngState, log };
  };
  assert.deepEqual(play(), play());
});
