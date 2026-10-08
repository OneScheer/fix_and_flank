// Scripted BLUFOR plans, for the balance test and later as drill demos.
// A plan is made per game (it remembers how far along its route each unit
// is) and gives the orders for each BLUFOR phase, like a player would: from
// the state BLUFOR sees, committed all at once. Mission-specific hexes come
// from the map's "drills" entry:
//   "drills": {
//     "frontal": { "ALPHA": [[col, row], ...], "BRAVO": [...], "SL": [...] },
//     "fixAndFlank": { "baseOfFire": "ALPHA", "maneuver": "BRAVO", "leaderWith": "BRAVO",
//                      "closeIn": 6, "routes": { "ALPHA": [...], "BRAVO": [...] } }
//   }
// A route is a list of waypoints; the last one is where the unit goes to
// work (fire or assault from there).

import { moveOptions, validateAction } from '../sim/actions.js';
import { key, neighbors, same } from '../sim/hex.js';
import { inBounds, terrainOf } from '../sim/map.js';
import { projectOrders } from '../sim/orders.js';
import { currentPhase, isSuppressed } from '../sim/state.js';

const H = ([col, row]) => ({ col, row });

// Hexes from `goal` through passable terrain, ignoring units: key -> steps.
function distanceField(map, balance, goal) {
  const dist = new Map([[key(goal), 0]]);
  const queue = [goal];
  while (queue.length) {
    const h = queue.shift();
    for (const n of neighbors(h)) {
      if (!inBounds(map, n) || dist.has(key(n)) || terrainOf(map, balance, n).move === 'impassable') continue;
      dist.set(key(n), dist.get(key(h)) + 1);
      queue.push(n);
    }
  }
  return dist;
}

// The best move or fast move toward `goal`, or null if none gets closer.
function stepToward(state, u, goal, fast) {
  const field = distanceField(state.map, state.balance, goal);
  const d = (h) => field.get(key(h)) ?? Infinity;
  const o = moveOptions(state, u);
  let best = null;
  for (const h of o.moves) {
    if (d(h) < d(u.pos) && (!best || d(h) < best.d)) best = { d: d(h), action: { type: 'move', unit: u.id, to: h } };
  }
  if (fast) {
    for (const path of o.fast.values()) {
      const end = path[path.length - 1];
      if (path.length > 1 && d(end) < (best?.d ?? d(u.pos))) best = { d: d(end), action: { type: 'fastMove', unit: u.id, path } };
    }
  }
  return best?.action ?? null;
}

const objectiveOf = (state) => H(state.map.objective);
const enemyAt = (state, h) => state.units.find((u) => u.side === 'OPFOR' && u.status !== 'eliminated'
  && same(u.pos, h) && state.contacts.BLUFOR[u.id]?.level === 'spotted');

// Follows its route; remembers the furthest waypoint reached.
function router(routes) {
  const reached = {};
  return (state, u) => {
    const route = (routes[u.team] ?? []).map(H);
    let i = reached[u.team] ?? -1;
    while (i + 1 < route.length && same(u.pos, route[i + 1])) i++;
    reached[u.team] = i;
    return { next: route[i + 1] ?? null, atEnd: i === route.length - 1, last: route[route.length - 1] };
  };
}

function plan(state, wants) {
  const orders = [];
  for (const u of state.units.filter((x) => x.side === 'BLUFOR' && x.status !== 'eliminated')) {
    const p = projectOrders(state, orders);
    const a = wants(p, p.units[u.id]);
    if (a && validateAction(p, a).ok) orders.push(a);
  }
  return orders;
}

// Frontal assault: everybody rushes straight at the objective (fast moves
// along its route) and assaults as soon as it is next to it. No base of
// fire: nobody stops to fire.
export function frontalAssault(drills) {
  const route = router(drills.frontal);
  return (state) => {
    const obj = objectiveOf(state);
    const phase = currentPhase(state).name;
    return plan(state, (s, u) => {
      if (phase === 'movement') {
        if (u.kind === 'team' && enemyAt(s, obj) && validateAction(s, { type: 'move', unit: u.id, to: obj }).ok) return { type: 'move', unit: u.id, to: obj };
        const r = route(s, u);
        return r.next ? stepToward(s, u, r.next, true) : null;
      }
      return null;
    });
  };
}

function fireAtSpotted(s, u) {
  const c = Object.entries(s.contacts.BLUFOR).find(([, k]) => k.level === 'spotted'
    && validateAction(s, { type: 'fire', unit: u.id, target: k.pos }).ok);
  return c ? { type: 'fire', unit: u.id, target: c[1].pos } : null;
}

// Fix and flank: the base of fire goes to its position and fires on the
// objective every firefight (suppressive fire until the enemy is seen). The
// maneuver element goes round the flank by the concealed route without
// firing, careful moves once it is close, the SL with it; in position, it
// assaults in the firefight, after the base of fire has fired, once the
// enemy is suppressed or pinned (or in the last `lastTurns` turns + 1).
export function fixAndFlank(drills) {
  const { baseOfFire, maneuver, leaderWith, routes, closeIn = 6, lastTurns = 1 } = drills.fixAndFlank;
  const route = router(routes);
  return (state) => {
    const obj = objectiveOf(state);
    const phase = currentPhase(state).name;
    const orders = plan(state, (s, u) => {
      if (u.kind === 'leader' && leaderWith) {
        // The SL stays with his element: he moves to its hex, never ahead of it.
        const m = s.units.find((x) => x.side === 'BLUFOR' && x.team === leaderWith && x.status !== 'eliminated');
        if (phase !== 'movement' || !m || same(m.pos, u.pos)) return null; // he does not give the element away by firing
        return stepToward(s, u, m.pos, (distanceField(s.map, s.balance, obj).get(key(u.pos)) ?? Infinity) > closeIn);
      }
      const r = route(s, u);
      if (phase === 'movement') {
        if (!r.next) return null;
        const far = (distanceField(s.map, s.balance, obj).get(key(u.pos)) ?? Infinity) > closeIn;
        return stepToward(s, u, r.next, far || u.team === baseOfFire);
      }
      if (u.team === baseOfFire && r.atEnd) return { type: 'fire', unit: u.id, target: obj };
      return null; // the maneuver element stays hidden; it assaults below, after the base of fire
    });
    if (phase === 'firefight') {
      const m = state.units.find((u) => u.side === 'BLUFOR' && u.team === maneuver && u.status !== 'eliminated');
      const target = enemyAt(state, obj);
      const lastChance = state.map.mission && state.turn >= state.map.mission.turns - lastTurns;
      // Assault when the base of fire has the enemy down (it fires first and a hit pins), or when time runs out.
      if (m && !isSuppressed(m) && target && route(state, m).atEnd && (isSuppressed(target) || lastChance)) {
        const a = { type: 'fire', unit: m.id, target: obj };
        if (validateAction(projectOrders(state, orders), a).ok) orders.push(a);
      }
    }
    return orders;
  };
}

// Play a mission to the end: BLUFOR orders from `blufor(state)`, OPFOR's
// from `opfor(state, side)`. Returns the final state.
export function playOut(state, blufor, opfor, commit, createRng, maxCommits = 500) {
  let s = state;
  for (let i = 0; i < maxCommits && !s.result && s.activeSide; i++) {
    const orders = s.activeSide === 'BLUFOR' ? blufor(s) : opfor(s, s.activeSide);
    s = commit(s, orders, createRng(s.rngState)).state;
  }
  return s;
}
