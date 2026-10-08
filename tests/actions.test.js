// Hex milestone 2 acceptance: the turn sequence (phases), and deterministic
// replay of an action list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, moveOptions, validateAction } from '../src/sim/actions.js';
import { chanceAtLeast } from '../src/sim/dice.js';
import { key } from '../src/sim/hex.js';
import { commitOrders } from '../src/sim/orders.js';
import { rallyNeed } from '../src/sim/phases.js';
import { createRng } from '../src/sim/rng.js';
import { canActivate } from '../src/sim/state.js';
import { H, balance, makeState, open, toPhase, trainingState, unit } from './helpers.js';

const act = (state, action) => applyAction(state, action, createRng(state.rngState));
const commit = (s, actions = []) => commitOrders(s, actions, createRng(s.rngState));
const pass = (id) => ({ type: 'pass', unit: id });
const move = (id, col, row) => ({ type: 'move', unit: id, to: H(col, row) });
const phaseName = (s) => s.balance.turn.phases[s.phase].name;
const waiting = (s) => s.units.filter((u) => canActivate(s, u)).map((u) => u.id);

// BLUFOR ALPHA (0), BRAVO (1), CHARLIE (2); OPFOR ALPHA (3).
function threeVsOne() {
  return makeState(open(10, 10), [
    unit('BLUFOR', 'ALPHA', 2, 8), unit('BLUFOR', 'BRAVO', 4, 8), unit('BLUFOR', 'CHARLIE', 6, 8),
    unit('OPFOR', 'ALPHA', 4, 1),
  ]);
}

// ---- the turn sequence ----

test('a turn starts with BLUFOR\'s movement phase', () => {
  const s = threeVsOne();
  assert.equal(s.turn, 1);
  assert.equal(phaseName(s), 'movement');
  assert.equal(s.activeSide, 'BLUFOR');
  assert.deepEqual(waiting(s), [0, 1, 2]);
});

test('phases run movement, firefight, rally, enemy action; then a new turn', () => {
  let s = threeVsOne();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    seen.push(`${phaseName(s)}:${s.activeSide}`);
    const r = commit(s);
    s = r.state;
  }
  assert.deepEqual(seen, ['movement:BLUFOR', 'firefight:BLUFOR', 'enemy action:OPFOR'], 'the rally phase needs no orders');
  assert.equal(s.turn, 2);
  assert.equal(phaseName(s), 'movement');
  assert.ok(s.units.every((u) => !u.activated));
});

test('the phase changes come as events, rally included', () => {
  let s = toPhase(threeVsOne(), 'firefight');
  const r = commit(s);
  assert.deepEqual(r.events.filter((e) => e.type === 'phase_start').map((e) => e.name), ['rally', 'enemy action']);
  const t = commit(r.state);
  assert.deepEqual(t.events.filter((e) => !['activated', 'spotted', 'lost'].includes(e.type)).map((e) => e.type), ['turn_end', 'turn_start', 'phase_start']);
});

test('a unit that moves is spent: it does not act in the firefight phase', () => {
  const s = commit(threeVsOne(), [move(0, 2, 7), { type: 'fastMove', unit: 1, path: [H(4, 7), H(4, 6)] }]).state;
  assert.equal(phaseName(s), 'firefight');
  assert.deepEqual(waiting(s), [2], 'only CHARLIE, who held, can fire');
});

test('a phase nobody can act in is skipped', () => {
  const r = commit(threeVsOne(), [move(0, 2, 7), move(1, 4, 7), move(2, 6, 7)]);
  const ff = r.events.find((e) => e.type === 'phase_start' && e.name === 'firefight');
  assert.equal(ff.idle, true);
  assert.equal(phaseName(r.state), 'enemy action');
});

