// Game state shape.

import { updateContacts } from './spotting.js';
//
// state = {
//   turn,                 1-based
//   phase,                index into balance.turn.phases (movement, firefight, rally, enemy action)
//   activeSide,           the side of the current phase
//   rngState,             uint32, RNG state for the next action
//   balance, map,         frozen, shared by reference between states
//   units: [{
//     id, side, team, pos: {col, row},
//     kind: 'team' | 'leader',                a fireteam, or the squad leader (SL)
//     type: null | 'hmg',                     a special team (balance.unitTypes), else a rifle fireteam
//     soldiers: ['TL', 'AR', 'GRN', 'RFL'],   who is left (a leader: ['SL'])
//     status: 'ok' | 'suppressed' | 'pinned' | 'eliminated',
//                         suppressed: cannot move; pinned: cannot move or fire
//     activated,          has acted in the current phase
//     moved,              moved or fast moved: cannot fire until its side's next turn
//     exposed,            fast moved; until its side's next turn starts
//     fired,              fired (gives it away until its side's next turn; set by fire, milestone 4)
//     reload,             side's turns until it can fire again (a type with fireEveryTurns, the HMG)
//   }],
//   contacts: { [side]: { [enemyId]: { level: 'spotted' | 'suspected', pos, turn } } }
//   result: null, or { winner, why } once the mission is over (see mission.js)
// }
//
// Units are stored in id order. Everything except balance and map is plain
// data, so a state can be cloned with structuredClone and compared with deepEqual.

export function createState({ balance, map, seed }) {
  const units = (map?.units ?? []).map((u, id) => ({
    id,
    side: u.side,
    team: u.team,
    pos: { col: u.pos[0], row: u.pos[1] },
    kind: u.kind ?? 'team',
    type: u.type ?? null,
    soldiers: [...(u.soldiers ?? unitType(balance, { kind: u.kind ?? 'team', type: u.type ?? null }).roles)],
    status: 'ok',
    activated: false,
    moved: false,
    exposed: false,
    fired: false,
    reload: 0,
  }));
  const state = {
    turn: 1,
    phase: 0,
    activeSide: balance.turn.phases[0].side,
    rngState: seed >>> 0,
    seed: seed >>> 0,
    balance,
    map,
    units,
    contacts: Object.fromEntries((balance.turn.sides).map((side) => [side, {}])),
    result: null,
  };
  updateContacts(state, []);
  return state;
}

// What kind of unit this is, with defaults filled in from balance: { name,
// roles, casualtyOrder, fastMove, assault, maxRangeHexes, range }.
export function unitType(balance, unit) {
  const base = unit.kind === 'leader'
    ? { name: 'squad leader', roles: balance.unit.leaderRoles }
    : { name: 'fireteam', roles: balance.unit.roles };
  return {
    casualtyOrder: balance.unit.casualtyOrder,
    fastMove: true,
    assault: unit.kind === 'team',
    fireEveryTurns: 1,
    maxRangeHexes: balance.fire.maxRangeHexes,
    range: balance.fire.range,
    ...base,
    ...(unit.type ? balance.unitTypes[unit.type] : {}),
  };
}

export function cloneState(state) {
  return { ...state, units: structuredClone(state.units), contacts: structuredClone(state.contacts) };
}

export function isActive(unit) {
  return unit.status !== 'eliminated';
}

export function currentPhase(state) {
  return state.balance.turn.phases[state.phase];
}

// Could the unit do any of the phase's actions (other than hold)? Moving
// needs a unit that is not suppressed or pinned; firing, one that may fire.
export function canActIn(phase, unit) {
  if (!isActive(unit) || unit.side !== phase.side) return false;
  return (phase.actions ?? []).some((t) => (t === 'fire' ? mayFire(unit).ok : !isSuppressed(unit)));
}

// Still waiting for an order in the current phase.
export function canActivate(state, unit) {
  return !state.result && !unit.activated && canActIn(currentPhase(state), unit);
}

export function unitsAt(state, h) {
  return state.units.filter((u) => isActive(u) && u.pos.col === h.col && u.pos.row === h.row);
}

// The fireteam in a hex if there is one, else the leader.
export function unitAt(state, h) {
  const here = unitsAt(state, h);
  return here.find((u) => u.kind === 'team') ?? here[0] ?? null;
}

// Status one step better: pinned -> suppressed -> ok.
export function betterStatus(status) {
  return status === 'pinned' ? 'suppressed' : 'ok';
}

// A unit that moved this turn cannot fire, and a pinned unit cannot shoot back.
export function mayFire(unit) {
  if (unit.status === 'eliminated') return { ok: false, reason: `${unit.team} is eliminated` };
  if (unit.status === 'pinned') return { ok: false, reason: `${unit.team} is pinned and cannot fire` };
  if (unit.moved) return { ok: false, reason: `${unit.team} moved this turn and cannot fire` };
  if (unit.reload > 0) return { ok: false, reason: `${unit.team} is reloading and fires again next turn` };
  return { ok: true };
}

export function isSuppressed(unit) {
  return unit.status === 'suppressed' || unit.status === 'pinned';
}
