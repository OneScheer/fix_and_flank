import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseHit, deriveStatus, hitChance } from '../src/sim/combat.js';
import { createRng } from '../src/sim/rng.js';
import { resolveTurn, step } from '../src/sim/step.js';
import { balance, grass, makeState, weapons } from './helpers.js';

const unit = (side, team, role, x, y, stance) => ({ side, team, role, pos: [x, y], ...(stance ? { stance } : {}) });
const rifle = weapons.weapons.rifle;

// A crouched OPFOR rifleman at (20,20) with a low wall on the tile north of him.
// Shooters at the same range: one to the north (front), one to the east (flank).
function dugIn(targetStance = 'crouch') {
  const rows = grass(50, 50);
  rows[19] = '.'.repeat(20) + '-' + '.'.repeat(29);
  return makeState(rows, [
    unit('BLUFOR', 'ALPHA', 'RFL', 20, 45),  // moved into place per test
    unit('BLUFOR', 'BRAVO', 'RFL', 45, 20),
    unit('OPFOR', 'ALPHA', 'RFL', 20, 20, targetStance),
  ]);
}

function at(state, id, x, y) {
  state.soldiers[id].pos = { x, y };
  return state.soldiers[id];
}

// ---- Milestone 4 acceptance: hard to hit from the front, easy from the flank ----

test('a soldier behind a wall is hard to hit from the front and easy to hit from the flank', () => {
  const s = dugIn();
  // Front: 20 tiles north (40 m). Flank: 20 tiles east (40 m).
  const shooterFront = at(s, 0, 20, 0);
  const shooterFlank = at(s, 1, 40, 20);
  const target = s.soldiers[2];
  const hf = hitChance(s, shooterFront, target);
  const hk = hitChance(s, shooterFlank, target);
  assert.equal(hf.rangeM, hk.rangeM);
  assert.equal(hf.cover.direction.name, 'north');
  assert.equal(hf.cover.tile.what, 'low wall');
  assert.equal(hk.cover.protection, 0);
  assert.ok(hf.chance < hk.chance * 0.4, `front ${hf.chance.toFixed(3)} vs flank ${hk.chance.toFixed(3)}`);

  // And in practice: fire 2000 rounds from each side.
  const rng = createRng(77);
  let frontHits = 0;
  let flankHits = 0;
  for (let i = 0; i < 2000; i++) {
    if (rng.chance(hf.chance)) frontHits++;
    if (rng.chance(hk.chance)) flankHits++;
  }
  assert.ok(frontHits * 2.5 < flankHits, `front ${frontHits} hits vs flank ${flankHits} hits`);
});

test('prone behind a low wall cannot be hit from the front at all, but can from the flank', () => {
  const s = dugIn('prone');
  const front = hitChance(s, at(s, 0, 20, 0), s.soldiers[2]);
  assert.equal(front.chance, 0);
  assert.match(front.reason, /no line of sight \(low wall at 20,19\)/);
  assert.ok(hitChance(s, at(s, 1, 40, 20), s.soldiers[2]).chance > 0);
});

test('standing up behind a low wall throws most of the cover away', () => {
  const s = dugIn('stand');
  const h = hitChance(s, at(s, 0, 20, 0), s.soldiers[2]);
  assert.ok(h.factors.cover > 0.7, `cover factor ${h.factors.cover}`);
});

// ---- hit chance factors ----

test('every factor is exposed, and the chance is their clamped product', () => {
  const s = dugIn();
  const h = hitChance(s, at(s, 1, 40, 20), s.soldiers[2]);
  assert.deepEqual(Object.keys(h.factors).sort(),
    ['base', 'cover', 'fireMode', 'movement', 'optic', 'shooterStance', 'suppression', 'targetStance', 'wounded']);
  const product = Object.values(h.factors).reduce((a, b) => a * b, 1);
  assert.equal(h.chance, Math.min(balance.combat.maxHit, Math.max(balance.combat.minHit, product)));
});

