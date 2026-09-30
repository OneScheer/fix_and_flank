// Map model: a square tile grid loaded from a legend-based JSON file.
// Parsed maps are frozen and shared by reference between states.

export const TERRAINS = ['open', 'road', 'grass', 'scrub', 'forest', 'rubble', 'water'];
export const COVERS = ['none', 'light', 'heavy', 'hard'];
export const CONCEALMENTS = ['none', 'partial', 'full'];
export const FEATURES = ['none', 'door', 'window'];
export const HEIGHTS = [0, 1, 2];

const TILE_DEFAULTS = { height: 0, cover: 'none', concealment: 'none', feature: 'none' };

function parseLegendEntry(char, entry) {
  const tile = { ...TILE_DEFAULTS, ...entry };
  const check = (field, allowed) => {
    if (!allowed.includes(tile[field])) {
      throw new Error(`Legend '${char}': bad ${field} '${tile[field]}' (allowed: ${allowed.join(', ')})`);
    }
  };
  check('terrain', TERRAINS);
  check('height', HEIGHTS);
  check('cover', COVERS);
  check('concealment', CONCEALMENTS);
  check('feature', FEATURES);
  return Object.freeze(tile);
}

export function parseMap(json) {
  const { name = 'Untitled', width, height, legend, rows, units = [] } = json;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Map size must be positive integers, got ${width} x ${height}`);
  }
  if (!Array.isArray(rows) || rows.length !== height) {
    throw new Error(`Map has ${rows?.length} rows, expected ${height}`);
  }

  const kinds = {};
  for (const [char, entry] of Object.entries(legend ?? {})) {
    if ([...char].length !== 1) throw new Error(`Legend key '${char}' must be one character`);
    kinds[char] = parseLegendEntry(char, entry);
  }

  const tiles = [];
  rows.forEach((row, y) => {
    const chars = [...row];
    if (chars.length !== width) throw new Error(`Row ${y} has ${chars.length} tiles, expected ${width}`);
    chars.forEach((char, x) => {
      const tile = kinds[char];
      if (!tile) throw new Error(`Unknown tile '${char}' at ${x},${y}`);
      tiles.push(tile);
    });
  });

  const map = { name, width, height, tiles: Object.freeze(tiles), units: Object.freeze(units.map((u) => Object.freeze({ ...u }))) };

  const taken = new Set();
  for (const u of units) {
    const [x, y] = u.pos ?? [];
    if (!inBounds(map, x, y)) throw new Error(`Unit ${u.side} ${u.team} ${u.role} is off the map`);
    if (!isPassable(tileAt(map, x, y))) throw new Error(`Unit ${u.side} ${u.team} ${u.role} starts on an impassable tile at ${x},${y}`);
    if (taken.has(y * width + x)) throw new Error(`Two units start on ${x},${y}`);
    taken.add(y * width + x);
  }

  return Object.freeze(map);
}

export function inBounds(map, x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function tileAt(map, x, y) {
  return map.tiles[y * map.width + x];
}

// Water, high walls and windows block movement. Doors are gaps in walls.
export function isPassable(tile) {
  return tile.terrain !== 'water' && tile.height < 2 && tile.feature !== 'window';
}

// Cost in tile-lengths to step from a to an adjacent tile b, or Infinity if blocked.
// Diagonal steps may not cut the corner of an impassable tile.
export function stepCost(map, movement, a, b) {
  if (!inBounds(map, b.x, b.y)) return Infinity;
  const tile = tileAt(map, b.x, b.y);
  if (!isPassable(tile)) return Infinity;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const diagonal = dx !== 0 && dy !== 0;
  if (diagonal && (!isPassable(tileAt(map, a.x + dx, a.y)) || !isPassable(tileAt(map, a.x, a.y + dy)))) {
    return Infinity;
  }
  const terrainCost = movement.terrainCost[tile.terrain];
  const obstacle = tile.height === 1 ? movement.lowObstacleCost : 1;
  return (diagonal ? Math.SQRT2 : 1) * terrainCost * obstacle;
}
