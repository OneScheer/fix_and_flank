// Advance the simulation. step() is one tick; resolveTurn() is a full turn.
// Both return a new state and the events that happened; inputs are not changed.

import { stepCost } from './map.js';
import { applyOrders } from './orders.js';
import { canMove, cloneState, isOnMap } from './state.js';
import { endOfTickSec, updateContacts } from './spotting.js';
import { resolveFire, updateStatus } from './combat.js';
import { createRng } from './rng.js';

// Float tolerance for progress sums (0.1 added ten times is 0.9999999999999999).
// Numerical, not a balance value.
const EPS = 1e-9;

// Movement is simultaneous within a tick. Soldiers try to step in id
// order against live occupancy, in repeated passes until nobody can move,
// so a soldier blocked by one that has not stepped yet gets another try
// once it has. Nobody ever steps into an occupied tile. Soldiers still
// blocked at the end keep at most one step's worth of progress and wait.
function moveSoldiers(state, events) {
  const { map, balance, tickSec } = state;
  const { movement } = balance;
  const w = map.width;
  const occupied = new Map();
  for (const s of state.soldiers) if (isOnMap(s)) occupied.set(s.pos.y * w + s.pos.x, s.id);

  // Pinned soldiers keep their move order but do not advance until they recover.
  const movers = state.soldiers.filter((s) => s.move && canMove(s));
  for (const s of movers) {
    s.move.progress += (movement.speedMps[s.move.speed] / balance.map.tileMeters) * tickSec;
  }

  // Take as many steps as progress allows. Returns true if the soldier moved.
  function advance(s, blockedAt) {
    let moved = false;
    blockedAt.delete(s.id);
    while (s.move) {
      const m = s.move;
      if (m.i >= m.path.length) {
        events.push({ type: 'arrived', id: s.id, pos: { ...s.pos } });
        s.move = null;
        break;
      }
      const next = m.path[m.i];
      const cost = stepCost(map, movement, s.pos, next);
      if (m.progress + EPS < cost) break;
      const nextKey = next.y * w + next.x;
      if (occupied.has(nextKey)) {
        blockedAt.set(s.id, { at: { ...next }, by: occupied.get(nextKey), cost });
        break;
      }
      occupied.delete(s.pos.y * w + s.pos.x);
      occupied.set(nextKey, s.id);
      events.push({ type: 'moved', id: s.id, from: { ...s.pos }, to: { ...next }, speed: m.speed });
      s.pos = { ...next };
      m.i += 1;
      m.progress = Math.max(0, m.progress - cost);
      m.blocked = false;
      moved = true;
    }
    return moved;
  }

  const blockedAt = new Map();
  let pending = movers;
  while (pending.length > 0) {
    let movedAny = false;
    for (const s of pending) if (advance(s, blockedAt)) movedAny = true;
    if (!movedAny) break;
    pending = pending.filter((s) => blockedAt.has(s.id));
  }

  for (const s of movers) {
    const b = blockedAt.get(s.id);
    if (!b || !s.move) continue;
    s.move.progress = b.cost;
    if (!s.move.blocked) events.push({ type: 'blocked', id: s.id, at: b.at, by: b.by });
    s.move.blocked = true;
  }
}

// One tick: orders (applied at the start of this tick; pass [] on later
// ticks), movement, fire, suppression and status, then spotting.
export function step(state, orders, rng) {
  const next = cloneState(state);
  const events = [];
  const now = endOfTickSec(next);
  if (orders?.length) applyOrders(next, orders, events);
  moveSoldiers(next, events);
  const movedSpeed = new Map(events.filter((e) => e.type === 'moved').map((e) => [e.id, e.speed]));
  resolveFire(next, movedSpeed, rng, now, events);
  updateStatus(next, now, events);
  updateContacts(next, new Set(movedSpeed.keys()), rng, events);
  for (const e of events) {
    e.turn = state.turn;
    e.tick = state.tick;
  }
  next.tick += 1;
  if (next.tick >= next.ticksPerTurn) {
    next.tick = 0;
    next.turn += 1;
  }
  return { state: next, events };
}

// Resolve one full turn from its first tick. Orders from both sides go in
// together (WEGO). The RNG is seeded from and saved back to state.rngState.
export function resolveTurn(state, orders) {
  if (state.tick !== 0) throw new Error(`resolveTurn must start at tick 0, state is at tick ${state.tick}`);
  const rng = createRng(state.rngState);
  let current = state;
  const events = [];
  for (let t = 0; t < state.ticksPerTurn; t++) {
    const result = step(current, t === 0 ? orders : [], rng);
    current = result.state;
    events.push(...result.events);
  }
  current.rngState = rng.getState();
  return { state: current, events };
}
