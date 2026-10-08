// Scripted enemy behavior. Reads the state and returns orders for the side
// whose phase it is, using only what that side knows: its own units, the map,
// and its contacts (state.contacts[side]); a spotted enemy's status and men
// are visible, an unseen one is not used at all. Same rules as the player:
// every order goes through validateAction.
//
// Each unit picks one mode per phase, in this order (numbers in balance.ai):
//   SUPPRESSED     suppressed or pinned: it spends the phase recovering (the
//                  enemy action phase does that), so no order.
//   COUNTER_FLANK  a spotted enemy team in the next hex and the assault odds
//                  are good (assaultTakeAtLeast): assault. Or, sometimes
//                  (counterattackChance), go for a weakened enemy team close
//                  by (suppressed, pinned, or fewer men): move toward it,
//                  assault when next to it and the odds are fair.
//   RETREAT        down to retreatAtSoldiers: move away from known enemies.
//   ENGAGED        a spotted enemy within openFireRange, or one that has
//                  fired (return fire, any range): aimed fire at the best
//                  target (expected casualties + pinWeight x pin chance).
//   REPOSITION     poor cover against the nearest known enemy: move to a
//                  next hex with goodCover that is not next to an enemy.
//   HOLD           otherwise: stay put and hold fire (firing gives it away).
//
// "Sometimes" uses its own RNG seeded from the state (seedSalt), so the AI
// is deterministic for a given state and never draws from the game's dice.

import { validateAction } from '../sim/actions.js';
import { assaultSolution } from '../sim/assault.js';
import { coverAgainst } from '../sim/cover.js';
import { fireSolution, pinAt } from '../sim/combat.js';
import { distance, key, neighbors } from '../sim/hex.js';
import { inBounds } from '../sim/map.js';
import { assaultOdds, fireOdds } from '../sim/odds.js';
import { projectOrders } from '../sim/orders.js';
import { createRng } from '../sim/rng.js';
import { knownEnemies } from '../sim/spotting.js';
import { canActivate, currentPhase, isSuppressed } from '../sim/state.js';

// What the side knows: [{ id, level, pos, unit? }]; `unit` only when spotted.
function contacts(state, side) {
  return knownEnemies(state, side).map((c) => (c.level === 'spotted' ? { ...c, unit: state.units[c.id] } : c));
}

const coverFrom = (state, h, from) => coverAgainst(state.map, state.balance, h, from).casualtyOn;
const nearest = (list, h) => list.reduce((best, c) => (!best || distance(c.pos, h) < distance(best.pos, h) ? c : best), null);

// Plain 1-hex moves the unit can make (not assaults).
function steps(state, u, known) {
  return neighbors(u.pos).filter((h) => inBounds(state.map, h)
    && !known.some((c) => c.level === 'spotted' && distance(c.pos, h) === 0)
    && validateAction(state, { type: 'move', unit: u.id, to: h }).ok);
}

function assaultOrder(state, u, target) {
  const sol = assaultSolution(state, u, target.pos);
  if (!sol.ok) return null;
  const action = isSuppressed(u) ? { type: 'fire', unit: u.id, target: { ...target.pos } } : { type: 'move', unit: u.id, to: { ...target.pos } };
  if (!validateAction(state, action).ok) return null;
  return { action, take: assaultOdds(sol).take };
}

