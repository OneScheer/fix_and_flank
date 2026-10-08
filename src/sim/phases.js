// The turn sequence, after Take That Hill. Each turn runs the phases in
// balance.turn.phases in order:
//
//   movement      BLUFOR orders moves and fast moves. A unit that moves is
//                 spent: it cannot fire this turn.
//   firefight     BLUFOR units that did not move (and are not pinned) fire.
//   rally         automatic: each suppressed or pinned BLUFOR unit tries to
//                 improve one step (see rallyNeed).
//   enemy action  OPFOR: each suppressed or pinned unit recovers one step and
//                 does nothing else; the others move or fire.
//
// A phase in which nobody can act is skipped. The first phase of a side in a
// turn starts that side's turn: its units' moved, fired and exposed flags
// are cleared.

import { rollD6 } from './dice.js';
import { distance, same } from './hex.js';
import { betterStatus, canActivate, currentPhase, isActive, isSuppressed } from './state.js';

// What a suppressed or pinned unit needs in the rally phase:
//   { auto: true }                  a leader of its side is in its hex
//   { blocked: true }               an enemy is next to it, and no leader is with it
//   { need, leader, distance }      d6 >= need, where need is the distance to the
//                                   nearest leader plus one (the roll must beat
//                                   the distance), at worst rally.worstOn;
//                                   leader and distance are null without a leader
export function rallyNeed(state, unit) {
  const leaders = state.units.filter((u) => u.side === unit.side && u.kind === 'leader' && isActive(u));
  const withLeader = leaders.find((l) => same(l.pos, unit.pos));
  if (withLeader) return { auto: true, leader: withLeader.id, distance: 0 };
  const enemyNext = state.units.some((u) => u.side !== unit.side && isActive(u) && distance(u.pos, unit.pos) <= 1);
  if (enemyNext) return { blocked: true };
  const worst = state.balance.rally.worstOn;
  let best = { need: worst, leader: null, distance: null };
  for (const l of leaders) {
    const d = distance(l.pos, unit.pos);
    if (best.distance === null || d < best.distance) best = { need: Math.min(d + 1, worst), leader: l.id, distance: d };
  }
  return best;
}

function rallyPhase(state, side, rng, events) {
  for (const u of state.units) {
    if (u.side !== side || !isActive(u) || !isSuppressed(u)) continue;
    const r = rallyNeed(state, u);
    const from = u.status;
    if (r.blocked) {
      events.push({ type: 'rally', unit: u.id, blocked: true, success: false, from, to: from });
      continue;
    }
    const roll = r.auto ? null : rollD6(rng);
    const success = r.auto || roll >= r.need;
    if (success) u.status = betterStatus(u.status);
    events.push({ type: 'rally', unit: u.id, auto: !!r.auto, roll, need: r.need ?? null, leader: r.leader, distance: r.distance, success, from, to: u.status });
  }
}

// Enemy action: a suppressed or pinned unit spends the phase recovering a step.
function recoverFirst(state, side, events) {
  for (const u of state.units) {
    if (u.side !== side || !isActive(u) || !isSuppressed(u)) continue;
    const from = u.status;
    u.status = betterStatus(u.status);
    u.activated = true;
    events.push({ type: 'recover', unit: u.id, from, to: u.status });
  }
}

// Start the current phase. Returns true if someone has to give orders in it.
function enterPhase(state, rng, events) {
  const phases = state.balance.turn.phases;
  const phase = currentPhase(state);
  state.activeSide = phase.side;
  const sidesTurn = state.phase === 0 || phases[state.phase - 1].side !== phase.side;
  for (const u of state.units) {
    u.activated = false;
    if (sidesTurn && u.side === phase.side) {
      u.moved = false;
      u.fired = false;
      u.exposed = false;
    }
  }
  const start = { type: 'phase_start', turn: state.turn, phase: state.phase, name: phase.name, side: phase.side, idle: false };
  events.push(start);
  if (phase.automatic === 'rally') rallyPhase(state, phase.side, rng, events);
  if (phase.recoverFirst) recoverFirst(state, phase.side, events);
  const waiting = state.units.some((u) => canActivate(state, u));
  start.idle = !waiting && !phase.automatic;
  return waiting;
}

// After an action: if nobody is left to act in this phase, go on to the
// next phase that needs orders (rolling over into new turns as needed).
// Mutates state (a fresh clone) and pushes events.
export function advance(state, rng, events) {
  if (state.units.some((u) => canActivate(state, u))) return;
  const phases = state.balance.turn.phases;
  // Two full turns without anyone able to act: nothing more will happen.
  for (let i = 0; i < phases.length * 2; i++) {
    if (state.phase + 1 < phases.length) {
      state.phase += 1;
    } else {
      events.push({ type: 'turn_end', turn: state.turn });
      state.turn += 1;
      state.phase = 0;
      events.push({ type: 'turn_start', turn: state.turn });
    }
    if (enterPhase(state, rng, events)) return;
  }
  state.activeSide = null;
}
