// Orders for a whole side. Each turn a side gives one order to every unit,
// then commits them all; they are carried out in the order given, each with
// its own dice. A unit without an order holds (passes). An order that has
// become impossible by the time it runs (a rally failed, a hex got taken)
// is skipped with the reason, and that unit holds.

import { applyAction, validateAction } from './actions.js';
import { canActivate, cloneState } from './state.js';

// Carry out `actions` (in order) for the side whose turn it is, then make
// every unit of that side without an order hold. Returns { state, events }.
export function commitOrders(state, actions, rng) {
  const side = state.activeSide;
  let current = state;
  const events = [];
  for (const action of actions) {
    if (current.activeSide !== side) break;
    const r = applyAction(current, action, rng);
    current = r.state;
    events.push(...r.events);
  }
  while (current.activeSide === side) {
    const idle = current.units.find((u) => u.side === side && canActivate(current, u));
    if (!idle) break;
    const r = applyAction(current, { type: 'pass', unit: idle.id }, rng);
    current = r.state;
    events.push(...r.events);
  }
  return { state: current, events };
}

// Planning: where things will be if the earlier orders go as planned. Moves
// are applied; dice orders (rally) only mark the unit as having acted, since
// their result is not known yet. Never ends the side's turn, never rolls.
export function projectOrders(state, actions) {
  let s = state;
  for (const a of actions) {
    if (!validateAction(s, a).ok) continue;
    s = cloneState(s);
    const u = s.units[a.unit];
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
