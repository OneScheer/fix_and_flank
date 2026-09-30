// Game state shape.
//
// state = {
//   turn, tick, ticksPerTurn, tickSec,
//   rngState,            uint32, RNG state at the start of the next turn
//   balance, map,        frozen, shared by reference between states
//   contacts: { [side]: { [enemyId]: { level, pos, lastSeenSec } } }  (see spotting.js)
//   soldiers: [{
//     id, side, team, role, pos: {x, y}, stance, suppression, status, hp,
//     move: null | { dest, speed, path: [{x, y}], i, progress, blocked },
//   }],
// }
//
// Soldiers are stored in id order. Everything except balance and map is
// plain data, so a state can be cloned with structuredClone and compared
// with deepEqual.

export function ticksPerTurn(balance) {
  const { durationSec, tickSec } = balance.turn;
  const ticks = durationSec / tickSec;
  if (!Number.isInteger(ticks)) {
    throw new Error(`turn.durationSec (${durationSec}) must be a whole multiple of turn.tickSec (${tickSec})`);
  }
  return ticks;
}

export function createState({ balance, map, seed }) {
  const soldiers = (map?.units ?? []).map((u, id) => ({
    id,
    side: u.side,
    team: u.team,
    role: u.role,
    pos: { x: u.pos[0], y: u.pos[1] },
    stance: u.stance ?? balance.soldier.startStance,
    suppression: 0,
    status: 'active',
    hp: balance.soldier.hp,
    move: null,
  }));
  const contacts = {};
  for (const s of soldiers) contacts[s.side] ??= {};
  return {
    turn: 0,
    tick: 0,
    ticksPerTurn: ticksPerTurn(balance),
    tickSec: balance.turn.tickSec,
    seed: seed >>> 0,
    rngState: seed >>> 0,
    balance,
    map,
    soldiers,
    contacts,
  };
}

// Copy everything a step may change. balance and map stay shared.
export function cloneState(state) {
  return { ...state, soldiers: structuredClone(state.soldiers), contacts: structuredClone(state.contacts) };
}

export function isOnMap(soldier) {
  return soldier.status !== 'dead';
}

export function canMove(soldier) {
  return soldier.status === 'active' || soldier.status === 'shaken';
}

export function teamMembers(state, side, team) {
  return state.soldiers.filter((s) => s.side === side && s.team === team && canMove(s));
}

export function teamsOf(state, side) {
  return [...new Set(state.soldiers.filter((s) => s.side === side).map((s) => s.team))];
}
