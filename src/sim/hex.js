// Hex grid math. Pointy-top hexes, "odd-r" offset coordinates {col, row}
// (odd rows shifted half a hex right), converted to cube coordinates
// {x, y, z} with x + y + z = 0 for distance, neighbors and lines.
// Pixel layout: hex circumradius 1, so a hex is sqrt(3) wide and rows are
// 1.5 apart.

const SQRT3 = Math.sqrt(3);

export function toCube({ col, row }) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  return { x, y: -x - z, z };
}

export function fromCube({ x, z }) {
  return { col: x + (z - (z & 1)) / 2, row: z };
}

// Clockwise from east.
export const CUBE_DIRS = [
  { x: 1, y: -1, z: 0 }, { x: 0, y: -1, z: 1 }, { x: -1, y: 0, z: 1 },
  { x: -1, y: 1, z: 0 }, { x: 0, y: 1, z: -1 }, { x: 1, y: 0, z: -1 },
];

// Hex sides, in the same order as CUBE_DIRS: side i faces neighbor i.
// Pointy-top hexes have no north or south side.
export const SIDES = ['E', 'SE', 'SW', 'W', 'NW', 'NE'];

export function opposite(side) {
  return SIDES[(SIDES.indexOf(side) + 3) % 6];
}

export function neighborOn(h, side) {
  const c = toCube(h);
  const d = CUBE_DIRS[SIDES.indexOf(side)];
  return fromCube({ x: c.x + d.x, y: c.y + d.y, z: c.z + d.z });
}

// The side(s) of hex `h` facing hex `toward`: the side whose direction is
// closest to the line between the centers. When the line runs exactly
// through a corner both sides touching it are returned.
export function sidesFacing(h, toward) {
  const a = center(h);
  const b = center(toward);
  // Side i is centered on 60 x i degrees, screen y pointing down.
  const angle = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 360;
  const pos = angle / 60;
  const lower = Math.floor(pos);
  if (Math.abs(pos - lower - 0.5) < 1e-6) return [SIDES[lower % 6], SIDES[(lower + 1) % 6]];
  return [SIDES[Math.round(pos) % 6]];
}

export function key(h) {
  return `${h.col},${h.row}`;
}

export function same(a, b) {
  return a.col === b.col && a.row === b.row;
}

export function neighbors(h) {
  const c = toCube(h);
  return CUBE_DIRS.map((d) => fromCube({ x: c.x + d.x, y: c.y + d.y, z: c.z + d.z }));
}

export function distance(a, b) {
  const p = toCube(a);
  const q = toCube(b);
  return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.z - q.z));
}

export function adjacent(a, b) {
  return distance(a, b) === 1;
}

export function cubeRound({ x, y, z }) {
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx + 0, y: ry + 0, z: rz + 0 };
}

// Hexes on the straight line from a to b, both ends included. A tiny
// fixed nudge breaks ties on hex edges the same way every time.
export function line(a, b, nudge = 1) {
  const p = toCube(a);
  const q = toCube(b);
  const n = distance(a, b);
  const e = 1e-6 * nudge;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(fromCube(cubeRound({
      x: p.x + e + (q.x - p.x) * t,
      y: p.y + e + (q.y - p.y) * t,
      z: p.z - 2 * e + (q.z - p.z) * t,
    })));
  }
  return out;
}

// Center of a hex in world units (circumradius 1).
export function center({ col, row }) {
  return { x: SQRT3 * (col + 0.5 * (row & 1)), y: 1.5 * row };
}

// Hex containing a world point.
export function hexAt({ x, y }) {
  const q = (SQRT3 / 3) * x - y / 3;
  const r = (2 / 3) * y;
  return fromCube(cubeRound({ x: q, y: -q - r, z: r }));
}

// Corners of a hex in world units, for drawing.
export function corners(h) {
  const c = center(h);
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return { x: c.x + Math.cos(a), y: c.y + Math.sin(a) };
  });
}

// World-space bounds of a map of cols x rows hexes.
export function mapBounds(cols, rows) {
  return { minX: -SQRT3 / 2, minY: -1, maxX: SQRT3 * (cols + 0.5) - SQRT3 / 2, maxY: 1.5 * (rows - 1) + 1 };
}
