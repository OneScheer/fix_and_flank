// Deterministic A* over the tile grid, 8 directions, no corner cutting.
// Paths ignore soldiers; they are handled tick by tick during movement.

import { inBounds, isPassable, stepCost, tileAt } from './map.js';

// Fixed neighbor order keeps results identical across runs.
export const DIRS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

// Min-heap ordered by (f, seq). seq breaks ties in insertion order.
class Heap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  less(a, b) { return a.f < b.f || (a.f === b.f && a.seq < b.seq); }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// Returns { path: [{x, y}, ...] (excluding start), cost } or null if unreachable.
export function findPath(map, movement, start, goal) {
  if (!inBounds(map, goal.x, goal.y) || !isPassable(tileAt(map, goal.x, goal.y))) return null;
  if (start.x === goal.x && start.y === goal.y) return { path: [], cost: 0 };

  const minCost = Math.min(...Object.values(movement.terrainCost).filter((c) => c != null));
  const w = map.width;
  const startIdx = start.y * w + start.x;
  const goalIdx = goal.y * w + goal.x;
  const g = new Float64Array(map.width * map.height).fill(Infinity);
  const from = new Int32Array(map.width * map.height).fill(-1);
  const closed = new Uint8Array(map.width * map.height);
  const open = new Heap();
  let seq = 0;

  g[startIdx] = 0;
  open.push({ idx: startIdx, f: octile(start.x, start.y, goal.x, goal.y) * minCost, seq: seq++ });

  while (open.size > 0) {
    const { idx } = open.pop();
    if (closed[idx]) continue;
    if (idx === goalIdx) break;
    closed[idx] = 1;
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const cost = stepCost(map, movement, { x, y }, { x: nx, y: ny });
      if (cost === Infinity) continue;
      const nIdx = ny * w + nx;
      if (closed[nIdx]) continue;
      const ng = g[idx] + cost;
      if (ng < g[nIdx]) {
        g[nIdx] = ng;
        from[nIdx] = idx;
        open.push({ idx: nIdx, f: ng + octile(nx, ny, goal.x, goal.y) * minCost, seq: seq++ });
      }
    }
  }

  if (g[goalIdx] === Infinity) return null;
  const path = [];
  for (let idx = goalIdx; idx !== startIdx; idx = from[idx]) {
    path.push({ x: idx % w, y: Math.floor(idx / w) });
  }
  path.reverse();
  return { path, cost: g[goalIdx] };
}
