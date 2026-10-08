// Orders for a whole side in one phase. In each phase the side gives one
// order to every unit that can act, then commits them all; they are carried
// out in the order given, each with its own dice. A unit without an order
// holds (passes). An order that has become impossible by the time it runs
// (a hex got taken) is skipped with the reason, and that unit holds.

import { applyAction, skipPhase, validateAction } from './actions.js';
import { assaultVia } from './assault.js';
import { canActivate, cloneState } from './state.js';

// Carry out `actions` (in order) in the current phase, then make every unit
// without an order hold, which ends the phase. Returns { state, events }.
// `onStep(state, events)`, if given, is told the state after each step, so a
// UI can play the commit back one order at a time.
export function commitOrders(state, actions, rng, onStep = null) {
  const same = (s) => s.turn === state.turn && s.phase === state.phase;
  let current = state;
  const events = [];
  for (const action of actions) {
    if (!same(current)) break;
    const r = applyAction(current, action, rng);
    current = r.state;
    events.push(...r.events);
    onStep?.(current, r.events);
  }
  while (same(current)) {
    const idle = current.units.find((u) => canActivate(current, u));
    const r = idle ? applyAction(current, { type: 'pass', unit: idle.id }, rng) : skipPhase(current, rng);
    current = r.state;
    events.push(...r.events);
    onStep?.(current, r.events);
    if (!idle) break;
  }
  return { state: current, events };
}

// Planning: where things will be if the earlier orders go as planned. Moves
// are applied; dice orders (fire, assault) only mark the unit as having
// acted, since their result is not known yet. Never ends the phase, never rolls.
export function projectOrders(state, actions) {
  let s = state;
  for (const a of actions) {
    if (!validateAction(s, a).ok) continue;
    s = cloneState(s);
    const u = s.units[a.unit];
    if (assaultVia(s, a)) { // the result is not known: the team stays where it is
      if (a.type === 'move') u.moved = true;
      u.activated = true;
      continue;
    }
    if (a.type === 'move') u.pos = { ...a.to };
    if (a.type === 'fastMove') u.pos = { ...a.path[a.path.length - 1] };
    if (a.type === 'move' || a.type === 'fastMove') u.moved = true;
    if (a.type === 'fastMove') u.exposed = true;
    u.activated = true;
  }
  return s;
}

// Check a whole plan: each order against the projection of the ones before
// it. Returns [{ action, ok, reason }] in order.
export function checkPlan(state, actions) {
  const out = [];
  for (let i = 0; i < actions.length; i++) {
    const v = validateAction(projectOrders(state, actions.slice(0, i)), actions[i]);
    out.push({ action: actions[i], ...v });
  }
  return out;
}
