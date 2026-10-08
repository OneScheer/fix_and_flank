// Order types, validation, and planning. Orders are given per team and
// executed per soldier. planOrders is used both by the sim and by the UI
// preview, so the preview always shows what the sim will do.
//
// { type: 'move', side, team, dest: {x, y}, speed: 'walk' | 'run' | 'crawl', via?: [{x, y}] }
// { type: 'hold', side, team }                       stop; fire at will
// { type: 'fire', side, team, target: enemyId }      aimed fire on a spotted contact
// { type: 'suppress', side, team, at: {x, y}, target?: enemyId }
//                                                    area fire on a tile or a known contact
// { type: 'overwatch', side, team, toward: {x, y} }  hold; engage only inside the arc
// { type: 'assault', side, team, at: {x, y}, target?: enemyId }
//                                                    run in and close with the target
// { type: 'grenade', side, team, at: {x, y} }        one grenade on a tile (see grenade.js)
// { type: 'stance', side, team, stance }             stand / crouch / prone, stay put
//
// `via` is an optional list of waypoints the team leader passes through, in
// order, before the destination. Orders persist across turns until the team
// gets a new order (a move ends when the team arrives; a grenade when it is
// thrown). Teams with no fire task fire at will.

import { inBounds, isPassable, stepCost, tileAt } from './map.js';
import { planGrenade } from './grenade.js';
import { findRoute } from './path.js';
import { teamActive, teamMembers } from './state.js';

export const ORDER_TYPES = ['move', 'hold', 'fire', 'suppress', 'overwatch', 'assault', 'grenade', 'stance'];
export const SPEEDS = ['walk', 'run', 'crawl'];
export const STANCES = ['stand', 'crouch', 'prone'];

// Orders that move the team need soldiers able to move (not pinned);
// the others only need soldiers still in the fight.
const MOVING_ORDERS = new Set(['move', 'assault']);

export function orderMembers(state, order) {
  return MOVING_ORDERS.has(order.type)
    ? teamMembers(state, order.side, order.team)
    : teamActive(state, order.side, order.team);
}

function checkTile(state, p, what, needPassable) {
  if (!inBounds(state.map, p?.x, p?.y)) return { ok: false, reason: `${what} is off the map` };
  if (needPassable && !isPassable(tileAt(state.map, p.x, p.y))) return { ok: false, reason: `${what} is impassable` };
  return null;
}

const key = (p, w) => p.y * w + p.x;

export function validateOrder(state, order) {
  if (!ORDER_TYPES.includes(order?.type)) return { ok: false, reason: `unknown order type '${order?.type}'` };
  if (orderMembers(state, order).length === 0) {
    return { ok: false, reason: `${order.team} has no soldiers able to ${MOVING_ORDERS.has(order.type) ? 'move' : 'act'}` };
  }
  const contact = (id) => state.contacts[order.side]?.[id];
  switch (order.type) {
    case 'fire':
      if (contact(order.target)?.level !== 'spotted') return { ok: false, reason: 'target is not a spotted contact' };
      return { ok: true };
    case 'suppress':
    case 'assault':
      if (order.target !== undefined && order.target !== null && !contact(order.target)) {
        return { ok: false, reason: 'target is not a known contact' };
      }
      return checkTile(state, order.at, 'target', order.type === 'assault') ?? { ok: true };
    case 'overwatch':
      return checkTile(state, order.toward, 'overwatch direction', false) ?? { ok: true };
    case 'grenade':
      return checkTile(state, order.at, 'grenade target', false) ?? { ok: true };
    case 'stance':
      return STANCES.includes(order.stance) ? { ok: true } : { ok: false, reason: `unknown stance '${order.stance}'` };
    default:
      break;
  }
  if (order.type === 'move') {
    if (!SPEEDS.includes(order.speed)) return { ok: false, reason: `unknown speed '${order.speed}'` };
    const via = order.via ?? [];
    if (!Array.isArray(via)) return { ok: false, reason: 'waypoints must be a list' };
    const max = state.balance.movement.maxWaypoints;
    if (via.length > max) return { ok: false, reason: `too many waypoints (${via.length}, max ${max})` };
    for (const [i, p] of [...via, order.dest].entries()) {
      const what = i === via.length ? 'destination' : `waypoint ${i + 1}`;
      if (!inBounds(state.map, p?.x, p?.y)) return { ok: false, reason: `${what} is off the map` };
      if (!isPassable(tileAt(state.map, p.x, p.y))) return { ok: false, reason: `${what} is impassable` };
    }
  }
  return { ok: true };
}

