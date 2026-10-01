// Hit chance, firing, suppression and damage.
//
// hit = base(weapon, range) x shooter stance x target stance x movement
//     x cover (directional) x suppression x wounded x optic
// clamped to [minHit, maxHit]. Every factor is returned for the preview
// and the after-action replay.
//
// Until player fire orders exist (Milestone 5), every soldier fires at will
// at the best spotted target it has line of sight to. Fire within a tick is
// simultaneous: all shots are chosen from the state before anyone fires,
// then resolved in soldier id order.

import { coverFrom } from './cover.js';
import { tileAt, inBounds } from './map.js';
import { lineOfSight } from './los.js';
import { DIRS } from './path.js';

export function weaponOf(state, soldier) {
  return state.weapons.weapons[soldier.weapon];
}

// Linear interpolation over the weapon's [rangeM, hit] table; 0 beyond maxRangeM.
export function baseHit(weapon, rangeM) {
  if (rangeM > weapon.maxRangeM) return 0;
  const t = weapon.hitByRangeM;
  if (rangeM <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    const [r1, h1] = t[i];
    const [r0, h0] = t[i - 1];
    if (rangeM <= r1) return h0 + ((h1 - h0) * (rangeM - r0)) / (r1 - r0);
  }
  return t[t.length - 1][1];
}

// 'active' | 'shaken' | 'pinned' from the suppression value alone.
export function suppressionLevel(balance, soldier) {
  const s = balance.suppression;
  if (soldier.suppression >= s.pinned) return 'pinned';
  if (soldier.suppression >= s.shaken) return 'shaken';
  return 'active';
}

// Status from hp first, then suppression, then wounds.
export function deriveStatus(balance, soldier) {
  if (soldier.hp <= 0) return 'dead';
  if (soldier.hp <= balance.health.downAtHp) return 'down';
  const level = suppressionLevel(balance, soldier);
  if (level !== 'active') return level;
  if (soldier.hp < balance.soldier.hp) return 'wounded';
  return 'active';
}

export function canFire(soldier) {
  return soldier.status !== 'down' && soldier.status !== 'dead' && soldier.ammo > 0;
}

// movement: 'still' | 'walk' | 'run' | 'crawl' (how the shooter moved this tick).
export function hitChance(state, shooter, target, { los, movement = 'still' } = {}) {
  const { balance, map } = state;
  const c = balance.combat;
  const weapon = weaponOf(state, shooter);
  const sight = los ?? lineOfSight(map, balance, shooter, target);
  const cover = coverFrom(map, balance, target, shooter.pos);
  const factors = {
    base: baseHit(weapon, sight.rangeM),
    shooterStance: c.shooterStance[shooter.stance],
    targetStance: c.targetStance[target.stance],
    movement: c.movement[movement],
    cover: 1 - cover.protection,
    suppression: c.suppressionAccuracy[suppressionLevel(balance, shooter)],
    wounded: shooter.hp < balance.soldier.hp ? c.woundedAccuracy : 1,
    optic: weapon.opticFactor,
  };
  let chance = 0;
  let reason = null;
  if (!sight.clear) reason = `no line of sight (${sight.reason})`;
  else if (factors.base === 0) reason = 'out of range';
  else if (factors.movement === 0) reason = `cannot fire while moving at a ${movement}`;
  else {
    const product = Object.values(factors).reduce((a, b) => a * b, 1);
    chance = Math.min(c.maxHit, Math.max(c.minHit, product));
  }
  return { chance, factors, cover, rangeM: sight.rangeM, reason };
}

// Best spotted target with line of sight: highest hit chance, then nearest, then lowest id.
export function chooseTarget(state, shooter, movement) {
  const contacts = state.contacts[shooter.side] ?? {};
  let best = null;
  for (const enemy of state.soldiers) {
    if (enemy.side === shooter.side || contacts[enemy.id]?.level !== 'spotted') continue;
    if (enemy.status === 'down' || enemy.status === 'dead') continue;
    const h = hitChance(state, shooter, enemy, { movement });
    if (h.chance <= 0) continue;
    if (!best || h.chance > best.chance || (h.chance === best.chance && h.rangeM < best.rangeM)) {
      best = { target: enemy, ...h };
    }
  }
  return best;
}

// A soldier counts as in cover for suppression recovery if its own tile has
// cover or a low or high obstacle with cover stands next to it.
export function inCover(state, soldier) {
  const { map } = state;
  if (tileAt(map, soldier.pos.x, soldier.pos.y).cover !== 'none') return true;
  return DIRS.some(([dx, dy]) => {
    const x = soldier.pos.x + dx;
    const y = soldier.pos.y + dy;
    if (!inBounds(map, x, y)) return false;
    const t = tileAt(map, x, y);
    return t.height > 0 && t.cover !== 'none';
  });
}

// Rounds passing near soldiers suppress them, hit or miss. The target takes
// the full amount; others on its side within nearMissRadiusTiles take less
// the further they are. Returns [{ id, amount }].
function applySuppression(state, target, amount, now) {
  const s = state.balance.suppression;
  const out = [];
  for (const e of state.soldiers) {
    if (e.side !== target.side || e.status === 'dead') continue;
    const d = Math.hypot(e.pos.x - target.pos.x, e.pos.y - target.pos.y);
    if (d > s.nearMissRadiusTiles) continue;
    const add = amount * (1 - d / (s.nearMissRadiusTiles + 1));
    e.suppression = Math.min(s.max, e.suppression + add);
    e.underFireUntilSec = now + s.underFireSec;
    out.push({ id: e.id, amount: add });
  }
  return out;
}