function decide(state, u, roll) {
  const ai = state.balance.ai;
  if (isSuppressed(u)) return { mode: 'SUPPRESSED', action: null, why: `${u.status}: recovering` };
  const known = contacts(state, u.side);
  const spotted = known.filter((c) => c.unit);

  // Assault an enemy team in the next hex when the odds are good.
  if (u.kind === 'team') {
    let best = null;
    for (const c of spotted.filter((x) => distance(x.pos, u.pos) === 1)) {
      const o = assaultOrder(state, u, c);
      if (o && (!best || o.take > best.take)) best = o;
    }
    if (best && best.take >= ai.assaultTakeAtLeast) {
      return { mode: 'COUNTER_FLANK', action: best.action, why: `assault, ${Math.round(best.take * 100)}% to take the hex` };
    }
  }

  // Retreat when nearly wiped out.
  if (u.soldiers.length <= ai.retreatAtSoldiers && known.length) {
    const away = (h) => Math.min(...known.map((c) => distance(c.pos, h)));
    const here = away(u.pos);
    const best = steps(state, u, known).filter((h) => away(h) > here)
      .sort((a, b) => away(b) - away(a) || coverFrom(state, b, nearest(known, b).pos) - coverFrom(state, a, nearest(known, a).pos))[0];
    if (best) return { mode: 'RETREAT', action: { type: 'move', unit: u.id, to: best }, why: `${u.soldiers.length} left: falling back` };
  }

  // Sometimes counterattack a weakened enemy team close by.
  const weak = spotted.filter((c) => c.unit.kind === 'team' && distance(c.pos, u.pos) <= ai.counterattackRange
    && (isSuppressed(c.unit) || c.unit.soldiers.length < u.soldiers.length));
  if (u.kind === 'team' && u.status === 'ok' && u.soldiers.length >= ai.counterattackMinSoldiers && weak.length && roll < ai.counterattackChance) {
    const target = nearest(weak, u.pos);
    if (distance(target.pos, u.pos) === 1) {
      const o = assaultOrder(state, u, target);
      if (o && o.take >= ai.counterattackTakeAtLeast) {
        return { mode: 'COUNTER_FLANK', action: o.action, why: `counterattack, ${Math.round(o.take * 100)}% to take the hex` };
      }
    } else {
      const best = steps(state, u, known)
        .filter((h) => distance(h, target.pos) < distance(u.pos, target.pos))
        .sort((a, b) => distance(a, target.pos) - distance(b, target.pos) || coverFrom(state, b, target.pos) - coverFrom(state, a, target.pos))[0];
      if (best) return { mode: 'COUNTER_FLANK', action: { type: 'move', unit: u.id, to: best }, why: `counterattack toward ${key(target.pos)}` };
    }
  }

  // Fire on the best spotted target in range (not the next hex: that is an assault).
  let shot = null;
  for (const c of spotted) {
    const range = distance(c.pos, u.pos);
    if (range < 2 || (range > ai.openFireRange && !c.unit.fired)) continue; // return fire at any range
    const action = { type: 'fire', unit: u.id, target: { ...c.pos } };
    if (!validateAction(state, action).ok) continue;
    const sol = fireSolution(state, u, c.pos);
    if (!sol.aimed) continue;
    const t = state.units[sol.target];
    const o = fireOdds({ dice: sol.dice, tn: sol.tn, casualtyOn: sol.cover.casualtyOn, pinAt: pinAt(state.balance, t.status), soldiers: t.soldiers.length });
    const score = o.expectedCasualties + ai.pinWeight * o.pin;
    if (!shot || score > shot.score) shot = { action, score, tn: sol.tn, at: c.pos };
  }
  if (shot) return { mode: 'ENGAGED', action: shot.action, why: `fire on ${key(shot.at)}, hit on ${shot.tn}+` };

  // Get into cover against the nearest known enemy.
  const threat = nearest(known, u.pos);
  if (threat && coverFrom(state, u.pos, threat.pos) < ai.goodCover) {
    const best = steps(state, u, known)
      .filter((h) => !known.some((c) => distance(c.pos, h) <= 1) && coverFrom(state, h, threat.pos) >= ai.goodCover)
      .sort((a, b) => coverFrom(state, b, threat.pos) - coverFrom(state, a, threat.pos))[0];
    if (best) return { mode: 'REPOSITION', action: { type: 'move', unit: u.id, to: best }, why: `into cover at ${key(best)}` };
  }

  return { mode: 'HOLD', action: null, why: spotted.length ? 'holding fire: no target in range' : 'no target' };
}

// Every unit of the side with its mode, order (or null: holds) and reason.
export function planOrders(state, side) {
  const phase = currentPhase(state);
  if (phase.side !== side || !phase.actions) return [];
  const rng = createRng((state.rngState ^ state.balance.ai.seedSalt) >>> 0);
  const plan = [];
  for (const u of state.units) {
    if (u.side !== side || u.status === 'eliminated') continue;
    const roll = rng.next(); // one per unit, used or not, so units do not change each other's luck
    const p = projectOrders(state, plan.filter((x) => x.action).map((x) => x.action));
    const pu = p.units[u.id];
    if (!canActivate(p, pu)) {
      // At the start of the enemy action phase, only units that spent it recovering have acted.
      plan.push({ unit: u.id, mode: 'SUPPRESSED', action: null, why: `recovering (now ${u.status})` });
      continue;
    }
    const d = decide(p, pu, roll);
    if (d.action && !(phase.actions.includes(d.action.type) && validateAction(p, d.action).ok)) {
      plan.push({ unit: u.id, mode: 'HOLD', action: null, why: 'no valid order' });
      continue;
    }
    plan.push({ unit: u.id, ...d });
  }
  return plan;
}

// The side's orders for commitOrders(): units without one hold.
export function chooseOrders(state, side) {
  return planOrders(state, side).filter((x) => x.action).map((x) => x.action);
}
