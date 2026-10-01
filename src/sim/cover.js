// Directional cover, derived from neighbor tiles (no facing stored).
//
// Protection against fire arriving from direction d (8 directions) is the
// best cover among the tile adjacent in direction d and the soldier's own
// tile. So a soldier behind a wall is protected from the wall side and
// exposed from every other side.
//
// Stance scales cover: full-height walls protect at any stance; low cover
// (low walls, windows, rubble, trees) protects prone soldiers most and
// standing soldiers hardly at all.

import { inBounds, tileAt } from './map.js';

// Clockwise from east, in screen coordinates (y grows down / south).
export const DIRECTIONS = [
  { name: 'east', dx: 1, dy: 0 },
  { name: 'south-east', dx: 1, dy: 1 },
  { name: 'south', dx: 0, dy: 1 },
  { name: 'south-west', dx: -1, dy: 1 },
  { name: 'west', dx: -1, dy: 0 },
  { name: 'north-west', dx: -1, dy: -1 },
  { name: 'north', dx: 0, dy: -1 },
  { name: 'north-east', dx: 1, dy: -1 },
];

// Direction from `from` towards `to`, snapped to one of the 8 directions.
export function directionTo(from, to) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const i = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRECTIONS[i];
}

function protectionOf(balance, tile, stance) {
  const base = balance.cover.protection[tile.cover];
  if (base === 0) return 0;
  return tile.height === 2 ? base : base * balance.cover.lowCoverStance[stance];
}

// Cover for `target` ({ pos, stance }) against fire from `shooterPos`.
// Returns { protection (0..1, fraction of hits stopped), direction, tile, source }
// where source is 'neighbor' | 'own' | null and tile is the tile giving it.
export function coverFrom(map, balance, target, shooterPos) {
  const direction = directionTo(target.pos, shooterPos);
  const n = { x: target.pos.x + direction.dx, y: target.pos.y + direction.dy };
  let best = { protection: 0, direction, tile: null, source: null };

  // A shooter standing on the neighbor tile itself is past that cover.
  const shooterOnNeighbor = n.x === shooterPos.x && n.y === shooterPos.y;
  if (!shooterOnNeighbor && inBounds(map, n.x, n.y)) {
    const tile = tileAt(map, n.x, n.y);
    const p = protectionOf(balance, tile, target.stance);
    if (p > best.protection) best = { protection: p, direction, tile: { ...n, cover: tile.cover, what: describe(tile) }, source: 'neighbor' };
  }
  const own = tileAt(map, target.pos.x, target.pos.y);
  const p = protectionOf(balance, own, target.stance);
  if (p > best.protection) {
    best = { protection: p, direction, tile: { ...target.pos, cover: own.cover, what: describe(own) }, source: 'own' };
  }
  return best;
}

function describe(tile) {
  if (tile.feature === 'window') return 'window';
  if (tile.height === 2) return 'wall';
  if (tile.height === 1) return 'low wall';
  return tile.terrain;
}
