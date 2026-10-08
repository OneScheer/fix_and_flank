// Hex milestone 5 acceptance: assault rules, and preview odds equal the
// exact odds the sim rolls against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, validateAction } from '../src/sim/actions.js';
import { assaultOutcome, assaultSolution, assaultVia } from '../src/sim/assault.js';
import { fireSolution, pinAt } from '../src/sim/combat.js';
import { assaultOdds, fireOdds } from '../src/sim/odds.js';
import { checkPlan, commitOrders, projectOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { previewAction } from '../src/ui/describe.js';
import { H, balance, makeState, open, toPhase, unit } from './helpers.js';

const act = (s, a, seed = s.rngState) => applyAction(s, a, createRng(seed));
const move = (id, col, row) => ({ type: 'move', unit: id, to: H(col, row) });
const fire = (id, col, row) => ({ type: 'fire', unit: id, target: H(col, row) });
const pct = (p) => `${Math.round(p * 100)}%`;

// OPFOR ALPHA (1) in a trench at 3,2 with parapets facing south; BLUFOR
// ALPHA (0) next to it at 3,3 (south), BLUFOR SL (2) at 3,5.
const ROWS = ['........', '........', '...n....', '........', '........', '........'];
const PARAPETS = [{ hex: [3, 2], sides: ['SW', 'SE'], feature: 'parapet' }];
function closeIn(status = 'ok', rows = ROWS) {
  const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 3, 3), unit('OPFOR', 'ALPHA', 3, 2), unit('BLUFOR', 'SL', 3, 5, { kind: 'leader' })], 1, rows === ROWS ? PARAPETS : []);
  s.units[1].status = status;
  return s;
}

// ---- rules ----

test('a move or fire order into the next hex with an enemy is an assault', () => {
  const s = closeIn();
  assert.equal(assaultVia(s, move(0, 3, 2)), 'move');
  assert.equal(assaultVia(s, fire(0, 3, 2)), 'fire');
  assert.equal(assaultVia(s, move(0, 4, 3)), null);
  assert.equal(validateAction(s, move(0, 3, 2)).ok, true, 'in the movement phase, by moving');
  const ff = toPhase(s, 'firefight');
  assert.equal(validateAction(ff, fire(0, 3, 2)).ok, true, 'in the firefight, by firing');
});

test('only a fireteam assaults; a suppressed team cannot move in but can assault by fire; pinned cannot at all', () => {
  const s = makeState(open(6, 4), [unit('BLUFOR', 'SL', 2, 1, { kind: 'leader' }), unit('OPFOR', 'ALPHA', 3, 1)]);
  assert.match(validateAction(s, move(0, 3, 1)).reason, /only a fireteam can assault/);
  const t = closeIn();
  t.units[0].status = 'suppressed';
  assert.match(validateAction(t, move(0, 3, 2)).reason, /suppressed and cannot move/);
  const ff = toPhase(closeIn(), 'firefight');
  ff.units[0].status = 'suppressed';
  assert.equal(validateAction(ff, fire(0, 3, 2)).ok, true);
  assert.equal(assaultSolution(ff, ff.units[0], H(3, 2)).attackTn, balance.assault.attackTn.ok + balance.assault.attackerSuppressedMod);
  ff.units[0].status = 'pinned';
  assert.match(validateAction(ff, fire(0, 3, 2)).reason, /pinned and cannot fire/);
});

