// Hex milestone 4 acceptance: target numbers and modifiers; outcome
// frequencies over many seeded rolls match the exact odds; a team in a
// trench is much harder to kill than one in the open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, validateAction } from '../src/sim/actions.js';
import { assaultVia } from '../src/sim/assault.js';
import { fireDice, fireSolution, pinAt } from '../src/sim/combat.js';
import { fireOdds } from '../src/sim/odds.js';
import { commitOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { H, balance, makeState, open, toPhase, unit } from './helpers.js';

const act = (s, a) => applyAction(s, a, createRng(s.rngState));
const fire = (id, col, row) => ({ type: 'fire', unit: id, target: H(col, row) });
const spot = (s, side, id) => { s.contacts[side][id] = { level: 'spotted', pos: { ...s.units[id].pos }, turn: s.turn }; return s; };
const mods = (sol) => Object.fromEntries(sol.mods.map((m) => [m.why, m.mod]));

// A trench at 3,2 with parapets facing south (SW, SE). BLUFOR ALPHA (0) south
// of it at 3,5, BRAVO (1) on its east flank at 6,2; OPFOR ALPHA (2) in it.
const ROWS = ['........', '........', '...n....', '........', '........', '........', '........', '........'];
const PARAPETS = [{ hex: [3, 2], sides: ['SW', 'SE'], feature: 'parapet' }];
function trench() {
  const s = makeState(ROWS, [unit('BLUFOR', 'ALPHA', 3, 5), unit('BLUFOR', 'BRAVO', 6, 2), unit('OPFOR', 'ALPHA', 3, 2)], 1, PARAPETS);
  return spot(toPhase(s, 'firefight'), 'BLUFOR', 2);
}
// Same, the enemy in the open.
function inOpen() {
  const s = makeState(open(8, 8), [unit('BLUFOR', 'ALPHA', 3, 5), unit('BLUFOR', 'BRAVO', 6, 2), unit('OPFOR', 'ALPHA', 3, 2)]);
  return toPhase(s, 'firefight');
}

// ---- target numbers ----

test('a fireteam rolls 5 dice (the AR rolls two); the SL one', () => {
  const s = inOpen();
  assert.equal(fireDice(balance, s.units[0]), 5);
  assert.equal(fireDice(balance, { soldiers: ['SL'] }), 1);
  assert.equal(fireDice(balance, { soldiers: ['TL', 'GRN'] }), 2);
});

test('base TN 4 on a spotted team in the open at close range', () => {
  const sol = fireSolution(inOpen(), inOpen().units[0], H(3, 2));
  assert.equal(sol.ok, true);
  assert.equal(sol.aimed, true);
  assert.equal(sol.range, 3);
  assert.equal(sol.tn, 4);
  assert.deepEqual(sol.mods, []);
  assert.equal(sol.target, 2);
});

test('range bands: +1 from 4 hexes, +2 from 7, nothing beyond 10', () => {
  const s = makeState(open(14, 1), [unit('BLUFOR', 'ALPHA', 0, 0), unit('OPFOR', 'ALPHA', 13, 0)]);
  const at = (col) => fireSolution(s, s.units[0], H(col, 0));
  assert.equal(at(3).tn, 4 + 2, 'empty hex: +2 suppressive fire only');
  assert.equal(mods(at(4))['range 4 hexes'], 1);
  assert.equal(mods(at(7))['range 7 hexes'], 2);
  assert.equal(mods(at(10))['range 10 hexes'], 2);
  assert.match(at(11).reason, /out of range/);
});

test('cover: a parapet facing the shooter is +2, the trench from the flank +1', () => {
  const s = trench();
  const front = fireSolution(s, s.units[0], H(3, 2));
  assert.equal(mods(front)['behind a parapet (SE side)'], 2);
  assert.equal(front.tn, 6);
  assert.equal(front.cover.casualtyOn, 6);
  const flank = fireSolution(s, s.units[1], H(3, 2));
  assert.equal(mods(flank)['in trench'], 1);
  assert.equal(flank.tn, 5);
  assert.equal(flank.cover.casualtyOn, 5);
});

test('exposed target -1, suppressed shooter +1, suppressive fire +2, clamped to 2..6', () => {
  const s = inOpen();
  s.units[2].exposed = true;
  assert.equal(fireSolution(s, s.units[0], H(3, 2)).tn, 3);
  s.units[2].exposed = false;
  s.units[0].status = 'suppressed';
  assert.equal(fireSolution(s, s.units[0], H(3, 2)).tn, 5);
  const t = trench();
  delete t.contacts.BLUFOR[2]; // unseen in the trench
  const blind = fireSolution(t, t.units[0], H(3, 2));
  assert.equal(blind.aimed, false);
  assert.equal(mods(blind)['no spotted enemy: suppressive fire'], 2);
  assert.equal(blind.rawTn, 8);
  assert.equal(blind.tn, balance.fire.maxTn);
});

test('fire needs line of sight and no friendly in the hex; an adjacent spotted enemy is an assault', () => {
  const s = makeState(['...T....', '........'], [unit('BLUFOR', 'ALPHA', 0, 0), unit('BLUFOR', 'BRAVO', 1, 1), unit('OPFOR', 'ALPHA', 6, 0)]);
  assert.match(fireSolution(s, s.units[0], H(6, 0)).reason, /no line of sight \(woods at 3,0\)/);
  assert.match(fireSolution(s, s.units[0], H(1, 1)).reason, /friendly unit/);
  const a = makeState(open(4, 2), [unit('BLUFOR', 'ALPHA', 1, 0), unit('OPFOR', 'ALPHA', 2, 0)]);
  assert.equal(assaultVia(a, fire(0, 2, 0)), 'fire');
  assert.equal(assaultVia(a, fire(0, 3, 0)), null, 'not adjacent: plain fire');
});

test('fire is an order for the firefight and enemy action phases, for units that did not move and are not pinned', () => {
  const s = makeState(open(8, 8), [unit('BLUFOR', 'ALPHA', 3, 5), unit('BLUFOR', 'BRAVO', 5, 5), unit('OPFOR', 'ALPHA', 3, 2)]);
  assert.match(validateAction(s, fire(0, 3, 2)).reason, /no firing in the movement phase/);
  const ff = commitOrders(s, [{ type: 'move', unit: 1, to: H(5, 4) }], createRng(1)).state;
  assert.equal(validateAction(ff, fire(0, 3, 2)).ok, true);
  assert.match(validateAction(ff, fire(1, 3, 2)).reason, /already acted|moved/);
  ff.units[0].status = 'pinned';
  assert.match(validateAction(ff, fire(0, 3, 2)).reason, /pinned and cannot fire/);
  const enemy = toPhase(makeState(open(8, 8), [unit('BLUFOR', 'ALPHA', 3, 5), unit('OPFOR', 'ALPHA', 3, 2)]), 'enemy action');
  assert.equal(validateAction(enemy, fire(1, 3, 5)).ok, true, 'OPFOR fires in its phase');
});

// ---- results ----

test('1 hit suppresses, 2 pin; a suppressed unit hit once is pinned', () => {
  assert.equal(pinAt(balance, 'ok'), balance.fire.pinHits);
  assert.equal(pinAt(balance, 'suppressed'), 1);
  const seen = { 1: 0, 2: 0 };
  for (let seed = 1; seed <= 200; seed++) {
    const s = inOpen();
    s.rngState = seed;
    const r = act(s, fire(0, 3, 2));
    const e = r.events.find((x) => x.type === 'fire');
    const t = r.state.units[2];
    if (e.hits === 0) assert.equal(t.status, 'ok');
    else if (!e.eliminated) assert.equal(t.status, e.hits >= 2 ? 'pinned' : 'suppressed');
    if (e.hits === 1) seen[1]++;
    if (e.hits >= 2) seen[2]++;
  }
  assert.ok(seen[1] && seen[2]);
  for (let seed = 1; seed <= 100; seed++) {
    const s = inOpen();
    s.rngState = seed;
    s.units[2].status = 'suppressed';
    const r = act(s, fire(0, 3, 2));
    if (r.events.find((x) => x.type === 'fire').hits >= 1 && r.state.units[2].status !== 'eliminated') assert.equal(r.state.units[2].status, 'pinned');
  }
});

test('each hit rolls for a casualty against cover; the rifleman goes first, the AR last; nobody left is eliminated', () => {
  let losses = [];
  for (let seed = 1; seed <= 300; seed++) {
    const s = inOpen();
    s.rngState = seed;
    const r = act(s, fire(0, 3, 2));
    const e = r.events.find((x) => x.type === 'fire');
    assert.equal(e.casualtyRolls.length, e.hits);
    assert.deepEqual(e.casualtyRolls.map((c) => c.kill), e.casualtyRolls.map((c) => c.roll >= 4));
    assert.equal(r.state.units[2].soldiers.length, 4 - e.lost.length);
    if (e.lost.length) losses.push(e.lost);
  }
  for (const l of losses) assert.deepEqual(l, balance.unit.casualtyOrder.slice(0, l.length));
  const s = inOpen();
  s.units[2].soldiers = ['AR'];
  let gone = null;
  for (let seed = 1; seed <= 50 && !gone; seed++) {
    s.rngState = seed;
    const r = act(s, fire(0, 3, 2));
    if (r.events.find((x) => x.type === 'fire').eliminated) gone = r.state;
  }
  assert.equal(gone.units[2].status, 'eliminated');
  assert.equal(gone.contacts.BLUFOR[2], undefined, 'no contact on an eliminated team');
});

// ---- frequencies match the exact odds ----

function frequencies(make, shooter, hex, n) {
  let anyHit = 0, pin = 0, kills = 0, anyKill = 0;
  for (let seed = 1; seed <= n; seed++) {
    const s = make();
    s.rngState = seed * 7919;
    const r = act(s, fire(shooter, hex.col, hex.row));
    const e = r.events.find((x) => x.type === 'fire');
    if (e.hits) anyHit++;
    if (e.hits >= balance.fire.pinHits) pin++;
    kills += e.lost.length;
    if (e.lost.length) anyKill++;
  }
  return { anyHit: anyHit / n, pin: pin / n, expectedCasualties: kills / n, anyCasualty: anyKill / n };
}

for (const [name, make, shooter] of [['open', inOpen, 0], ['trench, front', trench, 0], ['trench, flank', trench, 1]]) {
  test(`outcome frequencies match the exact odds (${name})`, () => {
    const s = make();
    const sol = fireSolution(s, s.units[shooter], H(3, 2));
    const odds = fireOdds({ dice: sol.dice, tn: sol.tn, casualtyOn: sol.cover.casualtyOn, pinAt: pinAt(balance, 'ok'), soldiers: 4 });
    const f = frequencies(make, shooter, H(3, 2), 4000);
    for (const k of ['anyHit', 'pin', 'expectedCasualties', 'anyCasualty']) {
      assert.ok(Math.abs(f[k] - odds[k]) < 0.03, `${k}: rolled ${f[k].toFixed(3)}, exact ${odds[k].toFixed(3)}`);
    }
  });
}

test('the exact odds: 5 dice hitting on 6 is 60% for at least one hit', () => {
  const o = fireOdds({ dice: 5, tn: 6, casualtyOn: 6, pinAt: 2, soldiers: 4 });
  assert.ok(Math.abs(o.anyHit - (1 - (5 / 6) ** 5)) < 1e-12);
  assert.equal(Math.round(o.anyHit * 100), 60);
  assert.equal(Math.round(o.pin * 100), 20);
  assert.ok(Math.abs(o.expectedCasualties - 5 / 36) < 1e-6, 'all but a 5-casualty roll on a team of 4');
});

test('a team in a trench is much harder to kill than one in the open', () => {
  const open4 = frequencies(inOpen, 0, H(3, 2), 2000).expectedCasualties;
  const front = frequencies(trench, 0, H(3, 2), 2000).expectedCasualties;
  const flank = frequencies(trench, 1, H(3, 2), 2000).expectedCasualties;
  assert.ok(open4 > 5 * front, `open ${open4}, trench front ${front}`);
  assert.ok(flank > 2 * front, `flanking pays: flank ${flank}, front ${front}`);
});

// ---- fog ----

test('suppressive fire into a hex with an unseen enemy can still hit it', () => {
  let hit = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const s = trench();
    delete s.contacts.BLUFOR[2];
    s.rngState = seed;
    const e = act(s, fire(0, 3, 2)).events.find((x) => x.type === 'fire');
    assert.equal(e.aimed, false);
    assert.equal(e.tn, 6);
    if (e.statusTo) hit++;
  }
  assert.ok(hit > 0);
});

