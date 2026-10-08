// Plain-words preview of a planned action and log lines for events. No DOM.
// The preview uses the same validation and odds the sim uses.

import { validateAction } from '../sim/actions.js';
import { assaultSolution, assaultVia } from '../sim/assault.js';
import { fireSolution, pinAt } from '../sim/combat.js';
import { chanceAtLeast } from '../sim/dice.js';
import { key } from '../sim/hex.js';
import { lineOfSight } from '../sim/los.js';
import { assaultOdds, fireOdds } from '../sim/odds.js';
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

// "4 base, +2 behind a parapet (SE side), +1 range 4 hexes"
function modText(f, sol) {
  return [`${f.baseTn} base`, ...sol.mods.map((m) => `${m.mod > 0 ? '+' : ''}${m.mod} ${m.why}`)].join(', ')
    + (sol.rawTn !== sol.tn ? `, ${sol.rawTn}+ capped at ${sol.tn}+` : '');
}

// The fire preview: dice, target number with its reasons, and the exact odds.
// On a hex with no spotted enemy nothing about who may be there is used
// beyond the map: the odds are for a full team that is not suppressed.
export function firePreview(state, u, h) {
  const sol = fireSolution(state, u, h);
  if (!sol.ok) return `${u.team}: cannot fire there, ${sol.reason}.`;
  const t = sol.aimed ? state.units[sol.target] : null;
  const odds = fireOdds({
    dice: sol.dice, tn: sol.tn, casualtyOn: sol.cover.casualtyOn,
    pinAt: pinAt(state.balance, t ? t.status : 'ok'), soldiers: t ? t.soldiers.length : state.balance.unit.roles.length,
  });
  const head = t
    ? `${u.team} fires on ${unitName(t)} at ${key(h)} (${terrainName(state.map, h)})`
    : `${u.team} puts suppressive fire on ${key(h)} (${terrainName(state.map, h)}), no spotted enemy there`;
  const ifThere = t ? '' : ' If a team is there:';
  return `${head}: ${sol.dice} dice, hit on ${sol.tn}+ (${modText(state.balance.fire, sol)}).${ifThere}`
    + ` ${pct(odds.anyHit)} at least one hit, ${pct(odds.pin)} to pin. Casualties on ${sol.cover.casualtyOn}+ (${describeCoverShort(sol)}), expected ${odds.expectedCasualties.toFixed(2)}.`;
}

function describeCoverShort(sol) {
  return sol.cover.source === 'hexside' ? `${sol.cover.feature} facing the shooter` : sol.cover.terrain;
}

const signed = (m) => `${m.mod > 0 ? '+' : ''}${m.mod} ${m.why}`;
const hitWord = (n) => `${n} hit${n === 1 ? '' : 's'}`;

// The assault preview: both sides' dice and target numbers, the exact
// chance to take the hex, and the expected losses.
export function assaultPreview(state, u, h) {
  const sol = assaultSolution(state, u, h);
  if (!sol.ok) return `${u.team}: cannot assault there, ${sol.reason}.`;
  const d = state.units[sol.defender];
  const o = assaultOdds(sol);
  const atk = [`defender ${d.status}`, ...sol.attackMods.map(signed)].join(', ');
  const def = sol.defendDice
    ? `${unitName(d)} ${sol.defendDice} dice, hit on ${sol.defendTn}+ (${[`${state.balance.assault.defendTn} base`, ...sol.defendMods.map(signed)].join(', ')}).`
    : `${unitName(d)} is pinned and cannot shoot back.`;
  const wiped = o.attackerDestroyed >= 0.005 ? ` ${pct(o.attackerDestroyed)} that ${u.team} is wiped out.` : '';
  return `${u.team} assaults ${unitName(d)} at ${key(h)} (${terrainName(state.map, h)}, ${d.status}): ${u.team} ${sol.attackDice} dice, hit on ${sol.attackTn}+ (${atk}); ${def}`
    + ` ${pct(o.take)} to take the hex; otherwise ${u.team} falls back pinned.${wiped}`
    + ` Expected losses: ${u.team} ${o.expectedAttackerLosses.toFixed(2)}, ${unitName(d)} ${o.expectedDefenderLosses.toFixed(2)}.`;
}