test('target numbers: the attacker by the defender\'s state, the defender better dug in, worse suppressed, none if pinned', () => {
  const a = balance.assault;
  const sol = (st, rows) => { const s = closeIn(st, rows); return assaultSolution(s, s.units[0], H(3, 2)); };
  assert.equal(sol('ok').attackTn, a.attackTn.ok);
  assert.equal(sol('suppressed').attackTn, a.attackTn.suppressed);
  assert.equal(sol('pinned').attackTn, a.attackTn.pinned);
  assert.equal(sol('ok').defendTn, a.defendTn + a.dugInMod, 'dug in, in the trench');
  assert.equal(sol('ok', open(8, 6)).defendTn, a.defendTn, 'in the open');
  assert.equal(sol('suppressed').defendTn, a.defendTn + a.dugInMod + a.defenderSuppressedMod);
  assert.equal(sol('pinned').defendDice, 0, 'a pinned defender cannot shoot back');
  assert.equal(sol('ok').attackDice, 4, 'one die per soldier');
});

test('outcome: the defender is eliminated if wiped out or left with fewer men; otherwise the attacker falls back pinned', () => {
  assert.equal(assaultOutcome(4, 0), 'taken');
  assert.equal(assaultOutcome(3, 2), 'taken');
  assert.equal(assaultOutcome(2, 2), 'repulsed', 'a tie holds the hex');
  assert.equal(assaultOutcome(1, 3), 'repulsed');
  assert.equal(assaultOutcome(0, 1), 'attacker destroyed');
  assert.equal(assaultOutcome(0, 0), 'both destroyed');
});

test('taking the hex: the defender is eliminated, the attacker moves in; repulsed: it stays and is pinned', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const s = closeIn('suppressed');
    const r = act(s, move(0, 3, 2), seed);
    const e = r.events.find((x) => x.type === 'assault');
    const [atk, def] = [r.state.units[0], r.state.units[1]];
    assert.equal(e.attackRolls.length, 4);
    assert.equal(atk.soldiers.length, 4 - e.attackerLost.length);
    assert.equal(e.defenderLost.length, e.attackRolls.filter((d) => d >= e.attackTn).length);
    seen.add(e.result);
    if (e.result === 'taken') {
      assert.equal(def.status, 'eliminated');
      assert.deepEqual(atk.pos, H(3, 2));
      assert.ok(r.events.some((x) => x.type === 'moved' && x.unit === 0));
      assert.equal(r.state.contacts.BLUFOR[1], undefined);
    } else if (e.result === 'repulsed') {
      assert.deepEqual(atk.pos, H(3, 3));
      assert.equal(atk.status, 'pinned');
      assert.notEqual(def.status, 'eliminated');
    }
  }
  assert.ok(seen.has('taken') && seen.has('repulsed'), [...seen].join(', '));
});

test('an enemy SL in the hex is overrun with its team', () => {
  const s = makeState(open(6, 4), [unit('OPFOR', 'ALPHA', 2, 1), unit('BLUFOR', 'ALPHA', 3, 1), unit('BLUFOR', 'SL', 3, 1, { kind: 'leader' })]);
  s.units[1].status = 'pinned';
  const ea = toPhase(s, 'enemy action');
  ea.units[1].status = 'pinned';
  for (let seed = 1; seed <= 50; seed++) {
    const r = act(ea, move(0, 3, 1), seed);
    const e = r.events.find((x) => x.type === 'assault');
    assert.equal(e.defender, 1, 'the fireteam defends, not the SL');
    if (e.result === 'taken') {
      assert.deepEqual(e.overrun, [2]);
      assert.equal(r.state.units[2].status, 'eliminated');
      return;
    }
  }
  assert.fail('never taken');
});

test('planning: an assault leaves the team where it is in the projection', () => {
  const s = closeIn();
  const p = projectOrders(s, [move(0, 3, 2)]);
  assert.deepEqual(p.units[0].pos, H(3, 3));
  assert.equal(p.units[0].activated, true);
  assert.ok(checkPlan(s, [move(0, 3, 2), move(2, 3, 4)]).every((c) => c.ok));
});

// ---- the acceptance check: preview odds equal the exact odds the sim rolls ----

const CASES = [
  ['dug in, ok', () => closeIn('ok')],
  ['dug in, suppressed', () => closeIn('suppressed')],
  ['dug in, pinned', () => closeIn('pinned')],
  ['in the open, ok', () => closeIn('ok', open(8, 6))],
];

