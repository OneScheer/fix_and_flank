// Order types, validation, and planning. Orders are given per team and
// executed per soldier. planOrders is used both by the sim and by the UI
// preview, so the preview always shows what the sim will do.
//
// { type: 'move', side, team, dest: {x, y}, speed: 'walk' | 'run' | 'crawl', via?: [{x, y}] }
// { type: 'hold', side, team }
//
// `via` is an optional list of waypoints the team leader passes through, in
// order, before the destination. Move orders persist across turns until the
// team arrives or gets a new order.

import { inBounds, isPassable, stepCost, tileAt } from './map.js';
import { findRoute } from './path.js';
import { teamMembers } from './state.js';

export const ORDER_TYPES = ['move', 'hold'];
export const SPEEDS = ['walk', 'run', 'crawl'];

const key = (p, w) => p.y * w + p.x;

export function validateOrder(state, order) {
  if (!ORDER_TYPES.includes(order?.type)) return { ok: false, reason: `unknown order type '${order?.type}'` };
  if (teamMembers(state, order.side, order.team).length === 0) {
    return { ok: false, reason: `${order.team} has no soldiers able to move` };
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
    if (!result.ok || result.order.type !== 'move') continue;
    const { order } = result;
    const members = teamMembers(state, order.side, order.team);
    const anchor = anchorOf(members);
    const reserved = reservedFor(order.side);
    const speedTilesPerSec = movement.speedMps[order.speed] / tileMeters;
    // Anchor first so the leader gets the tile that was clicked.
    const ordered = [anchor, ...members.filter((s) => s !== anchor)];
    let anchorPath = null;
    for (const s of ordered) {
      const offset = { x: s.pos.x - anchor.pos.x, y: s.pos.y - anchor.pos.y };
      const target = { x: order.dest.x + offset.x, y: order.dest.y + offset.y };
      const dest = nearestFreeTile(map, target, reserved, movement.formationSearchRadius);
      if (!dest) {
        result.soldiers.push({ id: s.id, dest: null, path: null, reason: 'no free tile near the destination' });
        continue;
      }
      reserved.add(key(dest, map.width));
      const inFormation = s !== anchor && anchorPath && dest.x === target.x && dest.y === target.y
        ? followPath(map, movement, s.pos, anchorPath, offset)
        : null;
      // Leader routes through the waypoints. A follower whose shifted route is
      // blocked passes through its own offset of each waypoint where passable.
      const via = (order.via ?? []).map((p) => {
        const shifted = { x: p.x + offset.x, y: p.y + offset.y };
        return inBounds(map, shifted.x, shifted.y) && isPassable(tileAt(map, shifted.x, shifted.y)) ? shifted : p;
      });
      const found = inFormation ?? findRoute(map, movement, s.pos, [...via, dest]);
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
    if (order.type === 'hold') {
      for (const s of teamMembers(state, order.side, order.team)) s.move = null;
      continue;
    }
    for (const p of plan.soldiers) {
      const s = byId.get(p.id);
      if (!p.path) {
        s.move = null;
        events.push({ type: 'order_failed', id: s.id, reason: p.reason });
        continue;
      }
      s.move = { dest: p.dest, speed: order.speed, path: p.path, i: 0, progress: 0, blocked: false };
      const stance = stanceForSpeed[order.speed];
      if (s.stance !== stance) {
        events.push({ type: 'stance', id: s.id, from: s.stance, to: stance });
        s.stance = stance;
      }
    }
  }
}
