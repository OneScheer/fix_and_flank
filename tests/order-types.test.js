import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assaultChance } from '../src/sim/combat.js';
import { blastChance, planGrenade } from '../src/sim/grenade.js';
import { planOrders, validateOrder } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { resolveTurn, step } from '../src/sim/step.js';
import { balance, grass, makeState, weapons } from './helpers.js';

const unit = (side, team, role, x, y, stance) => ({ side, team, role, pos: [x, y], ...(stance ? { stance } : {}) });
const B = (team, type, extra) => ({ type, side: 'BLUFOR', team, ...extra });
const spot = (s, side, id, level = 'spotted') => {
  s.contacts[side][id] = { level, pos: { ...s.soldiers[id].pos }, lastSeenSec: 0 };
};
const noFire = (s, ids) => { for (const id of ids) s.soldiers[id].ammo = 0; };
const fires = (events, id) => events.filter((e) => e.type === 'fire' && e.id === id);

// ---- fire ----

test('fire: the team focuses on the ordered contact, not the easiest target', () => {
  const s = makeState(grass(40, 10), [
    unit('BLUFOR', 'ALPHA', 'RFL', 0, 5),
    unit('OPFOR', 'ALPHA', 'RFL', 10, 5, 'stand'), // close, easy
    unit('OPFOR', 'ALPHA', 'RFL', 30, 5),          // far, hard
  ]);
  spot(s, 'BLUFOR', 1);
  spot(s, 'BLUFOR', 2);
  noFire(s, [1, 2]);
  const atWill = step(s, [], createRng(1)).events.find((e) => e.type === 'fire');
  assert.equal(atWill.target, 1);
  const ordered = step(s, [B('ALPHA', 'fire', { target: 2 })], createRng(1)).events.find((e) => e.type === 'fire');
  assert.equal(ordered.target, 2);
  assert.equal(ordered.mode, 'aimed');
});

test('fire needs a spotted contact', () => {
  const s = makeState(grass(20, 5), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 2), unit('OPFOR', 'ALPHA', 'RFL', 10, 2)]);
  assert.match(validateOrder(s, B('ALPHA', 'fire', { target: 1 })).reason, /not a spotted contact/);
  spot(s, 'BLUFOR', 1, 'suspected');
  assert.match(validateOrder(s, B('ALPHA', 'fire', { target: 1 })).reason, /not a spotted contact/);
});

// ---- suppress ----

// OPFOR prone behind a low wall (no line of sight to him), BLUFOR 20 tiles south.
function behindWall() {
  const rows = grass(21, 30);
  rows[6] = '.'.repeat(10) + '-' + '.'.repeat(10);
  const s = makeState(rows, [
    unit('BLUFOR', 'ALPHA', 'RFL', 10, 26),
    unit('BLUFOR', 'ALPHA', 'AR', 12, 26),
    unit('OPFOR', 'ALPHA', 'RFL', 10, 5, 'prone'),
  ]);
  spot(s, 'BLUFOR', 2, 'suspected');
  noFire(s, [2]);
  return s;
}

test('suppress: fires on a suspected position it cannot see and pins the enemy there', () => {
  const s = behindWall();
  const order = B('ALPHA', 'suppress', { at: { x: 10, y: 5 }, target: 2 });
  const { state, events } = resolveTurn(s, [order]);
  const f = events.filter((e) => e.type === 'fire');
  assert.ok(f.length >= 8, `${f.length} bursts`);
  assert.ok(f.every((e) => e.mode === 'suppress' && e.at.x === 10 && e.at.y === 5));
  assert.ok(state.soldiers[2].suppression >= balance.suppression.pinned || state.soldiers[2].status === 'pinned');
  // No line of sight to the prone soldier behind the wall: no hits possible.
  assert.ok(f.every((e) => e.target === null && e.hits === 0));
});