// Team leader anchors the formation: first TL, else lowest id.
function anchorOf(members) {
  return members.find((s) => s.role === 'TL') ?? members[0];
}

// Unit vector of the direction from a to b, snapped to the nearest of the
// 8 compass directions. Defaults to north (up the map) when a equals b.
function facing(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { x: 0, y: -1 };
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

// Wedge slot offsets (tiles from the leader) for n soldiers, turned to face
// direction f. Slots are written facing north: x is right, y is back.
// Rounding after the turn keeps the wedge on the grid.
export function formationSlots(formation, n, f) {
  const right = { x: -f.y, y: f.x };
  const back = { x: -f.x, y: -f.y };
  const slots = [];
  for (let i = 0; i < n; i++) {
    const [sx, sy] = formation.wedgeSlots[i] ?? [0, i];
    const ox = (sx * right.x + sy * back.x) * formation.spacingTiles;
    const oy = (sx * right.y + sy * back.y) * formation.spacingTiles;
    slots.push({ x: Math.round(ox) + 0, y: Math.round(oy) + 0 }); // + 0 turns -0 into 0
  }
  return slots;
}

// Nearest passable, unreserved tile to target within radius (ties: distance, then y, then x).
function nearestFreeTile(map, target, reserved, radius) {
  for (let r = 0; r <= radius; r++) {
    const ring = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { x: target.x + dx, y: target.y + dy };
        if (!inBounds(map, p.x, p.y) || !isPassable(tileAt(map, p.x, p.y))) continue;
        if (reserved.has(key(p, map.width))) continue;
        ring.push({ p, d: dx * dx + dy * dy });
      }
    }
    ring.sort((a, b) => a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x);
    if (ring.length > 0) return ring[0].p;
  }
  return null;
}

// The leader's path shifted by a formation offset, so the team keeps its
// shape on the move. Null if any step of the shifted path is blocked.
function followPath(map, movement, start, leaderPath, offset) {
  const path = [];
  let cost = 0;
  let at = start;
  for (const p of leaderPath) {
    const next = { x: p.x + offset.x, y: p.y + offset.y };
    const c = stepCost(map, movement, at, next);
    if (c === Infinity) return null;
    cost += c;
    path.push(next);
    at = next;
  }
  return { path, cost };
}

// Plan all orders for one turn. Returns one entry per order:
// { order, ok, reason?, soldiers: [{ id, dest, path, cost, etaSec, reason? }] }
export function planOrders(state, orders) {
  const { map, balance } = state;
  const movement = balance.movement;
  const tileMeters = balance.map.tileMeters;

  // A later order for the same team replaces an earlier one.
  const byTeam = new Map();
  for (const order of orders) byTeam.set(`${order?.side}/${order?.team}`, order);
  const results = [];
  const accepted = new Set();
  for (const order of orders) {
    if (byTeam.get(`${order?.side}/${order?.team}`) !== order) {
      results.push({ order, ok: false, reason: 'replaced by a later order for the same team', soldiers: [] });
      continue;
    }
    const v = validateOrder(state, order);
    results.push({ order, ...v, soldiers: [] });
    if (v.ok) accepted.add(`${order.side}/${order.team}`);
  }

  // Reserve tiles of own soldiers that are not being given new orders:
  // their destination if moving, else where they stand. Only own-side
  // soldiers count, so planning never uses hidden enemy positions.
  const reservedBySide = new Map();
  const reservedFor = (side) => {
    if (!reservedBySide.has(side)) {
      const set = new Set();
      for (const s of state.soldiers) {
        if (s.side !== side || s.status === 'dead' || accepted.has(`${s.side}/${s.team}`)) continue;
        set.add(key(s.move ? s.move.dest : s.pos, map.width));
      }
      reservedBySide.set(side, set);
    }
    return reservedBySide.get(side);
  };

  for (const result of results) {
    if (!result.ok) continue;
    const { order } = result;
    if (order.type === 'grenade') {
      result.grenade = planGrenade(state, orderMembers(state, order), order.at);
      if (!result.grenade.ok) Object.assign(result, { ok: false, reason: result.grenade.reason });
      continue;
    }
    if (order.type !== 'move' && order.type !== 'assault') continue;
    const speed = order.type === 'assault' ? balance.orders.assault.speed : order.speed;
    const destPoint = order.type === 'assault' ? order.at : order.dest;
    const members = teamMembers(state, order.side, order.team);
    const anchor = anchorOf(members);
    const reserved = reservedFor(order.side);
    const speedTilesPerSec = movement.speedMps[speed] / tileMeters;
    // Anchor first so the leader gets the tile that was clicked. The team
    // forms a wedge on the destination, facing the last leg of the route.
    const ordered = [anchor, ...members.filter((s) => s !== anchor)];
    const via = order.via ?? [];
    const from = via.length ? via[via.length - 1] : anchor.pos;
    const slots = formationSlots(movement.formation, ordered.length, facing(from, destPoint));
    let anchorPath = null;
    let anchorDest = null;
    for (const [i, s] of ordered.entries()) {
      const target = { x: destPoint.x + slots[i].x, y: destPoint.y + slots[i].y };
      const dest = nearestFreeTile(map, target, reserved, movement.formationSearchRadius);
      if (!dest) {
        result.soldiers.push({ id: s.id, dest: null, path: null, reason: 'no free tile near the destination' });
        continue;
      }
      reserved.add(key(dest, map.width));
      if (s === anchor) anchorDest = dest;
      // A follower already standing in its slot relative to the leader takes
      // the leader's route shifted over, so the team keeps its shape on the
      // move. Anyone out of place (a straggler, or the wedge turned) routes
      // on its own and closes up at its slot.
      const offset = anchorDest ? { x: dest.x - anchorDest.x, y: dest.y - anchorDest.y } : slots[i];
      const inSlot = s.pos.x - anchor.pos.x === offset.x && s.pos.y - anchor.pos.y === offset.y;
      const inFormation = s !== anchor && anchorPath && inSlot
        ? followPath(map, movement, s.pos, anchorPath, offset)
        : null;
      // Leader routes through the waypoints. A follower whose shifted route is
      // blocked passes through its own offset of each waypoint where passable.
      const ownVia = via.map((p) => {
        const shifted = { x: p.x + offset.x, y: p.y + offset.y };
        return inBounds(map, shifted.x, shifted.y) && isPassable(tileAt(map, shifted.x, shifted.y)) ? shifted : p;
      });
      const found = inFormation ?? findRoute(map, movement, s.pos, [...ownVia, dest]);
      if (s === anchor) anchorPath = found?.path ?? null;
      if (!found) {
        result.soldiers.push({ id: s.id, dest, path: null, reason: 'no route to the destination' });
        continue;
      }
      result.soldiers.push({ id: s.id, dest, path: found.path, cost: found.cost, etaSec: found.cost / speedTilesPerSec });
    }
    result.soldiers.sort((a, b) => a.id - b.id);
  }
  return results;
}

