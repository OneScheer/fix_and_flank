// Plain-words preview of a planned action and log lines for events. No DOM.
// The preview uses the same validation and odds the sim uses.

import { validateAction } from '../sim/actions.js';
import { chanceAtLeast } from '../sim/dice.js';
import { key } from '../sim/hex.js';
import { lineOfSight } from '../sim/los.js';
import { terrainName, terrainOf } from '../sim/map.js';
import { rallyNeed } from '../sim/phases.js';
import { knownEnemies } from '../sim/spotting.js';
import { betterStatus, currentPhase, isSuppressed } from '../sim/state.js';

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

// "holds" where the phase allows moving, else "holds fire".
function holdWord(state, name = currentPhase(state).name) {
  const phase = state.balance.turn.phases.find((p) => p.name === name);
  return phase?.actions?.includes('move') ? 'holds' : 'holds fire';
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;

function leaderNote(state, r) {
  return r.leader === null ? 'no SL' : `${state.units[r.leader].team} ${plural(r.distance, 'hex')} away`;
}

// What the rally phase will do for a suppressed or pinned unit, or null.
export function rallyPreview(state, u) {
  if (!isSuppressed(u) || u.status === 'eliminated') return null;
  const r = rallyNeed(state, u);
  const to = betterStatus(u.status);
  if (r.auto) return `Rally phase: ${u.team} rallies to ${to} (${state.units[r.leader].team} is with it).`;
  if (r.blocked) return `Rally phase: ${u.team} cannot rally, enemy adjacent and no SL with it.`;
  return `Rally phase: ${u.team} needs ${r.need}+ on a d6 to become ${to}, ${inSix(r.need)} (${pct(chanceAtLeast(r.need))}; ${leaderNote(state, r)}).`;
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
    case 'pass':
      return `${u.team} ${holdWord(state)}.`;
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
    // Enemy actions: only moves and recovery of an enemy the viewer can see.
    if (!['moved', 'recover'].includes(e.type) || state.contacts?.[viewer]?.[u.id]?.level !== 'spotted') return null;
  }
  switch (e.type) {
    case 'activated':
      return null;
    case 'moved':
      return `${unitName(u)} moves to ${key(e.to)}.`;
    case 'rally':
      if (e.blocked) return `${unitName(u)} cannot rally: enemy adjacent, no SL with it. Still ${e.from}.`;
      if (e.auto) return `${unitName(u)} rallies with ${state.units[e.leader].team}: now ${e.to}.`;
      return `${unitName(u)} rolls ${e.roll} to rally (needs ${e.need}+, ${leaderNote(state, e)}): ${e.success ? `now ${e.to}` : `still ${e.from}`}.`;
    case 'recover':
      return `${unitName(u)} recovers instead of acting: now ${e.to}.`;
    case 'turn_end':
      return `End of turn ${e.turn}.`;
    case 'turn_start':
      return `Turn ${e.turn}.`;
    case 'phase_start':
      return phaseText(e);
    case 'rejected':
      return `Not possible: ${e.reason}.`;
    default:
      return null;
  }
}

export function phaseLabel(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function phaseText(e) {
  const label = `${phaseLabel(e.name)} phase (${e.side})`;
  return e.idle ? `${label}: nobody can act.` : `${label}.`;
}

export function passText(state, e, viewer = null) {
  if (e.type !== 'activated' || e.action !== 'pass') return null;
  if (viewer && state.units[e.unit].side !== viewer) return null;
  return `${unitName(state.units[e.unit])} ${holdWord(state, e.phase)}.`;
}