test('suppress uses ammo faster than aimed fire', () => {
  const s = behindWall();
  const rifle = weapons.weapons.rifle;
  const { events } = resolveTurn(s, [B('ALPHA', 'suppress', { at: { x: 10, y: 5 } })]);
  const rounds = fires(events, 0).reduce((a, e) => a + e.rounds, 0);
  const aimedPerTurn = (balance.turn.durationSec / rifle.burstIntervalSec) * rifle.roundsPerBurst;
  assert.ok(rounds > aimedPerTurn, `${rounds} rounds vs ${aimedPerTurn} aimed`);
});

test('suppress can hit an exposed soldier near the point, at reduced accuracy', () => {
  const s = makeState(grass(30, 10), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 5), unit('OPFOR', 'ALPHA', 'RFL', 20, 5, 'stand')]);
  spot(s, 'BLUFOR', 1);
  noFire(s, [1]);
  const sup = step(s, [B('ALPHA', 'suppress', { at: { x: 20, y: 5 } })], createRng(1)).events.find((e) => e.type === 'fire');
  const aim = step(s, [B('ALPHA', 'fire', { target: 1 })], createRng(1)).events.find((e) => e.type === 'fire');
  assert.equal(sup.target, 1);
  assert.equal(sup.factors.fireMode, balance.orders.fireMode.suppress);
  assert.ok(sup.chance < aim.chance);
});

test('suppress fires through bushes but not through a wall, and says why', () => {
  const rows = grass(30, 5);
  rows[2] = '.'.repeat(12) + 'TTTT' + '.'.repeat(14);
  const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'RFL', 0, 2), unit('OPFOR', 'ALPHA', 'RFL', 25, 2)]);
  noFire(s, [1]);
  const throughTrees = step(s, [B('ALPHA', 'suppress', { at: { x: 25, y: 2 } })], createRng(1)).events;
  assert.ok(throughTrees.some((e) => e.type === 'fire' && e.mode === 'suppress'));

  const walled = grass(30, 5);
  walled[2] = '.'.repeat(12) + '#' + '.'.repeat(17);
  const w = makeState(walled, [unit('BLUFOR', 'ALPHA', 'RFL', 0, 2), unit('OPFOR', 'ALPHA', 'RFL', 25, 2)]);
  noFire(w, [1]);
  const { events } = resolveTurn(w, [B('ALPHA', 'suppress', { at: { x: 25, y: 2 } })]);
  assert.equal(events.filter((e) => e.type === 'fire').length, 0);
  const why = events.filter((e) => e.type === 'no_fire');
  assert.equal(why.length, 1, 'reported once, not every tick');
  assert.match(why[0].reason, /no line of fire \(wall at 12,2\)/);
});

// ---- overwatch ----

test('overwatch holds fire outside the arc and engages inside it, more accurately', () => {
  const s = makeState(grass(40, 40), [
    unit('BLUFOR', 'ALPHA', 'RFL', 20, 20),
    unit('OPFOR', 'ALPHA', 'RFL', 20, 5),   // north
    unit('OPFOR', 'ALPHA', 'RFL', 35, 20),  // east
  ]);
  spot(s, 'BLUFOR', 1);
  spot(s, 'BLUFOR', 2);
  noFire(s, [1, 2]);
  const east = step(s, [B('ALPHA', 'overwatch', { toward: { x: 39, y: 20 } })], createRng(1)).events.find((e) => e.type === 'fire');
  assert.equal(east.target, 2);
  assert.equal(east.mode, 'overwatch');
  assert.equal(east.factors.fireMode, balance.orders.fireMode.overwatch);
  const south = step(s, [B('ALPHA', 'overwatch', { toward: { x: 20, y: 39 } })], createRng(1)).events;
  assert.equal(south.filter((e) => e.type === 'fire').length, 0, 'both enemies are outside a southern arc');
});

// ---- assault ----

test('assault: the team runs in and closes with the target', () => {
  const s = makeState(grass(30, 10), [unit('BLUFOR', 'ALPHA', 'TL', 0, 5), unit('OPFOR', 'ALPHA', 'RFL', 20, 5, 'prone')]);
  noFire(s, [1]);
  assert.match(planOrders(s, [B('ALPHA', 'assault', { at: { x: 20, y: 5 }, target: 1 })])[0].reason,
    /not a known contact/, 'cannot name an enemy nobody has seen');
  const [plan] = planOrders(s, [B('ALPHA', 'assault', { at: { x: 20, y: 5 } })]);
  assert.ok(plan.ok);
  const { state } = resolveTurn(s, [B('ALPHA', 'assault', { at: { x: 20, y: 5 } })]);
  assert.equal(state.soldiers[0].stance, 'stand');
  assert.ok(state.soldiers[0].pos.x >= 15);
});

