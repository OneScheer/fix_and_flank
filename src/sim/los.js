// Line of sight and concealment.
//
// The ray runs between tile centers and visits every tile it touches
// (supercover). The observer's and target's own tiles never block.
//
// Height: each tile has an obstacle height (balance.vision.obstacleHeightM
// by tile height). The sight line runs from the observer's eye height to
// the target's height (both by stance) and is blocked where an obstacle
// reaches it. So a low wall hides prone soldiers but not standing ones.
//
// Concealment: each tile the ray passes through adds its concealment
// density. Sight is blocked once the total reaches blockingConcealment
// (a few tiles of forest). Concealment never stops bullets; that is cover.
//
// Where the ray passes exactly through a tile corner, the more open of
// the two side tiles counts, so LOS is symmetric and does not leak
// through solid diagonal walls.

import { tileAt } from './map.js';

// Float tolerance so concealment sums compare the same in both directions
// (addition order changes the last bits). Numerical, not a balance value.
const EPS = 1e-9;

// Tiles strictly between a and b. Each entry is one tile, or a pair of
// tiles when the ray passes exactly through their shared corner.
export function rayTiles(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const steps = [];
  let x = a.x;
  let y = a.y;
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      steps.push({ pair: [{ x: x + sx, y }, { x, y: y + sy }] });
      x += sx;
      y += sy;
      ix++;
      iy++;
    } else if (decision < 0) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    if (x === b.x && y === b.y) break;
    steps.push({ tile: { x, y } });
  }
  return steps;
}

function distanceTiles(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Fraction along a -> b of the point on the line closest to tile p.
function along(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
}

// How one tile affects the ray: { heightBlock, margin, concealment }.
function tileEffect(map, vision, a, b, eyeA, eyeB, p) {
  const tile = tileAt(map, p.x, p.y);
  const obstacle = vision.obstacleHeightM[tile.height];
  const t = along(a, b, p);
  const lineHeight = eyeA + (eyeB - eyeA) * t;
  return {
    tile: p,
    heightBlock: obstacle > 0 && obstacle >= lineHeight,
    margin: obstacle > 0 ? lineHeight - obstacle : Infinity,
    concealment: vision.concealmentDensity[tile.concealment],
    what: describe(tile),
  };
}

function describe(tile) {
  if (tile.feature === 'window') return 'window';
  if (tile.height === 2) return 'wall';
  if (tile.height === 1) return 'low wall';
  return tile.terrain;
}

// Line of sight from soldier-like a ({ pos, stance }) to b.
// Returns {
//   clear: boolean,
//   reason: null | 'out of range' | '<what> at x,y' | 'too much concealment (forest) at x,y',
//   blockedAt: {x, y} | null,
//   concealment: total along the ray (0 when clear of vegetation),
//   partial: true if the line only just clears a low obstacle (target partly hidden),
//   rangeM,
// }
export function lineOfSight(map, balance, a, b) {
  const vision = balance.vision;
  const rangeM = distanceTiles(a.pos, b.pos) * balance.map.tileMeters;
  const base = { clear: false, blockedAt: null, concealment: 0, partial: false, rangeM };
  if (rangeM > vision.maxRangeM) return { ...base, reason: 'out of range' };

  const eyeA = vision.eyeHeightM[a.stance];
  const eyeB = vision.eyeHeightM[b.stance];
  let concealment = 0;
  let minMargin = Infinity;

  for (const step of rayTiles(a.pos, b.pos)) {
    let effect;
    if (step.pair) {
      const [e1, e2] = step.pair.map((p) => tileEffect(map, vision, a.pos, b.pos, eyeA, eyeB, p));
      // The more open side counts: not blocked if either side is open,
      // then the smaller concealment and the larger clearance.
      if (e1.heightBlock !== e2.heightBlock) effect = e1.heightBlock ? e2 : e1;
      else effect = e1.concealment <= e2.concealment ? e1 : e2;
      if (!effect.heightBlock) effect = { ...effect, margin: Math.max(e1.margin, e2.margin) };
    } else {
      effect = tileEffect(map, vision, a.pos, b.pos, eyeA, eyeB, step.tile);
    }
    if (effect.heightBlock) {
      return { ...base, concealment, reason: `${effect.what} at ${effect.tile.x},${effect.tile.y}`, blockedAt: effect.tile };
    }
    minMargin = Math.min(minMargin, effect.margin);
    concealment += effect.concealment;
    if (concealment >= vision.blockingConcealment - EPS) {
      return {
        ...base,
        concealment,
        reason: `too much concealment (${effect.what}) at ${effect.tile.x},${effect.tile.y}`,
        blockedAt: effect.tile,
      };
    }
  }
  return { ...base, clear: true, reason: null, concealment, partial: minMargin < vision.partialExposureMarginM };
}
