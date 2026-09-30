// Fog of war and contact tracking.
//
// Each side keeps its own contact list: state.contacts[side][enemyId] =
//   { level: 'spotted' | 'suspected', pos: {x, y}, lastSeenSec }
// An enemy that is not in the list is unseen.
//
// Every tick, for each enemy not yet spotted, the side gets one seeded roll
// using the best chance among its soldiers with line of sight (more eyes do
// not stack), or spots it outright within autoSpotRangeM. A spotted enemy stays spotted, with its
// position tracked, while anyone on the side keeps line of sight. When
// sight is lost it becomes suspected at its last known position, and is
// forgotten after contactMemorySec. Contacts are shared across the side.
//
// Both sides use exactly these rules. Firing will also reveal the shooter
// (Milestone 4).

import { tileAt } from './map.js';
import { lineOfSight } from './los.js';

export function canObserve(soldier) {
  return soldier.status !== 'dead' && soldier.status !== 'down';
}

export function sidesOf(state) {
  return [...new Set(state.soldiers.map((s) => s.side))];
}

// Chance per second for `observer` to spot `target`, with the factors
// that produced it (for the preview and the after-action replay).
export function spotChance(state, observer, target, los, moving) {
  const { spotting } = state.balance;
  const tile = tileAt(state.map, target.pos.x, target.pos.y);
  const factors = {
    base: spotting.basePerSec,
    range: 1 / (1 + (los.rangeM / spotting.halfChanceRangeM) ** 2),
    stance: spotting.stanceFactor[target.stance],
    targetConcealment: spotting.targetConcealmentFactor[tile.concealment],
    concealmentBetween: Math.max(0, 1 - los.concealment),
    partialExposure: los.partial ? spotting.partialExposureFactor : 1,
    moving: moving ? spotting.movingFactor : 1,
  };
  const perSec = Math.min(1, Object.values(factors).reduce((a, b) => a * b, 1));
  const perTick = 1 - (1 - perSec) ** state.tickSec;
  return { perSec, perTick, factors };
}

// Seconds since the start of the game at the end of the current tick.
function endOfTickSec(state) {
  return state.turn * state.balance.turn.durationSec + (state.tick + 1) * state.tickSec;
}

// Update every side's contacts after movement. movedIds: soldiers that
// moved this tick. Mutates state (a fresh clone inside step) and pushes events.
export function updateContacts(state, movedIds, rng, events) {
  const { map, balance } = state;
  const now = endOfTickSec(state);
  state.contacts ??= {};

  for (const side of sidesOf(state)) {
    const contacts = (state.contacts[side] ??= {});
    const observers = state.soldiers.filter((s) => s.side === side && canObserve(s));

    for (const enemy of state.soldiers) {
      if (enemy.side === side) continue;
      const current = contacts[enemy.id];
      if (enemy.status === 'dead') {
        if (current) delete contacts[enemy.id];
        continue;
      }

      let tracking = false;
      let spottedBy = null;
      let best = null;
      for (const o of observers) {
        const los = lineOfSight(map, balance, o, enemy);
        if (!los.clear) continue;
        if (current?.level === 'spotted') {
          tracking = true;
          break;
        }
        if (los.rangeM <= balance.spotting.autoSpotRangeM) {
          spottedBy = o;
          break;
        }
        const chance = spotChance(state, o, enemy, los, movedIds.has(enemy.id)).perTick;
        if (!best || chance > best.chance) best = { observer: o, chance };
      }
      if (!tracking && !spottedBy && best && rng.chance(best.chance)) spottedBy = best.observer;

      if (tracking) {
        current.pos = { ...enemy.pos };
        current.lastSeenSec = now;
      } else if (spottedBy) {
        contacts[enemy.id] = { level: 'spotted', pos: { ...enemy.pos }, lastSeenSec: now };
        events.push({ type: 'spotted', side, id: enemy.id, by: spottedBy.id, pos: { ...enemy.pos } });
      } else if (current?.level === 'spotted') {
        current.level = 'suspected';
        events.push({ type: 'lost', side, id: enemy.id, pos: { ...current.pos } });
      } else if (current?.level === 'suspected' && now - current.lastSeenSec >= balance.spotting.contactMemorySec) {
        delete contacts[enemy.id];
        events.push({ type: 'contact_expired', side, id: enemy.id, pos: { ...current.pos } });
      }
    }
  }
}
