// Game state shape.
//
// state = {
//   turn, tick, ticksPerTurn, tickSec,
//   rngState,            uint32, RNG state at the start of the next turn
//   balance, weapons, map,  frozen, shared by reference between states
//   contacts: { [side]: { [enemyId]: { level, pos, lastSeenSec } } }  (see spotting.js)
//   soldiers: [{
//     id, side, team, role, pos: {x, y}, stance, suppression, status, hp,
//     weapon, ammo, grenades: { hand, 40mm }, fireCooldown (s), lastFiredSec, underFireUntilSec,
//     move: null | { dest, speed, path: [{x, y}], i, progress, blocked },
//     task: null (fire at will) | { type: 'fire' | 'suppress' | 'overwatch' | 'assault' | 'grenade', ... },
//   }],
//   grenades: [{ by, side, kind, aim, at, landsAtSec }]   in flight
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

export function createState({ balance, weapons, map, seed }) {
  const soldiers = (map?.units ?? []).map((u, id) => {
    const weapon = u.weapon ?? weapons.roleWeapons[u.role] ?? weapons.defaultWeapon;
    if (!weapons.weapons[weapon]) throw new Error(`Unknown weapon '${weapon}' for ${u.side} ${u.team} ${u.role}`);
    return {
      id,
      side: u.side,
      team: u.team,
      role: u.role,
      pos: { x: u.pos[0], y: u.pos[1] },
      stance: u.stance ?? balance.soldier.startStance,
      suppression: 0,
      status: 'active',
      hp: balance.soldier.hp,
      weapon,
      ammo: weapons.weapons[weapon].ammo,
      grenades: { ...(weapons.roleGrenades?.[u.role] ?? weapons.defaultGrenades ?? {}) },
      fireCooldown: 0,
      lastFiredSec: null,
      underFireUntilSec: null,
      move: null,
      task: null,
    };
  });
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
    weapons,
    map,
    soldiers,
    contacts,
    grenades: [],
  };
}

// Copy everything a step may change. balance and map stay shared.
export function cloneState(state) {
  return {
    ...state,
    soldiers: structuredClone(state.soldiers),
    contacts: structuredClone(state.contacts),
    grenades: structuredClone(state.grenades ?? []),
  };
}

export function isOnMap(soldier) {
  return soldier.status !== 'dead';
}

// Pinned soldiers will not move; down and dead ones cannot.
export function canMove(soldier) {
  return soldier.status !== 'pinned' && soldier.status !== 'down' && soldier.status !== 'dead';
}

export function teamMembers(state, side, team) {
  return state.soldiers.filter((s) => s.side === side && s.team === team && canMove(s));
}

// Soldiers of a team who can still act (fire, change stance), pinned included.
export function teamActive(state, side, team) {
  return state.soldiers.filter((s) => s.side === side && s.team === team && s.status !== 'down' && s.status !== 'dead');
}

export function teamsOf(state, side) {
  return [...new Set(state.soldiers.filter((s) => s.side === side).map((s) => s.team))];
}
