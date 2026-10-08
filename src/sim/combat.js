// Hit chance, firing, suppression and damage.
//
// hit = base(weapon, range) x shooter stance x target stance x movement
//     x cover (directional) x suppression x wounded x optic x fire mode
// clamped to [minHit, maxHit]. Every factor is returned for the preview
// and the after-action replay.
//
// What a soldier shoots at depends on his team's order (soldier.task):
//   none / move / hold   fire at will: the spotted enemy with the best chance
//   fire                 aimed fire on one spotted contact (else fire at will)
//   overwatch            fire at will, but only inside the arc, more accurate
//   suppress             area fire at a point: needs a line of fire only,
//                        faster and less accurate, can hit exposed soldiers
//                        near the point, suppresses everyone near it
//   assault              fire on the move; close assault anyone within reach
//   grenade              the thrower throws (grenade.js)
// Fire within a tick is simultaneous: all actions are chosen from the state
// before anyone acts, then resolved in soldier id order.

import { coverFrom } from './cover.js';
import { canLaunch, launchGrenade, resolveGrenades } from './grenade.js';
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
// mode: a key of balance.orders.fireMode ('aimed', 'overwatch', 'suppress', 'suppressUnseen').
export function hitChance(state, shooter, target, { los, movement = 'still', mode = 'aimed' } = {}) {
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
    fireMode: balance.orders.fireMode[mode],
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

// Is `p` inside the overwatch arc of soldier s (centered on s -> toward)?
export function inArc(state, s, toward, p) {
  const a = Math.atan2(toward.y - s.pos.y, toward.x - s.pos.x);
  const b = Math.atan2(p.y - s.pos.y, p.x - s.pos.x);
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d <= (state.balance.orders.overwatch.arcDeg * Math.PI) / 360 + 1e-9;
}

// Best spotted target with line of sight: highest hit chance, then nearest, then lowest id.
// filter(enemy) can restrict the candidates (overwatch arc, a fire order's target).
export function chooseTarget(state, shooter, movement, { mode = 'aimed', filter = null } = {}) {
  const contacts = state.contacts[shooter.side] ?? {};
  let best = null;
  for (const enemy of state.soldiers) {
    if (enemy.side === shooter.side || contacts[enemy.id]?.level !== 'spotted') continue;
    if (enemy.status === 'down' || enemy.status === 'dead') continue;
    if (filter && !filter(enemy)) continue;
    const h = hitChance(state, shooter, enemy, { movement, mode });
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

// Rounds passing near soldiers suppress them, hit or miss. Soldiers of `side`
// at `center` take the full amount; within nearMissRadiusTiles they take less
// the further they are. Returns [{ id, amount }].
function applySuppression(state, side, center, amount, now) {
  const s = state.balance.suppression;
  const out = [];
  for (const e of state.soldiers) {
    if (e.side !== side || e.status === 'dead') continue;
    const d = Math.hypot(e.pos.x - center.x, e.pos.y - center.y);
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

// Area fire for a suppress task: where to aim, whether there is a line of
// fire, and which exposed enemy near the point (if any) the rounds can hit.
// Returns { aim, lof, reason, target, chance, factors, cover, rangeM }.
export function suppressShot(state, s, aim) {
  const { map, balance } = state;
  const o = balance.orders;
  const weapon = weaponOf(state, s);
  const lof = lineOfSight(map, balance, s, { pos: aim, stance: o.suppress.aimStance }, { ignoreConcealment: true });
  let reason = null;
  if (!lof.clear) reason = `no line of fire (${lof.reason})`;
  else if (lof.rangeM > weapon.maxRangeM) reason = 'out of range';
  const out = { aim, lof, reason, target: null, chance: 0, factors: null, cover: null, rangeM: lof.rangeM };
  if (reason) return out;
  let best = null;
  for (const e of state.soldiers) {
    if (e.side === s.side || e.status === 'down' || e.status === 'dead') continue;
    const d = Math.hypot(e.pos.x - aim.x, e.pos.y - aim.y);
    if (d > o.suppress.hitRadiusTiles) continue;
    const los = lineOfSight(map, balance, s, e, { ignoreConcealment: true });
    if (!los.clear) continue;
    if (!best || d < best.d) best = { e, d, los };
  }
  if (best) {
    const spotted = state.contacts[s.side]?.[best.e.id]?.level === 'spotted';
    const h = hitChance(state, s, best.e, { los: best.los, mode: spotted ? 'suppress' : 'suppressUnseen' });
    Object.assign(out, { target: best.e, chance: h.chance, factors: h.factors, cover: h.cover });
  }
  return out;
}

// Where a suppress task aims this tick: the contact's last known position if
// it has one, else the ordered tile. Uses only what the side knows.
export function suppressAim(state, s, task) {
  const known = task.target !== null && task.target !== undefined ? state.contacts[s.side]?.[task.target] : null;
  return known ? { ...known.pos } : { ...task.at };
}

// Close assault: the nearest enemy in reach with line of sight.
export function closeAssaultTarget(state, s) {
  const r = state.balance.orders.assault.rangeTiles;
  let best = null;
  for (const e of state.soldiers) {
    if (e.side === s.side || e.status === 'down' || e.status === 'dead') continue;
    const d = Math.hypot(e.pos.x - s.pos.x, e.pos.y - s.pos.y);
    if (d > r + 1e-9) continue;
    if (!lineOfSight(state.map, state.balance, s, e).clear) continue;
    if (!best || d < best.d) best = { e, d };
  }
  return best?.e ?? null;
}

// Kill chance of a close assault: base x the better of the target's status
// factor (pinned high, alert low) and its exposure from the attacker's side
// (1 - directional cover) x the attacker's own suppression. So it is high
// only on a pinned target or one caught from an open side.
export function assaultChance(state, s, target) {
  const a = state.balance.orders.assault;
  const c = state.balance.combat;
  const cover = coverFrom(state.map, state.balance, target, s.pos);
  const factors = {
    base: a.base,
    targetStatus: a.statusFactor[target.status] ?? a.statusFactor.active,
    exposure: 1 - cover.protection,
    suppression: c.suppressionAccuracy[suppressionLevel(state.balance, s)],
  };
  const chance = Math.min(c.maxHit,
    factors.base * Math.max(factors.targetStatus, factors.exposure) * factors.suppression);
  return { chance, factors, cover };
}

// One tick of fire. movedSpeed: Map soldier id -> speed for soldiers that moved this tick.
export function resolveFire(state, movedSpeed, rng, now, events) {
  const { balance, tickSec } = state;

  // Phase 1: everyone decides from the same picture of the battle.
  const actions = [];
  for (const s of state.soldiers) {
    s.fireCooldown = Math.max(0, s.fireCooldown - tickSec);
    if (s.status === 'down' || s.status === 'dead' || s.fireCooldown > 0) continue;
    const task = s.task;
    const movement = movedSpeed.get(s.id) ?? 'still';

    if (task?.type === 'grenade') {
      if (s.status !== 'pinned') actions.push({ kind: 'grenade', s });
      continue;
    }
    if (task?.type === 'assault') {
      const victim = closeAssaultTarget(state, s);
      if (victim) {
        actions.push({ kind: 'assault', s, target: victim, ...assaultChance(state, s, victim) });
        continue;
      }
    }
    if (s.ammo <= 0) continue;
    const rounds = Math.min(weaponOf(state, s).roundsPerBurst, s.ammo);

    if (task?.type === 'suppress') {
      const aim = suppressAim(state, s, task);
      task.at = aim;
      const shot = suppressShot(state, s, aim);
      if (shot.reason) {
        if (task.noFire !== shot.reason) events.push({ type: 'no_fire', id: s.id, reason: shot.reason, at: aim });
        task.noFire = shot.reason;
        continue;
      }
      task.noFire = null;
      actions.push({ kind: 'fire', mode: 'suppress', s, rounds, ...shot });
      continue;
    }

    let pick = null;
    if (task?.type === 'fire') {
      pick = chooseTarget(state, s, movement, { filter: (e) => e.id === task.target });
      pick ??= chooseTarget(state, s, movement);
    } else if (task?.type === 'overwatch') {
      pick = chooseTarget(state, s, movement, { mode: 'overwatch', filter: (e) => inArc(state, s, task.toward, e.pos) });
    } else {
      pick = chooseTarget(state, s, movement);
    }
    if (pick) actions.push({ kind: 'fire', mode: task?.type === 'overwatch' ? 'overwatch' : 'aimed', s, rounds, ...pick, aim: { ...pick.target.pos } });
  }

  // Phase 2: resolve in id order.
  for (const act of actions) {
    const { s } = act;
    if (act.kind === 'grenade') {
      const { at, kind } = s.task;
      const c = canLaunch(state, s, kind, at);
      s.task = null;
      if (!c.ok) {
        events.push({ type: 'order_failed', id: s.id, reason: c.reason });
        continue;
      }
      launchGrenade(state, s, kind, at, rng, now, events);
      s.fireCooldown = balance.grenade.throwSec;
      s.lastFiredSec = now;
      muzzleFlash(state, s, now, events);
      continue;
    }
    if (act.kind === 'assault') {
      const { target, chance } = act;
      const success = target.hp > 0 && rng.chance(chance);
      if (success) {
        target.hp = Math.max(0, target.hp - balance.orders.assault.damage);
        events.push({ type: 'hit', id: target.id, by: s.id, damage: balance.orders.assault.damage, hp: target.hp, cause: 'assault' });
      }
      events.push({
        type: 'assault', id: s.id, target: target.id, from: { ...s.pos }, at: { ...target.pos }, chance, success,
        factors: act.factors, cover: { protection: act.cover.protection, direction: act.cover.direction.name, tile: act.cover.tile },
      });
      s.fireCooldown = balance.orders.assault.intervalSec;
      s.lastFiredSec = now;
      muzzleFlash(state, s, now, events);
      continue;
    }

    const { target, rounds, chance, mode } = act;
    const weapon = weaponOf(state, s);
    s.ammo -= rounds;
    const pinned = suppressionLevel(balance, s) === 'pinned';
    const rate = (mode === 'suppress' ? balance.orders.suppress.rateFactor : 1) / (pinned ? balance.combat.pinnedFireRate : 1);
    s.fireCooldown = weapon.burstIntervalSec * rate;
    s.lastFiredSec = now;

    let hits = 0;
    for (let r = 0; r < rounds; r++) {
      if (!target || target.hp <= 0) break;
      if (rng.chance(chance)) {
        hits++;
        target.hp = Math.max(0, target.hp - weapon.damage);
        events.push({ type: 'hit', id: target.id, by: s.id, damage: weapon.damage, hp: target.hp });
      }
    }
    const enemySide = target?.side ?? state.soldiers.find((e) => e.side !== s.side)?.side;
    const center = mode === 'suppress' ? act.aim : target.pos;
    const suppressed = enemySide ? applySuppression(state, enemySide, center, rounds * weapon.suppressionPerRound, now) : [];
    events.push({
      type: 'fire',
      mode,
      id: s.id,
      target: target ? target.id : null,
      from: { ...s.pos },
      at: { ...(mode === 'suppress' ? act.aim : target.pos) },
      rounds,
      hits,
      chance,
      factors: act.factors,
      cover: act.cover ? { protection: act.cover.protection, direction: act.cover.direction.name, tile: act.cover.tile } : null,
      rangeM: act.rangeM,
      suppressed,
    });
    if (s.ammo === 0) events.push({ type: 'out_of_ammo', id: s.id });
    muzzleFlash(state, s, now, events);
  }

  resolveGrenades(state, rng, now, events);
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