test('out of phase actions and second activations are rejected and change nothing', () => {
  const s = threeVsOne();
  let r = act(s, pass(3));
  assert.equal(r.events[0].type, 'rejected');
  assert.match(r.events[0].reason, /movement phase \(BLUFOR\)/);
  assert.equal(r.state, s, 'state unchanged');
  r = act(act(s, pass(0)).state, pass(0));
  assert.match(r.events[0].reason, /already acted in this phase/);
  const ff = toPhase(s, 'firefight');
  assert.match(validateAction(ff, move(0, 2, 7)).reason, /no moving in the firefight phase/);
});

test('eliminated units are skipped; a side with nobody left loses its phases', () => {
  const s = threeVsOne();
  s.units[3].status = 'eliminated';
  const r = commit(toPhase(s, 'firefight'));
  assert.equal(r.state.turn, 2, 'OPFOR has nobody: straight to the next turn');
  assert.equal(phaseName(r.state), 'movement');
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

test('pinned teams cannot move: they have nothing to do in the movement phase', () => {
  const s = threeVsOne();
  s.units[0].status = 'pinned';
  assert.match(validateAction(s, move(0, 2, 7)).reason, /pinned/);
  assert.deepEqual(moveOptions(s, s.units[0]).moves, []);
  assert.deepEqual(waiting(s), [1, 2]);
});

test('if no unit of the side can act, committing still moves the game on', () => {
  const s = threeVsOne();
  for (const id of [0, 1, 2]) s.units[id].status = 'pinned';
  const r = commit(s);
  assert.equal(phaseName(r.state), 'enemy action', 'pinned: no movement, no firefight; rally rolled');
});

test('moving into an enemy hex is not allowed yet (assault comes later)', () => {
  const s = makeState(open(4, 4), [unit('BLUFOR', 'ALPHA', 1, 1), unit('OPFOR', 'ALPHA', 2, 1)]);
  assert.match(validateAction(s, move(0, 2, 1)).reason, /enemy in that hex/);
});

// ---- fast move ----

test('fast move: two hexes, exposed through the enemy action, cleared when its side\'s next turn starts', () => {
  let s = makeState(open(6, 6), [unit('BLUFOR', 'ALPHA', 2, 5), unit('OPFOR', 'ALPHA', 2, 0)]);
  s = commit(s, [{ type: 'fastMove', unit: 0, path: [H(2, 4), H(2, 3)] }]).state;
  assert.deepEqual(s.units[0].pos, H(2, 3));
  assert.equal(phaseName(s), 'enemy action');
  assert.equal(s.units[0].exposed, true, 'still exposed while the enemy acts');
  s = commit(s).state;
  assert.equal(phaseName(s), 'movement');
  assert.equal(s.units[0].exposed, false);
  assert.equal(s.units[0].moved, false, 'and free to fire again');
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

test('replaying the same orders gives the same states and events', () => {
  // Training map ids: BLUFOR ALPHA 0, BRAVO 1, OPFOR ALPHA 2, BLUFOR SL 3.
  const plans = [
    // Everyone moves, so the firefight phase is skipped: movement, then enemy action.
    [{ type: 'fastMove', unit: 0, path: [H(4, 10), H(4, 9)] }, move(1, 6, 10), move(3, 5, 10)],
    [],
    [{ type: 'fastMove', unit: 0, path: [H(4, 8), H(4, 7)] }, move(1, 6, 9), { type: 'fastMove', unit: 3, path: [H(5, 9), H(5, 8)] }],
    [],
  ];
  const play = (seed) => {
    let s = trainingState(seed);
    const log = [];
    for (const p of plans) {
      const r = commit(s, p);
      assert.ok(!r.events.some((e) => e.type === 'rejected'), JSON.stringify(r.events.find((e) => e.type === 'rejected')));
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, turn: s.turn, phase: s.phase, log };
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

// ---- suppressed, pinned, the squad leader, the rally phase ----

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

test('rally is not an order any more: it is the rally phase', () => {
  const s = squad();
  s.units[1].status = 'pinned';
  assert.match(validateAction(s, { type: 'rally', unit: 0, target: 1 }).reason, /unknown action/);
});

test('rally need: automatic with the SL, the roll must beat the distance to him, blocked next to an enemy', () => {
  const s = squad();
  assert.deepEqual(rallyNeed(s, s.units[0]), { auto: true, leader: 0, distance: 0 }, 'the SL rallies himself');
  assert.deepEqual(rallyNeed(s, s.units[1]), { need: 2, leader: 0, distance: 1 });
  assert.deepEqual(rallyNeed(s, s.units[2]), { need: 3, leader: 0, distance: 2 });
  s.units[0].pos = H(3, 5);
  assert.equal(rallyNeed(s, s.units[1]).auto, true, 'SL in its hex');
  s.units[3].pos = H(4, 6); // OPFOR next to BRAVO
  assert.deepEqual(rallyNeed(s, s.units[2]), { blocked: true });
  s.units[0].pos = H(5, 6);
  assert.equal(rallyNeed(s, s.units[2]).auto, true, 'unless the SL is with it');
  s.units[0].pos = H(0, 0);
  s.units[3].pos = H(7, 0);
  assert.equal(rallyNeed(s, s.units[2]).need, balance.rally.worstOn, 'far from the SL: never worse than worstOn');
  s.units[0].status = 'eliminated';
  assert.deepEqual(rallyNeed(s, s.units[1]), { need: balance.rally.worstOn, leader: null, distance: null }, 'no SL');
});

test('the rally phase rolls for every suppressed or pinned BLUFOR unit, one step on success', () => {
  let hits = 0;
  const n = 600;
  for (let seed = 1; seed <= n; seed++) {
    const s = squad();
    s.rngState = seed;
    s.units[1].status = 'pinned';      // 1 hex from the SL: needs 2+
    s.units[3].status = 'suppressed';  // OPFOR does not rally in BLUFOR's phase
    const r = commit(toPhase(s, 'firefight'));
    const rallies = r.events.filter((e) => e.type === 'rally');
    assert.deepEqual(rallies.map((e) => e.unit), [1]);
    const e = rallies[0];
    assert.equal(e.need, 2);
    assert.equal(e.success, e.roll >= e.need);
    assert.equal(r.state.units[1].status, e.success ? 'suppressed' : 'pinned');
    if (e.success) hits++;
  }
  const expected = chanceAtLeast(2);
  assert.ok(Math.abs(hits / n - expected) < 0.06, `rallied ${hits}/${n}, expected about ${expected}`);
});

test('with the SL in its hex a team rallies without a roll', () => {
  const s = squad();
  s.units[0].pos = H(3, 5);
  s.units[1].status = 'pinned';
  const r = commit(toPhase(s, 'firefight'));
  const e = r.events.find((x) => x.type === 'rally');
  assert.equal(e.auto, true);
  assert.equal(e.roll, null);
  assert.equal(r.state.units[1].status, 'suppressed');
});

test('enemy action: a suppressed or pinned enemy recovers a step and does nothing else', () => {
  const s = squad();
  s.units[3].status = 'pinned';
  let r = commit(toPhase(s, 'firefight'));
  assert.equal(r.state.units[3].status, 'suppressed');
  assert.ok(r.events.some((e) => e.type === 'recover' && e.unit === 3 && e.from === 'pinned'));
  assert.equal(phaseName(r.state), 'movement', 'nothing left to do in the enemy action phase');
  const t = squad();
  t.units[3].status = 'suppressed';
  r = commit(toPhase(t, 'firefight'));
  assert.equal(r.state.units[3].status, 'ok');
});

test('the phases replay identically from the same seed', () => {
  const play = () => {
    let s = squad();
    s.units[1].status = 'pinned';
    s.units[2].status = 'suppressed';
    s.units[3].status = 'pinned';
    const log = [];
    for (let i = 0; i < 6; i++) {
      const r = commit(s);
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, rng: s.rngState, log };
  };
  assert.deepEqual(play(), play());
});