test('close assault kills a pinned or exposed enemy, but rarely an alert one in cover facing the attacker', () => {
  const rows = grass(10, 10);
  rows[4] = '....-.....';
  const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 4, 3), unit('OPFOR', 'ALPHA', 'RFL', 4, 5, 'crouch')]);
  // Attacker across the low wall, 2 tiles north: the wall faces him.
  const alert = assaultChance(s, s.soldiers[0], s.soldiers[1]).chance;
  assert.ok(alert < 0.35, `alert, in cover: ${alert}`);
  s.soldiers[1].status = 'pinned';
  const pinned = assaultChance(s, s.soldiers[0], s.soldiers[1]).chance;
  assert.ok(pinned > 0.6, `pinned: ${pinned}`);
  // From the open flank the low wall gives no cover, even against an alert enemy.
  s.soldiers[1].status = 'active';
  s.soldiers[0].pos = { x: 6, y: 5 };
  const flank = assaultChance(s, s.soldiers[0], s.soldiers[1]).chance;
  assert.ok(flank > 0.6, `flank: ${flank}`);
});

test('a close assault in the sim reports its chance and can kill', () => {
  const s = makeState(grass(10, 3), [unit('BLUFOR', 'ALPHA', 'TL', 3, 1), unit('OPFOR', 'ALPHA', 'RFL', 4, 1, 'prone')]);
  s.soldiers[1].suppression = 90;
  s.soldiers[1].status = 'pinned';
  noFire(s, [1]);
  spot(s, 'BLUFOR', 1);
  const { state, events } = resolveTurn(s, [B('ALPHA', 'assault', { at: { x: 4, y: 1 }, target: 1 })]);
  const a = events.filter((e) => e.type === 'assault');
  assert.ok(a.length >= 1);
  assert.ok(a[0].chance > 0.6);
  assert.equal(state.soldiers[1].status, 'dead');
});

// ---- grenade ----

test('the grenadier fires 40 mm at range; up close the nearest soldier throws a hand grenade', () => {
  const s = makeState(grass(60, 10), [
    unit('BLUFOR', 'ALPHA', 'TL', 2, 5),
    unit('BLUFOR', 'ALPHA', 'GRN', 0, 5),
  ]);
  const far = planGrenade(s, s.soldiers, { x: 40, y: 5 });
  assert.equal(far.kind, '40mm');
  assert.equal(far.thrower, 1);
  const near = planGrenade(s, s.soldiers, { x: 12, y: 5 });
  assert.equal(near.kind, 'hand');
  assert.equal(near.thrower, 0, 'TL is closer');
  const tooFar = planGrenade(s, s.soldiers, { x: 59, y: 5 }); // 118 m from GRN: 40 mm ok
  assert.equal(tooFar.kind, '40mm');
  assert.equal(planGrenade(s, [s.soldiers[0]], { x: 40, y: 5 }).ok, false, 'no 40 mm without the GRN');
});

test('a grenade lands after its flight time, within its scatter, and hurts friend and foe alike', () => {
  const s = makeState(grass(40, 10), [
    unit('BLUFOR', 'ALPHA', 'GRN', 0, 5),
    unit('BLUFOR', 'BRAVO', 'RFL', 30, 5), // own soldier right next to the impact
    unit('OPFOR', 'ALPHA', 'RFL', 30, 4),
  ]);
  noFire(s, [0, 1, 2]);
  const order = B('ALPHA', 'grenade', { at: { x: 30, y: 4 } });
  const [plan] = planOrders(s, [order]);
  const { events } = resolveTurn(s, [order]);
  const thrown = events.find((e) => e.type === 'throw');
  const boom = events.find((e) => e.type === 'explosion');
  assert.equal(thrown.kind, '40mm');
  assert.ok(Math.abs((boom.tick + 1) * s.tickSec - ((thrown.tick + 1) * s.tickSec + plan.grenade.flightSec)) < s.tickSec);
  assert.ok(Math.abs(boom.pos.x - 30) <= plan.grenade.scatterTiles && Math.abs(boom.pos.y - 4) <= plan.grenade.scatterTiles);
  assert.ok(boom.effects.some((e) => e.id === 1), 'friendly soldier caught in the blast');
  assert.ok(boom.effects.some((e) => e.id === 2));
});

