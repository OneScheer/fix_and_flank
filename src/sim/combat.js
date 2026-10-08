// Fire: target numbers, dice, suppression and casualties. Fire into the next
// hex with an enemy in it is an assault instead (assault.js).
//
// A shooter rolls one d6 per soldier (fire.diceByRole: the AR rolls two)
// against a target number (TN): fire.baseTn plus modifiers for range, the
// cover of the target hex against fire from the shooter's hex, a target that
// is exposed, a suppressed shooter, and firing at a hex with no spotted
// enemy (suppressive fire). Clamped to fire.minTn .. fire.maxTn.
//
// Each die at or above the TN is a hit. On the fireteam in the hex (or the
// SL if he is alone there): 1 hit suppresses (pins if already suppressed),
// fire.pinHits or more pin. Each hit then rolls for a casualty against the
// target's directional cover (coverAgainst): a success removes a soldier in
// casualty order of its unit type. A unit with nobody left is eliminated.

import { coverAgainst, describeCover } from './cover.js';
import { rollD6 } from './dice.js';
import { distance, same } from './hex.js';
import { lineOfSight } from './los.js';
import { inBounds } from './map.js';
import { isSuppressed, unitType, unitsAt } from './state.js';

export function fireDice(balance, unit) {
  return unit.soldiers.reduce((n, role) => n + (balance.fire.diceByRole[role] ?? 1), 0);
}

// Range modifier for this shooter (its unit type's range bands), or null beyond the last band.
export function rangeMod(balance, range, shooter = { kind: 'team', type: null }) {
  return unitType(balance, shooter).range.find((b) => range <= b.upTo)?.mod ?? null;
}

// Everything about a shot before the dice: { ok, reason } or
// { ok: true, hex, range, dice, tn, rawTn, mods: [{ why, mod }], cover, aimed, target }.
// `target` is the unit that would be hit (it may be unseen: never show it
// to the shooter's side unless `aimed`). The preview and the sim both use
// this, so the odds shown are the odds rolled.
export function fireSolution(state, shooter, hex) {
  const { balance, map } = state;
  const f = balance.fire;
  if (!hex || !inBounds(map, hex)) return { ok: false, reason: 'off the map' };
  if (same(shooter.pos, hex)) return { ok: false, reason: 'cannot fire at its own hex' };
  const range = distance(shooter.pos, hex);
  const rmod = rangeMod(balance, range, shooter);
  const maxRange = unitType(balance, shooter).maxRangeHexes;
  if (range > maxRange || rmod === null) return { ok: false, reason: `out of range (${maxRange} hexes)` };
  const los = lineOfSight(map, balance, shooter.pos, hex);
  if (!los.clear) return { ok: false, reason: `no line of sight (${los.reason})` };
  const here = unitsAt(state, hex);
  if (here.some((u) => u.side === shooter.side)) return { ok: false, reason: 'friendly unit in that hex' };
  const enemies = here.filter((u) => u.side !== shooter.side);
  const target = enemies.find((u) => u.kind === 'team') ?? enemies[0] ?? null;
  const contacts = state.contacts?.[shooter.side] ?? {};
  const aimed = enemies.some((u) => contacts[u.id]?.level === 'spotted');

  const cover = coverAgainst(map, balance, hex, shooter.pos);
  const mods = [];
  if (rmod) mods.push({ why: `range ${range} hexes`, mod: rmod });
  const cmod = f.coverMod[String(cover.casualtyOn)] ?? 0;
  if (cmod) mods.push({ why: describeCover(cover), mod: cmod });
  if (aimed && target.exposed) mods.push({ why: 'target exposed', mod: f.exposedMod });
  if (isSuppressed(shooter)) mods.push({ why: 'shooter suppressed', mod: f.suppressedShooterMod });
  if (!aimed) mods.push({ why: 'no spotted enemy: suppressive fire', mod: f.blindMod });
  const rawTn = mods.reduce((t, m) => t + m.mod, f.baseTn);
  const tn = Math.min(f.maxTn, Math.max(f.minTn, rawTn));
  return { ok: true, hex: { ...hex }, range, dice: fireDice(balance, shooter), tn, rawTn, mods, cover, aimed, target: target?.id ?? null };
}

// Hits needed to pin a unit with this status.
export function pinAt(balance, status) {
  return isSuppressed({ status }) ? 1 : balance.fire.pinHits;
}

function removeSoldier(balance, unit) {
  const role = unitType(balance, unit).casualtyOrder.find((r) => unit.soldiers.includes(r)) ?? unit.soldiers[0];
  unit.soldiers.splice(unit.soldiers.indexOf(role), 1);
  return role;
}

// Roll the shot. Mutates the target in `state` (a fresh clone) and returns
// the 'fire' event with every die.
export function resolveFire(state, shooter, sol, rng) {
  const balance = state.balance;
  const dice = Array.from({ length: sol.dice }, () => rollD6(rng));
  const hits = dice.filter((d) => d >= sol.tn).length;
  const e = {
    type: 'fire', unit: shooter.id, from: { ...shooter.pos }, hex: sol.hex, aimed: sol.aimed, range: sol.range,
    tn: sol.tn, rawTn: sol.rawTn, mods: sol.mods, dice, hits,
    target: sol.target, casualtyOn: sol.cover.casualtyOn, cover: describeCover(sol.cover),
    casualtyRolls: [], lost: [], statusFrom: null, statusTo: null, eliminated: false,
  };
  const t = sol.target === null ? null : state.units[sol.target];
  if (!t || hits === 0) return e;
  e.statusFrom = t.status;
  t.status = hits >= pinAt(balance, t.status) ? 'pinned' : 'suppressed';
  for (let i = 0; i < hits; i++) {
    const roll = rollD6(rng);
    const kill = roll >= sol.cover.casualtyOn && t.soldiers.length > 0;
    e.casualtyRolls.push({ roll, kill });
    if (kill) e.lost.push(removeSoldier(balance, t));
  }
  if (t.soldiers.length === 0) {
    t.status = 'eliminated';
    e.eliminated = true;
  }
  e.statusTo = t.status;
  return e;
}