test('base hit falls with range and is zero beyond max range', () => {
  assert.equal(baseHit(rifle, 0), rifle.hitByRangeM[0][1]);
  assert.ok(baseHit(rifle, 30) < baseHit(rifle, 20));
  assert.ok(Math.abs(baseHit(rifle, 75) - (0.25 + 0.1) / 2) < 1e-9);
  assert.equal(baseHit(rifle, rifle.maxRangeM + 1), 0);
});

test('moving, running, suppression and wounds all cost accuracy; crawling means no fire', () => {
  const s = dugIn();
  const shooter = at(s, 1, 40, 20);
  const target = s.soldiers[2];
  const still = hitChance(s, shooter, target).chance;
  assert.ok(hitChance(s, shooter, target, { movement: 'walk' }).chance < still);
  assert.ok(hitChance(s, shooter, target, { movement: 'run' }).chance < hitChance(s, shooter, target, { movement: 'walk' }).chance);
  const crawl = hitChance(s, shooter, target, { movement: 'crawl' });
  assert.equal(crawl.chance, 0);
  assert.match(crawl.reason, /crawl/);
  shooter.suppression = balance.suppression.shaken;
  const shaken = hitChance(s, shooter, target).chance;
  shooter.suppression = balance.suppression.pinned;
  const pinned = hitChance(s, shooter, target).chance;
  assert.ok(pinned < shaken && shaken < still);
  shooter.suppression = 0;
  shooter.hp = 50;
  assert.ok(hitChance(s, shooter, target).chance < still);
});

test('hit chance is clamped to a sensible range', () => {
  const s = makeState(grass(5, 1), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 0, 'prone'), unit('OPFOR', 'ALPHA', 'RFL', 1, 0, 'stand')]);
  assert.ok(hitChance(s, s.soldiers[0], s.soldiers[1]).chance <= balance.combat.maxHit);
});

// ---- status from hp and suppression ----

test('status thresholds: wounded, shaken at 40, pinned at 70, down, dead', () => {
  const st = (hp, suppression) => deriveStatus(balance, { hp, suppression });
  assert.equal(st(100, 0), 'active');
  assert.equal(st(55, 0), 'wounded');
  assert.equal(st(100, 40), 'shaken');
  assert.equal(st(100, 70), 'pinned');
  assert.equal(st(20, 90), 'down');
  assert.equal(st(0, 0), 'dead');
});

// ---- firing in the sim ----

// Two riflemen facing each other across open ground, already spotted.
function duel(distance, extra = []) {
  const s = makeState(grass(distance + 1, 5), [
    unit('BLUFOR', 'ALPHA', 'RFL', 0, 2),
    unit('OPFOR', 'ALPHA', 'RFL', distance, 2),
    ...extra,
  ]);
  s.contacts.BLUFOR[1] = { level: 'spotted', pos: { x: distance, y: 2 }, lastSeenSec: 0 };
  s.contacts.OPFOR[0] = { level: 'spotted', pos: { x: 0, y: 2 }, lastSeenSec: 0 };
  return s;
}

test('soldiers fire at spotted enemies, spend ammo and suppress the target', () => {
  const s = duel(30);
  const { state, events } = resolveTurn(s, []);
  const fire = events.filter((e) => e.type === 'fire' && e.id === 0);
  assert.ok(fire.length >= 4, `${fire.length} bursts`);
  assert.equal(state.soldiers[0].ammo, rifle.ammo - fire.reduce((a, e) => a + e.rounds, 0));
  assert.ok(fire.every((e) => e.target === 1 && e.chance > 0 && e.factors && e.cover));
  assert.ok(state.soldiers[1].suppression > 0 || state.soldiers[1].status === 'dead');
});

test('both sides fire in the same tick even if one shot would kill the other', () => {
  const s = duel(3);
  s.soldiers[0].hp = 1;
  s.soldiers[1].hp = 1;
  const { events } = step(s, [], createRng(5));
  const shooters = events.filter((e) => e.type === 'fire').map((e) => e.id).sort();
  assert.deepEqual(shooters, [0, 1]);
});

