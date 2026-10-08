// Assault: close combat when a fireteam moves or fires into the next hex
// and an enemy is there.
//
// Both sides roll one d6 per soldier at the same time; each die at or above
// its side's TN removes an enemy soldier. The attacker's TN depends on the
// defender's status (assault.attackTn: pinned easiest), +1 if the attacker
// is suppressed. The defender's TN is assault.defendTn, better if it is dug
// in (its cover against the attacker's hex is assault.dugInFrom or more), +1
// if suppressed; a pinned defender cannot shoot back. Both clamped like fire.
//
// Outcome (assaultOutcome): if the defender is wiped out, or has fewer men
// left than the attacker, it is eliminated (with any other enemy in the hex:
// overrun) and the attacker takes the hex. Otherwise the attacker falls back
// pinned. An attacker with nobody left is eliminated.

import { coverAgainst, describeCover } from './cover.js';
import { rollD6 } from './dice.js';
import { distance } from './hex.js';
import { inBounds } from './map.js';
import { isActive, isSuppressed, unitType, unitsAt } from './state.js';

const clamp = (balance, tn) => Math.min(balance.fire.maxTn, Math.max(balance.fire.minTn, tn));

// Enemy units in hex h (as seen by the sim; adjacent enemies are always spotted).
export function enemiesAt(state, unit, h) {
  if (!h || !inBounds(state.map, h)) return [];
  return unitsAt(state, h).filter((u) => u.side !== unit.side && isActive(u));
}

// Would `action` (a move or a fire order) be an assault? Returns 'move', 'fire' or null.
export function assaultVia(state, action) {
  const unit = state.units[action?.unit];
  if (!unit) return null;
  const h = action.type === 'move' ? action.to : action.type === 'fire' ? action.target : null;
  if (!h || distance(unit.pos, h) !== 1 || !enemiesAt(state, unit, h).length) return null;
  return action.type;
}

// Everything before the dice: { ok, reason } or { ok: true, hex, defender,
// others, attackDice, attackBase, attackTn, attackMods, defendDice, defendTn,
// defendMods, cover, attackerMen, defenderMen }. The preview and the sim
// both use this, so the odds shown are the odds rolled.
export function assaultSolution(state, attacker, h) {
  const { balance, map } = state;
  const a = balance.assault;
  const enemies = enemiesAt(state, attacker, h);
  if (!enemies.length) return { ok: false, reason: 'no enemy there' };
  if (distance(attacker.pos, h) !== 1) return { ok: false, reason: 'an assault goes into the next hex' };
  if (attacker.kind !== 'team') return { ok: false, reason: 'only a fireteam can assault' };
  if (!unitType(balance, attacker).assault) return { ok: false, reason: `the ${unitType(balance, attacker).name} does not assault` };
  const defender = enemies.find((u) => u.kind === 'team') ?? enemies[0];
  const others = enemies.filter((u) => u.id !== defender.id).map((u) => u.id);

  const attackBase = a.attackTn[defender.status];
  const attackMods = [];
  let attackTn = attackBase;
  if (isSuppressed(attacker)) {
    attackMods.push({ why: 'attacker suppressed', mod: a.attackerSuppressedMod });
    attackTn += a.attackerSuppressedMod;
  }
  const cover = coverAgainst(map, balance, h, attacker.pos);
  const defendMods = [];
  let defendTn = a.defendTn;
  if (cover.casualtyOn >= a.dugInFrom) {
    defendMods.push({ why: `dug in (${describeCover(cover)})`, mod: a.dugInMod });
    defendTn += a.dugInMod;
  }
  if (defender.status === 'suppressed') {
    defendMods.push({ why: 'defender suppressed', mod: a.defenderSuppressedMod });
    defendTn += a.defenderSuppressedMod;
  }
  const pinned = defender.status === 'pinned';
  return {
    ok: true, hex: { ...h }, defender: defender.id, others,
    attackDice: attacker.soldiers.length, attackBase, attackTn: clamp(balance, attackTn), attackMods,
    defendDice: pinned ? 0 : defender.soldiers.length, defendTn: clamp(balance, defendTn), defendMods,
    cover, attackerMen: attacker.soldiers.length, defenderMen: defender.soldiers.length,
  };
}

// 'taken' | 'repulsed' | 'attacker destroyed' | 'both destroyed'
export function assaultOutcome(attackerLeft, defenderLeft) {
  if (attackerLeft === 0) return defenderLeft === 0 ? 'both destroyed' : 'attacker destroyed';
  return defenderLeft === 0 || defenderLeft < attackerLeft ? 'taken' : 'repulsed';
}

function removeSoldiers(balance, unit, n) {
  const lost = [];
  for (let i = 0; i < n && unit.soldiers.length; i++) {
    const role = unitType(balance, unit).casualtyOrder.find((r) => unit.soldiers.includes(r)) ?? unit.soldiers[0];
    unit.soldiers.splice(unit.soldiers.indexOf(role), 1);
    lost.push(role);
  }
  return lost;
}

// Roll the assault. Mutates `state` (a fresh clone) and returns its events:
// the 'assault' event, then a 'moved' event if the attacker takes the hex.
export function resolveAssault(state, attacker, sol, via, rng) {
  const balance = state.balance;
  const defender = state.units[sol.defender];
  const attackRolls = Array.from({ length: sol.attackDice }, () => rollD6(rng));
  const defendRolls = Array.from({ length: sol.defendDice }, () => rollD6(rng));
  const attackHits = attackRolls.filter((d) => d >= sol.attackTn).length;
  const defendHits = defendRolls.filter((d) => d >= sol.defendTn).length;
  const defenderLost = removeSoldiers(balance, defender, attackHits);
  const attackerLost = removeSoldiers(balance, attacker, defendHits);
  const result = assaultOutcome(attacker.soldiers.length, defender.soldiers.length);
  const e = {
    type: 'assault', unit: attacker.id, via, from: { ...attacker.pos }, hex: sol.hex, defender: defender.id,
    defenderStatus: defender.status, attackTn: sol.attackTn, defendTn: sol.defendTn,
    attackMods: sol.attackMods, defendMods: sol.defendMods, attackRolls, defendRolls,
    attackerLost, defenderLost, overrun: [], result,
  };
  const events = [e];
  if (result === 'taken' || result === 'both destroyed') {
    defender.status = 'eliminated';
    for (const id of sol.others) {
      state.units[id].status = 'eliminated';
      e.overrun.push(id);
    }
  }
  if (result === 'attacker destroyed' || result === 'both destroyed') attacker.status = 'eliminated';
  if (result === 'repulsed') attacker.status = 'pinned';
  if (result === 'taken') {
    events.push({ type: 'moved', unit: attacker.id, from: { ...attacker.pos }, to: { ...sol.hex } });
    attacker.pos = { ...sol.hex };
    attacker.moved = true;
  }
  return events;
}
