// Hex map: one character per hex in odd-r offset rows, a legend mapping
// characters to terrain types from balance.terrain, hexside features, and
// the units' start hexes. Parsed maps are frozen and shared between states.
//
// hexsides: [{ hex: [col, row], sides: ['SE', 'SW'], feature: 'parapet' }]
// A feature whose balance.hexsides entry is `shared` (wall, hedge) is on the
// edge between two hexes and counts for both; one that is not (parapet)
// belongs only to the hex it is listed on.

import { SIDES, key, neighborOn, opposite } from './hex.js';

export function parseMap(json, balance) {
  const { name = 'Untitled', width, height, legend, rows, units = [], objective = null, hexsides = [] } = json;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Map size must be positive integers, got ${width} x ${height}`);
  }
  if (!Array.isArray(rows) || rows.length !== height) throw new Error(`Map has ${rows?.length} rows, expected ${height}`);
  for (const [char, terrain] of Object.entries(legend ?? {})) {
    if (!balance.terrain[terrain]) throw new Error(`Legend '${char}': unknown terrain '${terrain}'`);
  }
  const terrain = [];
  rows.forEach((r, row) => {
    const chars = [...r];
    if (chars.length !== width) throw new Error(`Row ${row} has ${chars.length} hexes, expected ${width}`);
    chars.forEach((c, col) => {
      if (!legend[c]) throw new Error(`Unknown hex '${c}' at ${col},${row}`);
      terrain.push(legend[c]);
    });
  });
  const map = { name, width, height, terrain: Object.freeze(terrain), units: Object.freeze(units.map((u) => Object.freeze({ ...u }))), objective, sides: {} };

  // sides: "col,row" -> { SIDE: feature }
  const put = (h, side, feature) => {
    map.sides[key(h)] ??= {};
    map.sides[key(h)][side] = feature;
  };
  for (const entry of hexsides) {
    const h = { col: entry.hex?.[0], row: entry.hex?.[1] };
    const f = balance.hexsides[entry.feature];
    if (!f) throw new Error(`Hexside at ${key(h)}: unknown feature '${entry.feature}'`);
    if (!inBounds(map, h)) throw new Error(`Hexside ${entry.feature} at ${key(h)} is off the map`);
    for (const side of entry.sides ?? []) {
      if (!SIDES.includes(side)) throw new Error(`Hexside at ${key(h)}: unknown side '${side}' (use ${SIDES.join(', ')})`);
      put(h, side, entry.feature);
      const n = neighborOn(h, side);
      if (f.shared && inBounds(map, n)) put(n, opposite(side), entry.feature);
    }
  }
  for (const v of Object.values(map.sides)) Object.freeze(v);
  Object.freeze(map.sides);

  const taken = new Set();
  for (const u of units) {
    const [col, row] = u.pos ?? [];
    const h = { col, row };
    if (!inBounds(map, h)) throw new Error(`${u.side} ${u.team} starts off the map`);
    if (terrainOf(map, balance, h).move === 'impassable') throw new Error(`${u.side} ${u.team} starts on impassable ground at ${col},${row}`);
    // One fireteam per hex, plus a leader.
    const slot = `${col},${row},${u.kind ?? 'team'}`;
    if (taken.has(slot)) throw new Error(`Two units start on ${col},${row}`);
    taken.add(slot);
  }
  return Object.freeze(map);
}

export function inBounds(map, h) {
  return Number.isInteger(h?.col) && Number.isInteger(h?.row) && h.col >= 0 && h.row >= 0 && h.col < map.width && h.row < map.height;
}

export function terrainName(map, h) {
  return map.terrain[h.row * map.width + h.col];
}

// Feature on side `side` of hex h, or null.
export function sideFeature(map, h, side) {
  return map.sides[key(h)]?.[side] ?? null;
}

export function terrainOf(map, balance, h) {
  return balance.terrain[terrainName(map, h)];
}
