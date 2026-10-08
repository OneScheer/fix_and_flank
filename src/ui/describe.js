// Plain-words preview of a planned action and log lines for events. No DOM.
// The preview uses the same validation and odds the sim uses.

import { validateAction } from '../sim/actions.js';
import { chanceAtLeast } from '../sim/dice.js';
import { key } from '../sim/hex.js';
import { lineOfSight } from '../sim/los.js';
import { terrainName, terrainOf } from '../sim/map.js';
import { knownEnemies } from '../sim/spotting.js';
import { betterStatus } from '../sim/state.js';

const pct = (p) => `${Math.round(p * 100)}%`;
const inSix = (need) => `${7 - Math.min(6, Math.max(1, need))} in 6`;

export function unitName(u) {
  return `${u.side} ${u.team}`;
}

// Known enemies (spotted or suspected) that have line of sight to hex h.
function knownWatching(state, side, h) {
  return knownEnemies(state, side).filter((c) => lineOfSight(state.map, state.balance, c.pos, h).clear);
}

// Whether a unit ending its move on h will be seen, from what its side knows.
function exposureNote(state, u, h, fast) {
  const watching = knownWatching(state, u.side, h);
  const concealed = terrainOf(state.map, state.balance, h).concealing;
  if (!watching.length) {
    return concealed ? ' Ends in concealment.' : ' Ends in the open; no known enemy has line of sight.';
  }
  const who = watching.map((c) => `${c.level === 'spotted' ? 'enemy' : 'suspected enemy'} at ${key(c.pos)}`).join(', ');
  if (!concealed || fast) return ` Ends in view of ${who}: will be seen.`;
  return ` In line of sight of ${who}, but concealed: seen only if one is adjacent.`;
}

// One line saying what the action will do, or why it cannot be done.
export function previewAction(state, action) {
  const check = validateAction(state, action);
  const u = state.units[action.unit];
  if (!check.ok) return `${u.team}: cannot do that, ${check.reason}.`;
  const where = (h) => `${key(h)} (${terrainName(state.map, h)})`;
  switch (action.type) {
    case 'move':
      return `${u.team} moves 1 hex to ${where(action.to)}.${exposureNote(state, u, action.to, false)}`;
    case 'fastMove': {
      const end = action.path[action.path.length - 1];
      return `${u.team} fast moves ${action.path.length} hex${action.path.length > 1 ? 'es' : ''} to ${where(end)}. Exposed until its next activation: easier to spot and to hit.${exposureNote(state, u, end, true)}`;
    }
    case 'rally': {
      const t = state.units[action.target];
      const need = state.balance.rally.succeedOn;
      return `${u.team} rallies ${t.team} (${t.status}): needs ${need}+ on a d6, ${inSix(need)} (${pct(chanceAtLeast(need))}). Success: ${t.team} becomes ${betterStatus(t.status)}.`;
    }
    case 'pass':
      return `${u.team} holds.`;
    default:
      return '';
  }
}

// Log line for an event, or null for events not worth a line. With a viewer
// side, only what that side knows is told: its own units, enemies it has
// spotted, and its own contacts.
export function eventText(state, e, viewer = null) {
  const u = e.unit !== undefined ? state.units[e.unit] : null;
  if (viewer && ['spotted', 'lost', 'contact_dropped', 'contact_moved'].includes(e.type)) {
    if (e.side !== viewer) return null;
    const name = `${u.side} ${u.team}`;
    if (e.type === 'spotted') return `CONTACT: ${name} at ${key(e.pos)} (${e.why}), spotted by ${state.units[e.by].team}.`;
    if (e.type === 'lost') return `Lost sight of ${name}. Last seen at ${key(e.pos)}.`;
    if (e.type === 'contact_moved') return null;
    return `Suspected position at ${key(e.pos)} dropped (${e.why}).`;
  }
  if (viewer && u && u.side !== viewer) {
    // Enemy actions: only moves of an enemy the viewer can see.
    if (e.type !== 'moved' || state.contacts?.[viewer]?.[u.id]?.level !== 'spotted') return null;
  }
  switch (e.type) {
    case 'activated':
      return null;
    case 'moved':
      return `${unitName(u)} moves to ${key(e.to)}.`;
    case 'rally': {
      const t = state.units[e.target];
      return `${unitName(u)} rallies ${t.team}: rolled ${e.roll} (needed ${e.need}+). ${e.success ? `${t.team} is now ${e.to}.` : `${t.team} stays ${e.from}.`}`;
    }
    case 'recover':
      return `${unitName(u)} rolls ${e.roll} to recover (needs ${e.need}+): ${e.success ? `now ${e.to}` : `still ${e.from}`}.`;
    case 'turn_end':
      return `End of turn ${e.turn}.`;
    case 'side_start':
      return `${e.side} gives its orders.`;
    case 'turn_start':
      return `Turn ${e.turn}. ${e.side} has the initiative.`;
    case 'rejected':
      return `Not possible: ${e.reason}.`;
    default:
      return null;
  }
}

export function passText(state, e, viewer = null) {
  if (e.type !== 'activated' || e.action !== 'pass') return null;
  if (viewer && state.units[e.unit].side !== viewer) return null;
  return `${unitName(state.units[e.unit])} holds.`;
}
