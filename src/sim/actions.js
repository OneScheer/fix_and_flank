// Actions and the step function. One action is one fireteam's activation.
//
// { type: 'move', unit, to: {col, row} }           1 hex
// { type: 'fastMove', unit, path: [{col, row}, ...] }  up to fastMoveHexes;
//                                                   entering rough terrain ends it
// { type: 'rally', unit, target }                 the SL rallies a suppressed or
//                                                   pinned friendly team within
//                                                   rally.rangeHexes: d6 >= succeedOn
//                                                   improves it one step
// { type: 'pass', unit }
//
// Suppressed and pinned teams cannot move. Stacking: one fireteam per hex,
// plus the squad leader. At the start of each turn every suppressed or
// pinned unit rolls to recover one step (status.recoverOn).
//
// Sides alternate: after an activation the other side acts if it has a team
// left that has not acted; otherwise the same side goes again. When nobody
// is left, the turn ends and a new one starts with the side that has the
// initiative.

import { rollD6 } from './dice.js';
import { adjacent, distance, key, neighbors } from './hex.js';
import { inBounds, terrainName, terrainOf } from './map.js';
import {
  betterStatus, canActivate, cloneState, firstSideToAct, isSuppressed, sidesWithActivations, unitsAt,
} from './state.js';

export const ACTION_TYPES = ['move', 'fastMove', 'rally', 'pass'];

function enterable(state, h, unit) {
  if (!inBounds(state.map, h)) return 'off the map';
  if (terrainOf(state.map, state.balance, h).move === 'impassable') return `${terrainName(state.map, h)} is impassable`;
  const others = unitsAt(state, h).filter((u) => u.id !== unit.id);
  if (others.some((u) => u.side !== unit.side)) return 'enemy in that hex (assault comes in a later milestone)';
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
  if (unit.side !== state.activeSide) return { ok: false, reason: `it is ${state.activeSide}'s activation` };
  if (!canActivate(state, unit)) return { ok: false, reason: `${unit.team} has already acted this turn` };
  if (action.type === 'pass') return { ok: true };

  if (action.type === 'rally') {
    if (unit.kind !== 'leader') return { ok: false, reason: 'only the squad leader can rally' };
    if (unit.status === 'pinned') return { ok: false, reason: `${unit.team} is pinned and cannot rally` };
    const target = state.units[action.target];
    if (!target || target.side !== unit.side || target.status === 'eliminated') return { ok: false, reason: 'no friendly team to rally there' };
    if (!isSuppressed(target)) return { ok: false, reason: `${target.team} is not suppressed` };
    const range = state.balance.rally.rangeHexes;
    if (distance(unit.pos, target.pos) > range) return { ok: false, reason: `${target.team} is more than ${range} hex away` };
    return { ok: true };
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
  if (isSuppressed(unit) || !canActivate(state, unit)) return { moves, fast };
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

// Friendly suppressed or pinned teams the SL could rally now.
export function rallyTargets(state, leader) {
  if (leader.kind !== 'leader') return [];
  return state.units.filter((t) => validateAction(state, { type: 'rally', unit: leader.id, target: t.id }).ok);
}

// Start of a turn: every suppressed or pinned unit rolls to recover a step.
function recoveryRolls(state, rng, events) {
  const need = state.balance.status.recoverOn;
  for (const u of state.units) {
    if (!isSuppressed(u)) continue;
    const roll = rollD6(rng);
    const success = roll >= need;
    const from = u.status;
    if (success) u.status = betterStatus(u.status);
    events.push({ type: 'recover', unit: u.id, roll, need, success, from, to: u.status });
  }
}

// After an activation: who acts next, or end the turn.
function advance(state, rng, events) {
  const other = state.balance.turn.initiative.find((s) => s !== state.activeSide);
  const left = sidesWithActivations(state);
  if (left.includes(other)) state.activeSide = other;
  else if (left.includes(state.activeSide)) {
    // same side again
  } else {
    events.push({ type: 'turn_end', turn: state.turn });
    state.turn += 1;
    for (const u of state.units) {
      u.activated = false;
      u.moved = false;
    }
    state.activeSide = firstSideToAct(state);
    events.push({ type: 'turn_start', turn: state.turn, side: state.activeSide });
    recoveryRolls(state, rng, events);
  }
}

// Resolve one action. Returns { state, events }; an invalid action leaves the
// state unchanged (the activation is not used) and reports why.
export function applyAction(state, action, rng) {
  const check = validateAction(state, action);
  if (!check.ok) return { state, events: [{ type: 'rejected', action, reason: check.reason }] };
  const next = cloneState(state);
  const unit = next.units[action.unit];
  const events = [{ type: 'activated', unit: unit.id, side: unit.side, turn: next.turn, action: action.type }];
  unit.exposed = false;

  if (action.type === 'move' || action.type === 'fastMove') {
    const path = action.type === 'move' ? [action.to] : action.path;
    for (const h of path) {
      events.push({ type: 'moved', unit: unit.id, from: { ...unit.pos }, to: { col: h.col, row: h.row } });
      unit.pos = { col: h.col, row: h.row };
    }
    unit.moved = true;
    if (action.type === 'fastMove') unit.exposed = true;
  }
  if (action.type === 'rally') {
    const target = next.units[action.target];
    const need = next.balance.rally.succeedOn;
    const roll = rollD6(rng);
    const success = roll >= need;
    const from = target.status;
    if (success) target.status = betterStatus(target.status);
    events.push({ type: 'rally', unit: unit.id, target: target.id, roll, need, success, from, to: target.status });
  }
  unit.activated = true;
  advance(next, rng, events);
  next.rngState = rng.getState();
  return { state: next, events };
}
