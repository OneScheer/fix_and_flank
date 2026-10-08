// Actions and the step function. One action is one unit's order in a phase.
//
// { type: 'move', unit, to: {col, row} }           1 hex
// { type: 'fastMove', unit, path: [{col, row}, ...] }  up to fastMoveHexes;
//                                                   entering rough terrain ends it
// { type: 'fire', unit, target: {col, row} }      fire at a hex (see combat.js)
//   A move or fire order into the next hex with an enemy in it is an
//   assault (see assault.js).
// { type: 'pass', unit }                           holds
//
// Only the current phase's side acts, and only with the phase's actions
// (see phases.js). Suppressed and pinned teams cannot move. Stacking: one
// fireteam per hex, plus the squad leader. A side gives orders to all its
// units and commits them (see orders.js); when nobody is left to act, the
// next phase starts.

import { assaultSolution, assaultVia, resolveAssault } from './assault.js';
import { fireSolution, resolveFire } from './combat.js';
import { adjacent, key, neighbors } from './hex.js';
import { inBounds, terrainName, terrainOf } from './map.js';
import { eliminationResult, endGame } from './mission.js';
import { advance } from './phases.js';
import { updateContacts } from './spotting.js';
import { canActivate, cloneState, currentPhase, isActive, isSuppressed, mayFire, unitsAt } from './state.js';

export const ACTION_TYPES = ['move', 'fastMove', 'fire', 'pass'];
const ACTION_NAMES = { move: 'moving', fastMove: 'fast moving', fire: 'firing' };

function enterable(state, h, unit) {
  if (!inBounds(state.map, h)) return 'off the map';
  if (terrainOf(state.map, state.balance, h).move === 'impassable') return `${terrainName(state.map, h)} is impassable`;
  const others = unitsAt(state, h).filter((u) => u.id !== unit.id);
  if (others.some((u) => u.side !== unit.side)) return 'enemy in that hex: an assault is a 1-hex move';
  if (others.some((u) => u.kind === unit.kind)) {
    return unit.kind === 'leader' ? 'hex already holds a leader' : 'hex already holds a friendly team';
  }
  return null;
}

// { ok, reason } for an action in the current state.
export function validateAction(state, action) {
  if (!ACTION_TYPES.includes(action?.type)) return { ok: false, reason: `unknown action '${action?.type}'` };
  const unit = state.units[action.unit];
  if (!unit) return { ok: false, reason: 'no such unit' };
  if (state.result) return { ok: false, reason: 'the mission is over' };
  const phase = currentPhase(state);
  if (unit.side !== phase.side) return { ok: false, reason: `it is the ${phase.name} phase (${phase.side})` };
  if (!isActive(unit)) return { ok: false, reason: `${unit.team} is eliminated` };
  if (unit.activated) return { ok: false, reason: `${unit.team} has already acted in this phase` };
  if (action.type === 'pass') return { ok: true };
  if (!(phase.actions ?? []).includes(action.type)) return { ok: false, reason: `no ${ACTION_NAMES[action.type]} in the ${phase.name} phase` };

  const via = assaultVia(state, action);
  if (via === 'move' && isSuppressed(unit)) return { ok: false, reason: `${unit.team} is ${unit.status} and cannot move` };
  if (via === 'fire') {
    const may = mayFire(unit);
    if (!may.ok) return may;
  }
  if (via) {
    const sol = assaultSolution(state, unit, via === 'move' ? action.to : action.target);
    return sol.ok ? { ok: true } : { ok: false, reason: sol.reason };
  }
  if (action.type === 'fire') {
    const may = mayFire(unit);
    if (!may.ok) return may;
    const sol = fireSolution(state, unit, action.target);
    return sol.ok ? { ok: true } : { ok: false, reason: sol.reason };
  }
  if (isSuppressed(unit)) return { ok: false, reason: `${unit.team} is ${unit.status} and cannot move` };
  const path = action.type === 'move' ? [action.to] : action.path;
  if (!Array.isArray(path) || path.length === 0) return { ok: false, reason: 'no destination' };
  if (action.type === 'move' && path.length !== 1) return { ok: false, reason: 'a move is one hex' };
  const max = state.balance.movement.fastMoveHexes;
  if (path.length > max) return { ok: false, reason: `a fast move is at most ${max} hexes` };
  let from = unit.pos;
  for (const [i, h] of path.entries()) {
    if (!inBounds(state.map, h) || !adjacent(from, h)) return { ok: false, reason: `${key(h)} is not next to ${key(from)}` };
    const why = enterable(state, h, unit);
    if (why) return { ok: false, reason: why };
    const rough = terrainOf(state.map, state.balance, h).move === 'rough';
    if (action.type === 'fastMove' && rough && i < path.length - 1) {
      return { ok: false, reason: `entering ${terrainName(state.map, h)} ends a fast move` };
    }
    from = h;
  }
  return { ok: true };
}

