// Plain-words preview of a planned action and log lines for events. No DOM.
// The preview uses the same validation and odds the sim uses.

import { validateAction } from '../sim/actions.js';
import { chanceAtLeast } from '../sim/dice.js';
import { key } from '../sim/hex.js';
import { terrainName } from '../sim/map.js';
import { betterStatus } from '../sim/state.js';

const pct = (p) => `${Math.round(p * 100)}%`;
const inSix = (need) => `${7 - Math.min(6, Math.max(1, need))} in 6`;

export function unitName(u) {
  return `${u.side} ${u.team}`;
}

// One line saying what the action will do, or why it cannot be done.
export function previewAction(state, action) {
  const check = validateAction(state, action);
  const u = state.units[action.unit];
  if (!check.ok) return `${u.team}: cannot do that, ${check.reason}.`;
  const where = (h) => `${key(h)} (${terrainName(state.map, h)})`;
  switch (action.type) {
    case 'move':
      return `${u.team} moves 1 hex to ${where(action.to)}.`;
    case 'fastMove': {
      const end = action.path[action.path.length - 1];
      return `${u.team} fast moves ${action.path.length} hex${action.path.length > 1 ? 'es' : ''} to ${where(end)}. Exposed until its next activation: easier to spot and to hit.`;
    }
    case 'rally': {
      const t = state.units[action.target];
      const need = state.balance.rally.succeedOn;
      return `${u.team} rallies ${t.team} (${t.status}): needs ${need}+ on a d6, ${inSix(need)} (${pct(chanceAtLeast(need))}). Success: ${t.team} becomes ${betterStatus(t.status)}.`;
    }
    case 'pass':
      return `${u.team} holds and passes this activation.`;
    default:
      return '';
  }
}

// Log line for an event, or null for events not worth a line.
export function eventText(state, e) {
  const u = e.unit !== undefined ? state.units[e.unit] : null;
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
    case 'turn_start':
      return `Turn ${e.turn}. ${e.side} has the initiative.`;
    case 'rejected':
      return `Not possible: ${e.reason}.`;
    default:
      return null;
  }
}

export function passText(state, e) {
  if (e.type !== 'activated' || e.action !== 'pass') return null;
  return `${unitName(state.units[e.unit])} passes.`;
}
