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
// opts.dice: roll this many dice instead of the whole team (split fire);
// opts.split: add fire.splitMod to the TN.
export function fireSolution(state, shooter, hex, opts = {}) {
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
  if (opts.split && f.splitMod) mods.push({ why: 'split fire', mod: f.splitMod });
  const rawTn = mods.reduce((t, m) => t + m.mod, f.baseTn);
  const tn = Math.min(f.maxTn, Math.max(f.minTn, rawTn));
  return { ok: true, hex: { ...hex }, range, dice: opts.dice ?? fireDice(balance, shooter), tn, rawTn, mods, cover, aimed, target: target?.id ?? null };
}

// Split fire: a team of a side in fire.splitSides (OPFOR: the enemy's fire
// discipline, at the user's request; the player cannot) with no enemy in a
// hex next to it may divide its dice between two different hexes; the first
// target gets the larger half.
// Returns { ok, reason } or { ok: true, dice: [first, second] }.
export function splitFire(state, shooter, first, second) {
  if (!(state.balance.fire.splitSides ?? []).includes(shooter.side)) return { ok: false, reason: `${shooter.side} cannot split its fire` };
  const enemyNext = state.units.some((u) => u.side !== shooter.side && u.status !== 'eliminated' && distance(u.pos, shooter.pos) === 1);
  if (enemyNext) return { ok: false, reason: `${shooter.team} has an enemy next to it and cannot split its fire` };
  if (same(first, second)) return { ok: false, reason: 'split fire needs two different hexes' };
  const n = fireDice(state.balance, shooter);
  if (n < 2) return { ok: false, reason: `${shooter.team} has too few dice to split` };
  return { ok: true, dice: [Math.ceil(n / 2), Math.floor(n / 2)] };
}

// The solutions for a fire order: one target, or two for split fire.
export function fireSolutions(state, shooter, action) {
  if (!action.second) return [fireSolution(state, shooter, action.target)];
  const split = splitFire(state, shooter, action.target, action.second);
  if (!split.ok) return [split];
  return [action.target, action.second].map((h, i) => fireSolution(state, shooter, h, { dice: split.dice[i], split: true }));
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
