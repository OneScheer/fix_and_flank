// Line of sight on hexes.
//
// Sight runs from hex center to hex center. A hex in between whose terrain
// blocks sight (woods, buildings) blocks it; the observer's and the target's
// own hexes never block. A hexside feature that blocks sight (a hedge) blocks
// it where the line crosses that side, unless the side belongs to the
// observer's or the target's hex: a unit at a hedgerow sees over it.
//
// Where the line runs exactly along hex edges there are two ways to draw it;
// sight is clear if either is. Lines are always drawn from the same end, so
// line of sight is symmetric.

import { distance, key, line, sidesFacing } from './hex.js';
import { sideFeature, terrainName, terrainOf } from './map.js';

// Check one drawn line; returns null if clear, else { at, reason }.
function blockOnLine(map, balance, hexes) {
  const last = hexes.length - 1;
  for (let i = 1; i <= last; i++) {
    const prev = hexes[i - 1];
    const h = hexes[i];
    // The edge between prev and h. Its feature is stored on the hex that owns
    // it (both hexes for a shared feature); one owned by an end hex is ignored.
    const edge = [
      { owner: prev, isEnd: i - 1 === 0, side: sidesFacing(prev, h)[0] },
      { owner: h, isEnd: i === last, side: sidesFacing(h, prev)[0] },
    ];
    for (const e of edge) {
      const f = sideFeature(map, e.owner, e.side);
      if (f && balance.hexsides[f].blocksLos && !e.isEnd && !edge.some((x) => x.isEnd && sideFeature(map, x.owner, x.side) === f)) {
        return { at: h, reason: `${f} between ${key(prev)} and ${key(h)}` };
      }
    }
    if (i < last && terrainOf(map, balance, h).blocksLos) return { at: h, reason: `${terrainName(map, h)} at ${key(h)}` };
  }
  return null;
}

// { clear, reason, blockedAt, range } from hex a to hex b.
export function lineOfSight(map, balance, a, b) {
  const range = distance(a, b);
  if (range > balance.vision.maxRangeHexes) return { clear: false, reason: 'out of sight range', blockedAt: null, range };
  // Always draw from the same end (rounding on exact edge ties is not
  // perfectly symmetric in floating point), so a -> b equals b -> a.
  const [p, q] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  const first = blockOnLine(map, balance, line(p, q, 1));
  if (!first) return { clear: true, reason: null, blockedAt: null, range };
  const second = blockOnLine(map, balance, line(p, q, -1));
  if (!second) return { clear: true, reason: null, blockedAt: null, range };
  return { clear: false, reason: first.reason, blockedAt: first.at, range };
}

// All hexes visible from hex a.
export function visibleFrom(map, balance, a) {
  const out = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const h = { col, row };
      if (lineOfSight(map, balance, a, h).clear) out.push(h);
    }
  }
  return out;
}
