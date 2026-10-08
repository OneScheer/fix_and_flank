// Hex milestone 6 acceptance: the AI fires from its positions, waits when
// pinned, and sometimes counterattacks. Same information as the player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOrders, planOrders } from '../src/ai/basic.js';
import { validateAction } from '../src/sim/actions.js';
import { fireSolution } from '../src/sim/combat.js';
import { distance, neighbors } from '../src/sim/hex.js';
import { commitOrders, projectOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { knownEnemies } from '../src/sim/spotting.js';
import { H, balance, makeState, open, toPhase, trainingState, unit } from './helpers.js';

const commit = (s, actions) => commitOrders(s, actions, createRng(s.rngState));
const modeOf = (s, id) => planOrders(s, 'OPFOR').find((x) => x.unit === id);

// OPFOR ALPHA (0) dug in at 3,2 behind parapets facing south; BLUFOR ALPHA (1) at `at`.
const ROWS = ['..........', '..........', '...n......', '..........', '..........', '..........', '..........', '..........', '..........', '..........', '..........'];
const PARAPETS = [{ hex: [3, 2], sides: ['SW', 'SE'], feature: 'parapet' }];
function dugIn(at, { rows = ROWS, blufor = {}, seed = 1 } = {}) {
  const s = makeState(rows, [unit('OPFOR', 'ALPHA', 3, 2), unit('BLUFOR', 'ALPHA', at[0], at[1], blufor)], seed, PARAPETS);
  return toPhase(s, 'enemy action');
}

test('the AI fires from its position on a spotted team in range', () => {
  const s = dugIn([3, 6]);
  assert.equal(distance(H(3, 2), H(3, 6)), 4);
  const p = modeOf(s, 0);
  assert.equal(p.mode, 'ENGAGED');
  assert.deepEqual(p.action, { type: 'fire', unit: 0, target: H(3, 6) });
  assert.deepEqual(s.units[0].pos, H(3, 2), 'it stays in the trench');
  const r = commit(s, chooseOrders(s, 'OPFOR'));
  assert.ok(r.events.some((e) => e.type === 'fire' && e.unit === 0));
});

test('it holds fire beyond openFireRange, and stays hidden', () => {
  const s = dugIn([3, 10]);
  assert.ok(distance(H(3, 2), H(3, 10)) > balance.ai.openFireRange);
  assert.equal(modeOf(s, 0).mode, 'HOLD');
  assert.deepEqual(chooseOrders(s, 'OPFOR'), []);
});

test('no cheating: a BLUFOR team it has not spotted is not fired on', () => {
  const rows = ROWS.map((r, i) => (i === 6 ? '...T......' : r));
  const s = dugIn([3, 6], { rows });
  assert.equal(knownEnemies(s, 'OPFOR').length, 0, 'in the woods at 4 hexes: unseen');
  assert.ok(fireSolution(s, s.units[0], H(3, 6)).ok, 'a shot would be possible');
  assert.deepEqual(chooseOrders(s, 'OPFOR'), []);
});

test('it waits when pinned: the phase goes to recovering, no order', () => {
  const s0 = makeState(ROWS, [unit('OPFOR', 'ALPHA', 3, 2), unit('BLUFOR', 'ALPHA', 3, 6)], 1, PARAPETS);
  s0.units[0].status = 'pinned';
  const s = toPhase(s0, 'firefight');
  s.units[0].status = 'pinned';
  const r = commit(s, []); // BLUFOR holds fire; rally; enemy action starts
  assert.equal(r.state.units[0].status, 'suppressed');
  assert.ok(r.events.some((e) => e.type === 'recover' && e.unit === 0));
  assert.equal(r.state.balance.turn.phases[r.state.phase].name, 'movement', 'nothing left for OPFOR to do');
  // And planning for a pinned unit in its phase gives no order.
  const t = dugIn([3, 6]);
  t.units[0].status = 'pinned';
  assert.equal(modeOf(t, 0).mode, 'SUPPRESSED');
  assert.deepEqual(chooseOrders(t, 'OPFOR'), []);
});

test('it assaults a pinned team that has come next to it', () => {
  const s = dugIn([3, 3]);
  s.units[1].status = 'pinned';
  const p = modeOf(s, 0);
  assert.equal(p.mode, 'COUNTER_FLANK');
  assert.deepEqual(p.action, { type: 'move', unit: 0, to: H(3, 3) });
  const r = commit(s, chooseOrders(s, 'OPFOR'));
  assert.ok(r.events.some((e) => e.type === 'assault' && e.unit === 0));
});

test('...but not a fresh team next to it: it holds the trench', () => {
  const s = dugIn([3, 3]);
  assert.notEqual(modeOf(s, 0).mode, 'COUNTER_FLANK');
});

test('it sometimes counterattacks a weakened team close by', () => {
  let counter = 0;
  let fired = 0;
  const n = 300;
  for (let seed = 1; seed <= n; seed++) {
    const s = dugIn([3, 5]);
    s.rngState = seed;
    s.units[1].status = 'suppressed';
    const p = modeOf(s, 0);
    if (p.mode === 'COUNTER_FLANK') {
      counter++;
      assert.equal(p.action.type, 'move');
      assert.ok(distance(p.action.to, H(3, 5)) < distance(H(3, 2), H(3, 5)), 'toward the enemy');
    } else if (p.mode === 'ENGAGED') fired++;
  }
  const f = counter / n;
  assert.ok(Math.abs(f - balance.ai.counterattackChance) < 0.08, `counterattacked ${counter}/${n}`);
  assert.equal(counter + fired, n, 'otherwise it fires');
});

test('a team down to its last man falls back', () => {
  const s = dugIn([3, 6]);
  s.units[0].soldiers = ['AR'];
  const p = modeOf(s, 0);
  assert.equal(p.mode, 'RETREAT');
  assert.ok(distance(p.action.to, H(3, 6)) > distance(H(3, 2), H(3, 6)));
});

test('caught in the open, it moves into cover', () => {
  // OPFOR in the open at 3,2 with woods at 3,1 behind it; BLUFOR spotted far off.
  const rows = ROWS.map((r, i) => (i === 1 ? '...T......' : i === 2 ? '..........' : r));
  const s = toPhase(makeState(rows, [unit('OPFOR', 'ALPHA', 3, 2), unit('BLUFOR', 'ALPHA', 3, 10)], 1), 'enemy action');
  assert.equal(knownEnemies(s, 'OPFOR')[0].level, 'spotted');
  const p = modeOf(s, 0);
  assert.equal(p.mode, 'REPOSITION');
  assert.deepEqual(p.action.to, H(3, 1));
});

// A scripted BLUFOR for whole games: every team moves one hex north if it
// can (movement), and fires at the nearest spotted enemy (firefight).
function scriptedBlufor(s) {
  const name = s.balance.turn.phases[s.phase].name;
  const orders = [];
  for (const u of s.units.filter((x) => x.side === 'BLUFOR' && x.status !== 'eliminated')) {
    const p = projectOrders(s, orders); // each order checked against the ones before it, as the UI does
    if (name === 'movement') {
      const to = neighbors(u.pos).filter((h) => h.row < u.pos.row).find((h) => validateAction(p, { type: 'move', unit: u.id, to: h }).ok);
      if (to) orders.push({ type: 'move', unit: u.id, to });
    } else {
      const c = knownEnemies(s, 'BLUFOR').find((k) => k.level === 'spotted' && validateAction(p, { type: 'fire', unit: u.id, target: k.pos }).ok);
      if (c) orders.push({ type: 'fire', unit: u.id, target: c.pos });
    }
  }
  return orders;
}

function playGame(seed, turns = 10) {
  let s = trainingState(seed);
  const events = [];
  while (s.turn <= turns && s.activeSide) {
    const orders = s.activeSide === 'OPFOR' ? chooseOrders(s, 'OPFOR') : scriptedBlufor(s);
    const r = commit(s, orders);
    for (const e of r.events) events.push({ ...e, side: e.unit !== undefined ? s.units[e.unit].side : e.side });
    s = r.state;
  }
  return { s, events };
}

test('over whole games the AI only gives valid orders, and fires from its trench', () => {
  let opforFire = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { events } = playGame(seed);
    assert.ok(!events.some((e) => e.type === 'rejected'), `seed ${seed}: ${JSON.stringify(events.find((e) => e.type === 'rejected'))}`);
    opforFire += events.filter((e) => (e.type === 'fire' || e.type === 'assault') && e.side === 'OPFOR').length;
  }
  assert.ok(opforFire > 20, `OPFOR fired ${opforFire} times in 20 games`);
});