// Muzzle flash: every enemy side with a soldier within muzzleFlashRangeM
// learns roughly where the shooter is (suspected), unless already spotted.
function muzzleFlash(state, shooter, now, events) {
  const range = state.balance.combat.muzzleFlashRangeM / state.balance.map.tileMeters;
  for (const side of Object.keys(state.contacts)) {
    if (side === shooter.side) continue;
    const near = state.soldiers.some((o) => o.side === side && o.status !== 'dead' && o.status !== 'down'
      && Math.hypot(o.pos.x - shooter.pos.x, o.pos.y - shooter.pos.y) <= range);
    if (!near) continue;
    const c = state.contacts[side][shooter.id];
    if (c?.level === 'spotted') continue;
    const moved = !c || c.pos.x !== shooter.pos.x || c.pos.y !== shooter.pos.y;
    state.contacts[side][shooter.id] = { level: 'suspected', pos: { ...shooter.pos }, lastSeenSec: now };
    if (moved) events.push({ type: 'suspected', side, id: shooter.id, pos: { ...shooter.pos }, reason: 'muzzle flash' });
  }
}

// One tick of fire. movedSpeed: Map soldier id -> speed for soldiers that moved this tick.
export function resolveFire(state, movedSpeed, rng, now, events) {
  const { balance, tickSec } = state;

  // Phase 1: everyone picks a target from the same picture of the battle.
  const shots = [];
  for (const s of state.soldiers) {
    s.fireCooldown = Math.max(0, s.fireCooldown - tickSec);
    if (!canFire(s) || s.fireCooldown > 0) continue;
    const movement = movedSpeed.get(s.id) ?? 'still';
    const pick = chooseTarget(state, s, movement);
    if (!pick) continue;
    shots.push({ shooter: s, ...pick, rounds: Math.min(weaponOf(state, s).roundsPerBurst, s.ammo) });
  }

  // Phase 2: resolve in id order.
  for (const shot of shots) {
    const { shooter, target, rounds, chance } = shot;
    const weapon = weaponOf(state, shooter);
    shooter.ammo -= rounds;
    const pinned = suppressionLevel(balance, shooter) === 'pinned';
    shooter.fireCooldown = weapon.burstIntervalSec / (pinned ? balance.combat.pinnedFireRate : 1);
    shooter.lastFiredSec = now;

    let hits = 0;
    for (let r = 0; r < rounds; r++) {
      if (target.hp <= 0) break;
      if (rng.chance(chance)) {
        hits++;
        target.hp = Math.max(0, target.hp - weapon.damage);
        events.push({ type: 'hit', id: target.id, by: shooter.id, damage: weapon.damage, hp: target.hp });
      }
    }
    const suppressed = applySuppression(state, target, rounds * weapon.suppressionPerRound, now);
    events.push({
      type: 'fire',
      id: shooter.id,
      target: target.id,
      from: { ...shooter.pos },
      at: { ...target.pos },
      rounds,
      hits,
      chance,
      factors: shot.factors,
      cover: { protection: shot.cover.protection, direction: shot.cover.direction.name, tile: shot.cover.tile },
      rangeM: shot.rangeM,
      suppressed,
    });
    if (shooter.ammo === 0) events.push({ type: 'out_of_ammo', id: shooter.id });
    muzzleFlash(state, shooter, now, events);
  }
}

// Suppression recovery and status changes, after fire.
export function updateStatus(state, now, events) {
  const { balance, tickSec } = state;
  const s = balance.suppression;
  for (const soldier of state.soldiers) {
    if (soldier.status === 'dead') continue;
    let rate = s.decayPerSec;
    if (soldier.stance === 'prone') rate *= s.proneDecayFactor;
    if (inCover(state, soldier)) rate *= s.coverDecayFactor;
    if (soldier.underFireUntilSec !== null && now < soldier.underFireUntilSec) rate *= s.underFireDecayFactor;
    soldier.suppression = Math.max(0, soldier.suppression - rate * tickSec);

    const status = deriveStatus(balance, soldier);
    if (status === soldier.status) continue;
    const was = soldier.status;
    events.push({ type: 'status', id: soldier.id, from: was, to: status });
    soldier.status = status;
    // Back up from pinned with a move order still running: carry on in the move's stance.
    if (was === 'pinned' && status !== 'down' && status !== 'dead' && soldier.move) {
      const stance = balance.movement.stanceForSpeed[soldier.move.speed];
      if (stance !== soldier.stance) {
        events.push({ type: 'stance', id: soldier.id, from: soldier.stance, to: stance });
        soldier.stance = stance;
      }
    }
    if (status === 'dead') events.push({ type: 'killed', id: soldier.id, pos: { ...soldier.pos } });
    if (status === 'down' || status === 'dead') soldier.move = null;
    // Pinned soldiers go to ground and will not expose themselves.
    if ((status === 'pinned' || status === 'down') && soldier.stance !== 'prone') {
      events.push({ type: 'stance', id: soldier.id, from: soldier.stance, to: 'prone' });
      soldier.stance = 'prone';
    }
  }
}