test('hits do damage: wounded, then down, then dead, with events', () => {
  const s = duel(2);
  s.soldiers[0].ammo = 0; // only OPFOR fires
  let state = s;
  const events = [];
  for (let t = 0; t < 10 && state.soldiers[0].status !== 'dead'; t++) {
    const r = resolveTurn(state, []);
    state = r.state;
    events.push(...r.events);
    state.contacts.OPFOR[0] = { level: 'spotted', pos: state.soldiers[0].pos, lastSeenSec: 0 };
  }
  const hits = events.filter((e) => e.type === 'hit' && e.id === 0);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].hp, balance.soldier.hp - rifle.damage);
  const statuses = events.filter((e) => e.type === 'status' && e.id === 0).map((e) => e.to);
  assert.ok(statuses.includes('down') || statuses.includes('dead'), statuses.join(','));
});

test('down soldiers are not targeted', () => {
  const s = duel(10);
  s.soldiers[1].hp = 10;
  s.soldiers[1].status = 'down';
  const { events } = step(s, [], createRng(1));
  assert.equal(events.filter((e) => e.type === 'fire' && e.id === 0).length, 0);
});

test('near misses suppress soldiers next to the target, less than the target', () => {
  const s = duel(30, [unit('OPFOR', 'ALPHA', 'AR', 30, 3)]);
  s.soldiers[1].ammo = 0;
  s.soldiers[2].ammo = 0;
  const { events } = step(s, [], createRng(2));
  const fire = events.find((e) => e.type === 'fire');
  const onTarget = fire.suppressed.find((x) => x.id === 1).amount;
  const nearby = fire.suppressed.find((x) => x.id === 2).amount;
  assert.ok(nearby > 0 && nearby < onTarget);
});

test('automatic fire suppresses more than single shots', () => {
  const lmg = weapons.weapons.lmg;
  assert.ok(lmg.roundsPerBurst * lmg.suppressionPerRound > rifle.roundsPerBurst * rifle.suppressionPerRound);
});

test('pinned soldiers go prone and stop moving', () => {
  const s0 = makeState(grass(30, 3), [unit('BLUFOR', 'ALPHA', 'TL', 0, 1)]);
  s0.soldiers[0].suppression = 95;
  s0.soldiers[0].underFireUntilSec = 1000;
  const r0 = resolveTurn(s0, []); // status catches up with the suppression
  assert.equal(r0.state.soldiers[0].status, 'pinned');
  const { state, events } = resolveTurn(r0.state, [{ type: 'move', side: 'BLUFOR', team: 'ALPHA', dest: { x: 29, y: 1 }, speed: 'run' }]);
  // Pinned soldiers are not given new move orders at all.
  assert.ok(events.some((e) => e.type === 'order_rejected'));
  assert.equal(state.soldiers[0].stance, 'prone');
  assert.deepEqual(state.soldiers[0].pos, { x: 0, y: 1 });
});

test('a moving soldier who becomes pinned stops, and moves on once he recovers', () => {
  let s = makeState(grass(60, 3), [unit('BLUFOR', 'ALPHA', 'TL', 0, 1)]);
  s = resolveTurn(s, [{ type: 'move', side: 'BLUFOR', team: 'ALPHA', dest: { x: 59, y: 1 }, speed: 'walk' }]).state;
  const x1 = s.soldiers[0].pos.x;
  // Pinned and kept under fire for the whole turn.
  s.soldiers[0].suppression = 100;
  s.soldiers[0].underFireUntilSec = 2 * balance.turn.durationSec;
  const pinnedTurn = resolveTurn(s, []);
  assert.equal(pinnedTurn.events.find((e) => e.type === 'status').to, 'pinned');
  assert.equal(pinnedTurn.state.soldiers[0].stance, 'prone');
  assert.ok(pinnedTurn.state.soldiers[0].pos.x <= x1 + 1);
  let later = pinnedTurn.state;
  for (let i = 0; i < 4; i++) later = resolveTurn(later, []).state;
  assert.notEqual(later.soldiers[0].status, 'pinned');
  assert.ok(later.soldiers[0].pos.x > x1 + 1, 'resumed the move');
  assert.equal(later.soldiers[0].stance, balance.movement.stanceForSpeed.walk, 'back up in the move stance');
});

