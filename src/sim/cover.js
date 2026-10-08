// Directional cover from hexsides.
//
// A unit's cover against fire from hex `from` is the better of:
//   - its hex's terrain (woods, buildings, trench... protect all round), and
//   - a feature on the side of its hex that faces the shooter (wall, hedge,
//     parapet).
// Cover is the casualty roll number: a hit only becomes a casualty on that
// number or more, so higher is better. When the line of fire runs exactly
// through a hex corner, the better of the two sides counts (defender's
// benefit). Fire from any other side gets only the terrain: that is flanking.

import { key, sidesFacing } from './hex.js';
import { sideFeature, terrainName, terrainOf } from './map.js';

// { casualtyOn, source: 'terrain' | 'hexside', feature, side, terrain, sides }
export function coverAgainst(map, balance, targetHex, from) {
  const terrain = terrainName(map, targetHex);
  let best = { casualtyOn: terrainOf(map, balance, targetHex).casualtyOn, source: 'terrain', feature: null, side: null, terrain };
  const sides = sidesFacing(targetHex, from);
  for (const side of sides) {
    const feature = sideFeature(map, targetHex, side);
    if (!feature) continue;
    const on = balance.hexsides[feature].casualtyOn;
    if (on > best.casualtyOn) best = { casualtyOn: on, source: 'hexside', feature, side, terrain };
  }
  return { ...best, sides, hex: key(targetHex) };
}

// "behind a parapet (SE side)" / "in woods"
export function describeCover(c) {
  return c.source === 'hexside' ? `behind a ${c.feature} (${c.side} side)` : `in ${c.terrain}`;
}