// One line saying what the action will do, or why it cannot be done.
export function previewAction(state, action) {
  const check = validateAction(state, action);
  const u = state.units[action.unit];
  if (!check.ok) return `${u.team}: cannot do that, ${check.reason}.`;
  const where = (h) => `${key(h)} (${terrainName(state.map, h)})`;
  if (assaultVia(state, action)) return assaultPreview(state, u, action.type === 'move' ? action.to : action.target);
  switch (action.type) {
    case 'move':
      return `${u.team} moves 1 hex to ${where(action.to)}.${exposureNote(state, u, action.to, false)}`;
    case 'fastMove': {
      const end = action.path[action.path.length - 1];
      return `${u.team} fast moves ${action.path.length} hex${action.path.length > 1 ? 'es' : ''} to ${where(end)}. Exposed until its next turn: easier to spot and to hit.${exposureNote(state, u, end, true)}`;
    }
    case 'fire':
      return firePreview(state, u, action.target);
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
  if (viewer && e.type === 'fire') return fireText(state, e, viewer);
  if (e.type === 'assault') return assaultText(state, e);
  if (viewer && u && u.side !== viewer) {
    // Enemy actions: only moves and recovery of an enemy the viewer can see.
    if (!['moved', 'recover'].includes(e.type) || state.contacts?.[viewer]?.[u.id]?.level !== 'spotted') return null;
  }
  switch (e.type) {
    case 'activated':
      return null;
    case 'moved':
      return `${unitName(u)} moves to ${key(e.to)}.`;
    case 'fire':
      return fireText(state, e, null);
    case 'rally':
      if (e.blocked) return `${unitName(u)} cannot rally: enemy adjacent, no SL with it. Still ${e.from}.`;
      if (e.auto) return `${unitName(u)} rallies with ${state.units[e.leader].team}: now ${e.to}.`;
      return `${unitName(u)} rolls ${e.roll} to rally (needs ${e.need}+, ${leaderNote(state, e)}): ${e.success ? `now ${e.to}` : `still ${e.from}`}.`;
    case 'recover':
      return `${unitName(u)} recovers instead of acting: now ${e.to}.`;
    case 'turn_end':
      return `End of turn ${e.turn}.`;
    case 'game_over':
      return `MISSION OVER: ${e.winner} wins. ${e.why.charAt(0).toUpperCase()}${e.why.slice(1)}.`;
    case 'turn_start':
      return `Turn ${e.turn}.`;
    case 'phase_start':
      return phaseText(e, viewer);
    case 'rejected':
      return `Not possible: ${e.reason}.`;
    default:
      return null;
  }
}

export function phaseLabel(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Whether the enemy has anyone able to act is not the viewer's to know.
function phaseText(e, viewer = null) {
  const label = `${phaseLabel(e.name)} phase (${e.side})`;
  return e.idle && (!viewer || viewer === e.side) ? `${label}: nobody can act.` : `${label}.`;
}

export function passText(state, e, viewer = null) {
  if (e.type !== 'activated' || e.action !== 'pass') return null;
  if (viewer && state.units[e.unit].side !== viewer) return null;
  return `${unitName(state.units[e.unit])} ${holdWord(state, e.phase)}.`;
}

// The fire line: always the dice; the effect only if the viewer can see the
// target (or it is the viewer's own unit). Enemy fire is told when it hits
// the viewer's units or the viewer can see the shooter.
export function fireText(state, e, viewer) {
  const shooter = state.units[e.unit];
  const target = e.target === null ? null : state.units[e.target];
  const known = (u) => !viewer || u.side === viewer || state.contacts?.[viewer]?.[u.id]?.level === 'spotted';
  const mine = !viewer || shooter.side === viewer;
  const atMe = target && viewer && target.side === viewer;
  if (!mine && !atMe && !known(shooter)) return null;
  const who = mine || known(shooter) ? unitName(shooter) : 'Unseen enemy';
  const kind = e.aimed ? 'fires on' : 'puts suppressive fire on';
  const dice = `needs ${e.tn}+, rolled ${e.dice.join(' ')}: ${e.hits ? `${e.hits} hit${e.hits > 1 ? 's' : ''}` : 'no hits'}`;
  let effect = '';
  if (e.hits && target && (e.aimed || known(target))) {
    const rolls = e.casualtyRolls.map((c) => c.roll).join(' ');
    const lost = e.lost.length ? `lost ${e.lost.join(', ')}` : 'no casualties';
    effect = e.eliminated
      ? ` ${unitName(target)} eliminated (casualty rolls ${rolls}, need ${e.casualtyOn}+ ${e.cover}).`
      : ` ${unitName(target)} ${e.statusTo}; casualty rolls ${rolls} (need ${e.casualtyOn}+, ${e.cover}): ${lost}.`;
  } else if (e.hits) {
    effect = ' No visible effect.';
  }
  return `${who} ${kind} ${key(e.hex)}: ${dice}.${effect}`;
}

const RESULT_TEXT = {
  taken: (a, d) => `${unitName(a)} takes the hex; ${unitName(d)} eliminated.`,
  repulsed: (a, d) => `${unitName(d)} holds; ${unitName(a)} falls back pinned.`,
  'attacker destroyed': (a, d) => `${unitName(a)} is wiped out; ${unitName(d)} holds.`,
  'both destroyed': (a, d) => `Both ${unitName(a)} and ${unitName(d)} are wiped out.`,
};

// Close combat is seen by both sides.
export function assaultText(state, e) {
  const a = state.units[e.unit];
  const d = state.units[e.defender];
  const hits = (rolls, tn) => rolls.filter((r) => r >= tn).length;
  const def = e.defendRolls.length
    ? `${unitName(d)} needs ${e.defendTn}+, rolled ${e.defendRolls.join(' ')} (${hitWord(hits(e.defendRolls, e.defendTn))})`
    : `${unitName(d)} pinned, cannot shoot back`;
  return `${unitName(a)} assaults ${unitName(d)} at ${key(e.hex)}: ${unitName(a)} needs ${e.attackTn}+, rolled ${e.attackRolls.join(' ')} (${hitWord(hits(e.attackRolls, e.attackTn))}); ${def}. ${assaultSummary(state, e)}`;
}

// Losses and the outcome of an assault, without the dice.
export function assaultSummary(state, e) {
  const a = state.units[e.unit];
  const d = state.units[e.defender];
  const lost = [e.defenderLost.length ? `${unitName(d)} lost ${e.defenderLost.join(', ')}` : null, e.attackerLost.length ? `${unitName(a)} lost ${e.attackerLost.join(', ')}` : null].filter(Boolean);
  const overrun = e.overrun.length ? ` Overrun: ${e.overrun.map((id) => unitName(state.units[id])).join(', ')}.` : '';
  return `${lost.length ? `${lost.join('; ')}. ` : ''}${RESULT_TEXT[e.result](a, d)}${overrun}`;
}

// What a fire did, as the viewer can know it, without the dice: "2 hits. OPFOR ALPHA pinned; ...".
export function fireSummary(state, e, viewer) {
  const line = fireText(state, e, viewer) ?? '';
  return line.replace(/^.*?rolled [\d ]+: /, '').replace(/^no hits/, 'No hits').replace(/^(\d+ hits?)/, (m) => m.charAt(0).toUpperCase() + m.slice(1));
}