test('a grenade landing behind a wall gets round the wall; a full wall shields', () => {
  const rows = grass(10, 10);
  rows[4] = '....-.....';
  rows[7] = '##########';
  const s = makeState(rows, [unit('OPFOR', 'ALPHA', 'RFL', 4, 5, 'prone'), unit('OPFOR', 'ALPHA', 'AR', 4, 8, 'prone')]);
  const target = s.soldiers[0];
  const fromFront = blastChance(s, { x: 4, y: 3 }, target);   // lands on the far side of the low wall
  const behind = blastChance(s, { x: 5, y: 6 }, target);      // lands next to him, on his side
  assert.ok(fromFront.chance < behind.chance, `front ${fromFront.chance} vs behind ${behind.chance}`);
  assert.equal(blastChance(s, { x: 4, y: 6 }, s.soldiers[1]).shielded, true, 'the full wall stops it');
});

test('grenade orders out of range are rejected with the reason', () => {
  const s = makeState(grass(100, 5), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 2)]);
  const [plan] = planOrders(s, [B('ALPHA', 'grenade', { at: { x: 40, y: 2 } })]);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /out of hand grenade range/);
});

// ---- stance and hold ----

test('stance order changes stance and stops the team', () => {
  let s = makeState(grass(40, 5), [unit('BLUFOR', 'ALPHA', 'TL', 0, 2)]);
  s = resolveTurn(s, [B('ALPHA', 'move', { dest: { x: 39, y: 2 }, speed: 'walk' })]).state;
  const x = s.soldiers[0].pos.x;
  const { state } = resolveTurn(s, [B('ALPHA', 'stance', { stance: 'prone' })]);
  assert.equal(state.soldiers[0].stance, 'prone');
  assert.equal(state.soldiers[0].pos.x, x);
  assert.equal(state.soldiers[0].move, null);
});

test('hold clears fire tasks: the team goes back to fire at will', () => {
  let s = behindWall();
  s = resolveTurn(s, [B('ALPHA', 'suppress', { at: { x: 10, y: 5 } })]).state;
  assert.equal(s.soldiers[0].task.type, 'suppress');
  s = resolveTurn(s, [B('ALPHA', 'hold')]).state;
  assert.equal(s.soldiers[0].task, null);
});

test('pinned soldiers still take fire orders, but not move orders', () => {
  const s = makeState(grass(30, 5), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 2), unit('OPFOR', 'ALPHA', 'RFL', 20, 2)]);
  s.soldiers[0].status = 'pinned';
  s.soldiers[0].suppression = 80;
  assert.equal(validateOrder(s, B('ALPHA', 'suppress', { at: { x: 20, y: 2 } })).ok, true);
  assert.match(validateOrder(s, B('ALPHA', 'move', { dest: { x: 5, y: 2 }, speed: 'walk' })).reason, /no soldiers able to move/);
});

test('every order type replays identically with the same seed', () => {
  const play = () => {
    let s = behindWall();
    const turns = [
      [B('ALPHA', 'suppress', { at: { x: 10, y: 5 }, target: 2 })],
      [B('ALPHA', 'grenade', { at: { x: 10, y: 6 } })],
      [B('ALPHA', 'assault', { at: { x: 10, y: 5 }, target: 2 })],
      [B('ALPHA', 'stance', { stance: 'crouch' })],
    ];
    const log = [];
    for (const o of turns) {
      const r = resolveTurn(s, o);
      s = r.state;
      log.push(r.events);
    }
    return { soldiers: s.soldiers, log };
  };
  assert.deepEqual(play(), play());
});