test('fire at an empty hex rolls the dice and hits nobody', () => {
  const s = inOpen();
  const e = act(s, fire(0, 3, 3)).events.find((x) => x.type === 'fire');
  assert.equal(e.target, null);
  assert.equal(e.dice.length, 5);
  assert.deepEqual(e.casualtyRolls, []);
});

test('firing gives the shooter away; it stays spotted while it stays put', () => {
  // OPFOR in the trench, unseen, fires in its phase: BLUFOR spots it and still
  // sees it through its own movement and firefight phases.
  let s = makeState(ROWS, [unit('BLUFOR', 'ALPHA', 3, 5), unit('OPFOR', 'ALPHA', 3, 2)], 1, PARAPETS);
  assert.equal(s.contacts.BLUFOR[1], undefined);
  s = toPhase(s, 'enemy action');
  const r = act(s, fire(1, 3, 4)); // suppressive fire short of ALPHA, so ALPHA can still act
  assert.equal(r.events.find((e) => e.type === 'spotted' && e.side === 'BLUFOR').why, 'firing');
  assert.equal(r.state.contacts.BLUFOR[1].level, 'spotted');
  assert.equal(r.state.turn, 2);
  const ff = commitOrders(r.state, [], createRng(r.state.rngState)).state;
  assert.equal(ff.balance.turn.phases[ff.phase].name, 'firefight');
  assert.equal(ff.contacts.BLUFOR[1]?.level, 'spotted', 'still seen in the firefight phase');
  assert.equal(validateAction(ff, fire(0, 3, 2)).ok, true, 'and can be engaged with aimed fire');
  const later = commitOrders(ff, [], createRng(ff.rngState)).state;
  assert.equal(later.balance.turn.phases[later.phase].name, 'enemy action');
  assert.equal(later.units[1].fired, false, 'its own turn has started');
  assert.equal(later.contacts.BLUFOR[1]?.level, 'spotted', 'but it stays marked in its trench: a known position');
});

test('fire replays identically', () => {
  const play = () => {
    let s = trench();
    const log = [];
    for (const plan of [[fire(0, 3, 2), fire(1, 3, 2)], [], []]) {
      const r = commitOrders(s, plan, createRng(s.rngState));
      s = r.state;
      log.push(r.events);
    }
    return { units: s.units, log };
  };
  assert.deepEqual(play(), play());
});