function setStance(s, stance, events) {
  if (s.stance === stance) return;
  events.push({ type: 'stance', id: s.id, from: s.stance, to: stance });
  s.stance = stance;
}

// Apply a turn's orders to a (cloned, mutable) state. Pushes events.
export function applyOrders(state, orders, events) {
  const plans = planOrders(state, orders);
  const byId = new Map(state.soldiers.map((s) => [s.id, s]));
  const { stanceForSpeed } = state.balance.movement;
  for (const plan of plans) {
    const { order } = plan;
    if (!plan.ok) {
      events.push({ type: 'order_rejected', side: order?.side, team: order?.team, reason: plan.reason });
      continue;
    }
    events.push({ type: 'order', side: order.side, team: order.team, order: structuredClone(order) });
    const members = orderMembers(state, order);

    if (order.type === 'move' || order.type === 'assault') {
      const speed = order.type === 'assault' ? state.balance.orders.assault.speed : order.speed;
      for (const p of plan.soldiers) {
        const s = byId.get(p.id);
        s.task = order.type === 'assault'
          ? { type: 'assault', at: { ...order.at }, target: order.target ?? null }
          : null;
        if (!p.path) {
          s.move = null;
          events.push({ type: 'order_failed', id: s.id, reason: p.reason });
          continue;
        }
        s.move = { dest: p.dest, speed, path: p.path, i: 0, progress: 0, blocked: false };
        setStance(s, stanceForSpeed[speed], events);
      }
      continue;
    }

    for (const s of members) {
      s.move = null;
      s.task = null;
    }
    switch (order.type) {
      case 'fire':
        for (const s of members) s.task = { type: 'fire', target: order.target };
        break;
      case 'suppress':
        for (const s of members) s.task = { type: 'suppress', at: { ...order.at }, target: order.target ?? null, noFire: null };
        break;
      case 'overwatch':
        for (const s of members) s.task = { type: 'overwatch', toward: { ...order.toward } };
        break;
      case 'grenade': {
        const g = plan.grenade;
        byId.get(g.thrower).task = { type: 'grenade', at: { ...order.at }, kind: g.kind };
        break;
      }
      case 'stance':
        for (const s of members) setStance(s, order.stance, events);
        break;
      default: // hold
        break;
    }
  }
}