test('the AI is deterministic', () => {
  const a = playGame(4, 6);
  const b = playGame(4, 6);
  assert.deepEqual(a.s.units, b.s.units);
  assert.deepEqual(a.events, b.events);
});

// ---- split fire ----

// OPFOR ALPHA (0) dug in at 3,2; two BLUFOR teams spotted in the open, not next to it.
function twoThreats(extra = []) {
  return toPhase(makeState(ROWS, [
    unit('OPFOR', 'ALPHA', 3, 2), unit('BLUFOR', 'ALPHA', 2, 6), unit('BLUFOR', 'BRAVO', 5, 5), ...extra,
  ], 1, PARAPETS), 'enemy action');
}

test('facing two spotted teams, the AI splits its fire between them', () => {
  const s = twoThreats();
  const p = modeOf(s, 0);
  assert.equal(p.mode, 'ENGAGED');
  assert.ok(p.action.second, JSON.stringify(p));
  const targets = [p.action.target, p.action.second].map((h) => `${h.col},${h.row}`).sort();
  assert.deepEqual(targets, ['2,6', '5,5']);
  const r = commit(s, chooseOrders(s, 'OPFOR'));
  const fires = r.events.filter((e) => e.type === 'fire' && e.unit === 0);
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map((e) => e.dice.length), [3, 2], 'five dice split three and two');
});

test('...but not with an enemy next to it: then it fires at one target only', () => {
  const s = twoThreats([unit('BLUFOR', 'CHARLIE', 3, 3)]);
  s.units[3].status = 'suppressed'; // next to the trench, not worth assaulting
  const p = modeOf(s, 0);
  assert.ok(!p.action?.second, JSON.stringify(p));
});