test('suppression decays, faster prone in cover, slower under fire', () => {
  const rows = grass(10, 3);
  rows[0] = '....-.....';
  const s = makeState(rows, [
    unit('BLUFOR', 'ALPHA', 'TL', 1, 1, 'crouch'),   // open
    unit('BLUFOR', 'BRAVO', 'TL', 4, 1, 'prone'),    // prone, low wall next to him
    unit('BLUFOR', 'CHARLIE', 'TL', 7, 1, 'crouch'), // open, under fire
  ]);
  for (const x of s.soldiers) x.suppression = 60;
  s.soldiers[2].underFireUntilSec = 1000;
  const { state } = step(s, [], createRng(1));
  const [open, covered, underFire] = state.soldiers.map((x) => 60 - x.suppression);
  assert.ok(open > 0);
  assert.ok(covered > open);
  assert.ok(underFire < open);
});

test('firing gives the shooter away: the target side gets a suspected contact', () => {
  const s = duel(30);
  delete s.contacts.OPFOR[0]; // OPFOR has not seen the BLUFOR rifleman
  s.soldiers[1].ammo = 0;
  const { state, events } = step(s, [], createRng(3));
  const flash = events.find((e) => e.type === 'suspected' && e.side === 'OPFOR');
  assert.ok(flash, 'muzzle flash event');
  assert.equal(flash.reason, 'muzzle flash');
  assert.ok(state.contacts.OPFOR[0], 'OPFOR now knows something is there');
});

test('a soldier who just fired is much easier to spot', () => {
  // Same dug-in target, with and without having fired recently.
  const rows = grass(60, 3);
  rows[1] = '.'.repeat(49) + '-' + '.'.repeat(10);
  let quiet = 0;
  let firing = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const a = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 0, 1), unit('OPFOR', 'ALPHA', 'RFL', 50, 1, 'crouch')], seed);
    a.soldiers[1].ammo = 0;
    a.soldiers[0].ammo = 0;
    const b = structuredClone({ ...a, map: null, balance: null, weapons: null });
    Object.assign(b, { map: a.map, balance: a.balance, weapons: a.weapons });
    b.soldiers[1].lastFiredSec = 0;
    if (step(a, [], createRng(seed)).state.contacts.BLUFOR[1]) quiet++;
    if (step(b, [], createRng(seed)).state.contacts.BLUFOR[1]) firing++;
  }
  assert.ok(firing > quiet * 2, `quiet ${quiet}/200, just fired ${firing}/200`);
});

test('running out of ammo stops fire and is reported once', () => {
  const s = duel(20);
  s.soldiers[0].ammo = 3;
  s.soldiers[1].ammo = 0;
  const { state, events } = resolveTurn(s, []);
  assert.equal(state.soldiers[0].ammo, 0);
  assert.equal(events.filter((e) => e.type === 'out_of_ammo' && e.id === 0).length, 1);
});

test('combat is deterministic for the same seed', () => {
  const play = () => {
    let s = duel(25, [unit('BLUFOR', 'ALPHA', 'AR', 0, 3), unit('OPFOR', 'ALPHA', 'AR', 25, 3)]);
    const log = [];
    for (let i = 0; i < 3; i++) {
      const r = resolveTurn(s, []);
      s = r.state;
      log.push(r.events);
    }
    return { soldiers: s.soldiers, log };
  };
  assert.deepEqual(play(), play());
});