// Hexes a unit can move to (1 hex) and fast move to (key -> path).
export function moveOptions(state, unit) {
  const moves = [];
  const fast = new Map();
  if (!canActivate(state, unit)) return { moves, fast };
  const ok = (path, type) => validateAction(state, type === 'move'
    ? { type, unit: unit.id, to: path[0] } : { type, unit: unit.id, path }).ok;
  const frontier = [[]];
  while (frontier.length) {
    const path = frontier.shift();
    const from = path.length ? path[path.length - 1] : unit.pos;
    if (path.length >= state.balance.movement.fastMoveHexes) continue;
    for (const n of neighborsInBounds(state, from)) {
      if (path.some((p) => p.col === n.col && p.row === n.row) || (n.col === unit.pos.col && n.row === unit.pos.row)) continue;
      const next = [...path, n];
      if (!ok(next, 'fastMove')) continue;
      if (path.length === 0 && ok(next, 'move')) moves.push(n);
      if (!fast.has(key(n))) fast.set(key(n), next);
      frontier.push(next);
    }
  }
  return { moves, fast };
}

function neighborsInBounds(state, h) {
  return neighbors(h).filter((n) => inBounds(state.map, n));
}

// Resolve one action. Returns { state, events }; an invalid action leaves the
// state unchanged (the activation is not used) and reports why.
export function applyAction(state, action, rng) {
  const check = validateAction(state, action);
  if (!check.ok) return { state, events: [{ type: 'rejected', action, reason: check.reason }] };
  const next = cloneState(state);
  const unit = next.units[action.unit];
  const events = [{ type: 'activated', unit: unit.id, side: unit.side, turn: next.turn, phase: currentPhase(next).name, action: action.type }];

  const via = assaultVia(next, action);
  if (via) {
    const sol = assaultSolution(next, unit, via === 'move' ? action.to : action.target);
    if (via === 'move') unit.moved = true;
    if (via === 'fire') unit.fired = true;
    events.push(...resolveAssault(next, unit, sol, via, rng));
  } else if (action.type === 'move' || action.type === 'fastMove') {
    const path = action.type === 'move' ? [action.to] : action.path;
    for (const h of path) {
      events.push({ type: 'moved', unit: unit.id, from: { ...unit.pos }, to: { col: h.col, row: h.row } });
      unit.pos = { col: h.col, row: h.row };
    }
    unit.moved = true;
    if (action.type === 'fastMove') unit.exposed = true;
  }
  if (!via && action.type === 'fire') {
    events.push(resolveFire(next, unit, fireSolution(next, unit, action.target), rng));
    unit.fired = true;
  }
  unit.activated = true;
  updateContacts(next, events);
  const over = eliminationResult(next);
  if (over) endGame(next, over, events);
  advance(next, rng, events);
  updateContacts(next, events);
  next.rngState = rng.getState();
  return { state: next, events };
}

// Go on from a phase in which nobody can act (all eliminated or pinned, say).
export function skipPhase(state, rng) {
  const next = cloneState(state);
  const events = [];
  advance(next, rng, events);
  updateContacts(next, events);
  next.rngState = rng.getState();
  return { state: next, events };
}
