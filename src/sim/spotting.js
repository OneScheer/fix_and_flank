// Fog of war on hexes. No dice: spotting follows fixed rules.
//
// Each side keeps its own contacts: state.contacts[side][enemyId] =
//   { level: 'spotted' | 'suspected', pos: {col, row}, turn }
// An enemy not in the list is unseen.
//
// An enemy is spotted when any unit of the side has line of sight to it and
// it is in terrain that does not conceal, or within vision.spotWithinHexes,
// or exposed (fast moved), or it fired this turn. Once spotted, an enemy
// stays spotted while it stays in that hex and a unit of the side still has
// line of sight to it (a known position: a dug-in team that gave itself away
// by firing stays marked). A spotted enemy that stops being spotted (it moved
// on while concealed, or sight was lost) becomes suspected at its last known hex. A suspected contact
// is dropped after vision.suspectedTurns turns, or when a unit of the side is
// within vision.spotWithinHexes of that hex (close enough to spot anyone
// there) and the enemy is not there.
//
// Both sides use exactly these rules. Contacts are updated after every action.

import { distance, same } from './hex.js';
import { lineOfSight } from './los.js';
import { terrainOf } from './map.js';

function observers(state, side) {
  return state.units.filter((u) => u.side === side && u.status !== 'eliminated');
}

// Why `enemy` can be spotted by `side` right now, or null: { by, why }.
export function spotReason(state, side, enemy) {
  const { map, balance } = state;
  if (enemy.status === 'eliminated') return null;
  const concealed = terrainOf(map, balance, enemy.pos).concealing;
  const current = state.contacts?.[side]?.[enemy.id];
  const stayedPut = current?.level === 'spotted' && same(current.pos, enemy.pos);
  let kept = null;
  for (const o of observers(state, side)) {
    const los = lineOfSight(map, balance, o.pos, enemy.pos);
    if (!los.clear) continue;
    if (!concealed) return { by: o.id, why: 'in the open' };
    if (distance(o.pos, enemy.pos) <= balance.vision.spotWithinHexes) return { by: o.id, why: 'close by' };
    if (enemy.exposed) return { by: o.id, why: 'moving fast' };
    if (enemy.fired) return { by: o.id, why: 'firing' };
    if (stayedPut) kept ??= { by: o.id, why: 'known position' };
  }
  return kept;
}

// Is a unit of `side` close enough to hex h to spot anyone there?
function checksHex(state, side, h) {
  return observers(state, side).some((o) => distance(o.pos, h) <= state.balance.vision.spotWithinHexes
    && lineOfSight(state.map, state.balance, o.pos, h).clear);
}

// Update every side's contacts. Mutates state (a fresh clone) and pushes events.
export function updateContacts(state, events) {
  state.contacts ??= {};
  for (const side of state.balance.turn.sides) {
    const contacts = (state.contacts[side] ??= {});
    for (const enemy of state.units) {
      if (enemy.side === side) continue;
      const current = contacts[enemy.id];
      if (enemy.status === 'eliminated') {
        if (current) delete contacts[enemy.id];
        continue;
      }
      const seen = spotReason(state, side, enemy);
      if (seen) {
        const isNew = current?.level !== 'spotted';
        const movedOn = current && !same(current.pos, enemy.pos);
        contacts[enemy.id] = { level: 'spotted', pos: { ...enemy.pos }, turn: state.turn };
        if (isNew) events.push({ type: 'spotted', side, unit: enemy.id, by: seen.by, why: seen.why, pos: { ...enemy.pos } });
        else if (movedOn) events.push({ type: 'contact_moved', side, unit: enemy.id, pos: { ...enemy.pos } });
      } else if (current?.level === 'spotted') {
        contacts[enemy.id] = { level: 'suspected', pos: { ...current.pos }, turn: state.turn };
        events.push({ type: 'lost', side, unit: enemy.id, pos: { ...current.pos } });
      } else if (current?.level === 'suspected') {
        const stale = state.turn - current.turn >= state.balance.vision.suspectedTurns;
        const clearedHex = !same(current.pos, enemy.pos) && checksHex(state, side, current.pos);
        if (stale || clearedHex) {
          delete contacts[enemy.id];
          events.push({ type: 'contact_dropped', side, unit: enemy.id, pos: { ...current.pos }, why: stale ? 'old' : 'hex is clear' });
        }
      }
    }
  }
}

// What `side` knows: [{ id, level, pos }].
export function knownEnemies(state, side) {
  return Object.entries(state.contacts?.[side] ?? {}).map(([id, c]) => ({ id: Number(id), ...c }));
}
