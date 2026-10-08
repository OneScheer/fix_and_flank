// Game state shape.
//
// state = {
//   turn,                 1-based
//   activeSide,           side whose fireteam acts next
//   rngState,             uint32, RNG state for the next action
//   balance, map,         frozen, shared by reference between states
//   units: [{
//     id, side, team, pos: {col, row},
//     kind: 'team' | 'leader',                a fireteam, or the squad leader (SL)
//     soldiers: ['TL', 'AR', 'GRN', 'RFL'],   who is left (a leader: ['SL'])
//     status: 'ok' | 'suppressed' | 'pinned' | 'eliminated',
//                         suppressed: cannot move; pinned: cannot move or fire
//     activated,          has acted this turn
//     moved,              moved or fast moved this turn: cannot fire until next turn
//     exposed,            fast moved; until its own next activation
//   }],
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
    soldiers: [...(u.soldiers ?? (u.kind === 'leader' ? balance.unit.leaderRoles : balance.unit.roles))],
    status: 'ok',
    activated: false,
    moved: false,
    exposed: false,
  }));
  const state = {
    turn: 1,
    activeSide: null,
    rngState: seed >>> 0,
    seed: seed >>> 0,
    balance,
    map,
    units,
  };
  state.activeSide = firstSideToAct(state);
  return state;
}

export function cloneState(state) {
  return { ...state, units: structuredClone(state.units) };
}

export function isActive(unit) {
  return unit.status !== 'eliminated';
}

export function canActivate(state, unit) {
  return isActive(unit) && !unit.activated;
}

export function sidesWithActivations(state) {
  return state.balance.turn.initiative.filter((side) => state.units.some((u) => u.side === side && canActivate(state, u)));
}

// The side with initiative if it has a team left to act, else the next one.
export function firstSideToAct(state) {
  return sidesWithActivations(state)[0] ?? null;
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

// Fire rules start in milestone 4; these two are fixed already: a unit that
// moved this turn cannot fire, and a pinned unit cannot shoot back.
export function mayFire(unit) {
  if (unit.status === 'eliminated') return { ok: false, reason: `${unit.team} is eliminated` };
  if (unit.status === 'pinned') return { ok: false, reason: `${unit.team} is pinned and cannot fire` };
  if (unit.moved) return { ok: false, reason: `${unit.team} moved this turn and cannot fire until next turn` };
  return { ok: true };
}

export function isSuppressed(unit) {
  return unit.status === 'suppressed' || unit.status === 'pinned';
}