for (const [name, make] of CASES) {
  test(`assault preview equals the exact odds, and the dice match them (${name})`, () => {
    const s = make();
    const sol = assaultSolution(s, s.units[0], H(3, 2));
    const odds = assaultOdds(sol);
    assert.ok(Math.abs(odds.take + odds.repulsed + odds.attackerDestroyed - 1) < 1e-12);
    const line = previewAction(s, move(0, 3, 2));
    assert.ok(line.includes(`${pct(odds.take)} to take the hex`), line);
    assert.ok(line.includes(`hit on ${sol.attackTn}+`), line);
    let take = 0, aLoss = 0, dLoss = 0;
    const n = 4000;
    for (let i = 1; i <= n; i++) {
      const r = act(s, move(0, 3, 2), i * 7919);
      const e = r.events.find((x) => x.type === 'assault');
      assert.equal(e.attackTn, sol.attackTn);
      assert.equal(e.defendTn, sol.defendTn);
      assert.equal(e.defendRolls.length, sol.defendDice);
      if (e.result === 'taken') take++;
      aLoss += e.attackerLost.length;
      dLoss += e.defenderLost.length;
    }
    assert.ok(Math.abs(take / n - odds.take) < 0.03, `take: rolled ${take / n}, exact ${odds.take}`);
    assert.ok(Math.abs(aLoss / n - odds.expectedAttackerLosses) < 0.08, `attacker losses ${aLoss / n} vs ${odds.expectedAttackerLosses}`);
    assert.ok(Math.abs(dLoss / n - odds.expectedDefenderLosses) < 0.08, `defender losses ${dLoss / n} vs ${odds.expectedDefenderLosses}`);
  });
}

test('the fire preview shows the same exact odds the fire is rolled against', () => {
  const s = toPhase(makeState(ROWS, [unit('BLUFOR', 'ALPHA', 3, 5), unit('BLUFOR', 'BRAVO', 6, 2), unit('OPFOR', 'ALPHA', 3, 2)], 1, PARAPETS), 'firefight');
  for (const id of [0, 1]) {
    const sol = fireSolution(s, s.units[id], H(3, 2));
    const o = fireOdds({ dice: sol.dice, tn: sol.tn, casualtyOn: sol.cover.casualtyOn, pinAt: pinAt(balance, 'ok'), soldiers: 4 });
    const line = previewAction(s, fire(id, 3, 2));
    assert.ok(line.includes(`hit on ${sol.tn}+`) && line.includes(`${pct(o.anyHit)} at least one hit`) && line.includes(`${pct(o.pin)} to pin`), line);
    const e = act(s, fire(id, 3, 2)).events.find((x) => x.type === 'fire');
    assert.equal(e.tn, sol.tn);
    assert.equal(e.dice.length, sol.dice);
    assert.equal(e.casualtyOn, sol.cover.casualtyOn);
  }
});

// ---- the design pillar ----

test('a frontal assault on a dug-in team is a bad bet; fixed (pinned) first it is a good one', () => {
  const at = (st) => { const s = closeIn(st); return assaultOdds(assaultSolution(s, s.units[0], H(3, 2))); };
  assert.ok(at('ok').take < 0.25, `unsuppressed: ${at('ok').take}`);
  assert.ok(at('ok').expectedAttackerLosses > at('ok').expectedDefenderLosses, 'and costs more than it inflicts');
  assert.ok(at('pinned').take > 0.9, `pinned: ${at('pinned').take}`);
});

test('assaults replay identically', () => {
  const play = () => {
    let s = closeIn('suppressed');
    const log = [];
    for (const plan of [[move(0, 3, 2)], [], [], []]) {
      const r = commitOrders(s, plan, createRng(s.rngState));
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, log };
  };
  assert.deepEqual(play(), play());
});
