// Canvas drawing only. Reads state and view data, never changes the sim.

import { toScreen } from './camera.js';

const TILE_PX = 16; // resolution of the cached terrain layer

export const COLORS = {
  background: '#111410',
  grid: 'rgba(0, 0, 0, 0.18)',
  terrain: {
    open: '#7d7352',
    road: '#8d887b',
    grass: '#4d6b3a',
    scrub: '#5b7338',
    forest: '#2c4527',
    rubble: '#6e6a62',
    water: '#2f5470',
  },
  wall: '#34332f',
  wallEdge: '#1e1d1a',
  lowWall: '#9a948a',
  door: '#a07a45',
  window: '#86aabb',
  blufor: '#4a7fd0',
  opfor: '#d04a4a',
  team: { ALPHA: '#f0a030', BRAVO: '#7fd06a', CHARLIE: '#c07fe0', DELTA: '#e0e060' },
  counterText: '#ffffff',
  hover: 'rgba(255, 255, 255, 0.7)',
  losClear: 'rgba(120, 230, 120, 0.9)',
  losBlocked: 'rgba(240, 90, 70, 0.9)',
  select: '#ffffff',
};

export function teamColor(team) {
  return COLORS.team[team] ?? '#cccccc';
}

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = canvas;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: w, height: h };
}

// Deterministic speckle so textured tiles look the same every load.
function speckle(x, y, i) {
  let h = (x * 374761393 + y * 668265263 + i * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

function drawTile(g, tile, x, y) {
  const px = x * TILE_PX;
  const py = y * TILE_PX;
  const s = TILE_PX;

  if (tile.height === 2) {
    g.fillStyle = COLORS.wall;
    g.fillRect(px, py, s, s);
    g.strokeStyle = COLORS.wallEdge;
    g.lineWidth = 2;
    g.strokeRect(px + 1, py + 1, s - 2, s - 2);
    return;
  }

  g.fillStyle = COLORS.terrain[tile.terrain];
  g.fillRect(px, py, s, s);

  if (tile.terrain === 'forest' || tile.terrain === 'scrub') {
    g.fillStyle = tile.terrain === 'forest' ? '#1f331c' : '#6e8a45';
    const n = tile.terrain === 'forest' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const cx = px + 3 + speckle(x, y, i) * (s - 6);
      const cy = py + 3 + speckle(x, y, i + 7) * (s - 6);
      g.beginPath();
      g.arc(cx, cy, tile.terrain === 'forest' ? 3.5 : 2, 0, Math.PI * 2);
      g.fill();
    }
  } else if (tile.terrain === 'rubble') {
    g.fillStyle = '#4f4b45';
    for (let i = 0; i < 4; i++) {
      g.fillRect(px + speckle(x, y, i) * (s - 3), py + speckle(x, y, i + 11) * (s - 3), 3, 3);
    }
  }

  if (tile.feature === 'window') {
    g.fillStyle = COLORS.wall;
    g.fillRect(px, py, s, s);
    g.fillStyle = COLORS.window;
    g.fillRect(px + 4, py + 4, s - 8, s - 8);
  } else if (tile.feature === 'door') {
    g.fillStyle = COLORS.door;
    g.fillRect(px + 2, py + 2, s - 4, s - 4);
  } else if (tile.height === 1) {
    g.fillStyle = COLORS.lowWall;
    g.fillRect(px + 1, py + s * 0.3, s - 2, s * 0.4);
  }
}

// Render the static terrain once to an offscreen canvas.
export function buildTerrainLayer(map) {
  const layer = document.createElement('canvas');
  layer.width = map.width * TILE_PX;
  layer.height = map.height * TILE_PX;
  const g = layer.getContext('2d');
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) drawTile(g, map.tiles[y * map.width + x], x, y);
  }
  return layer;
}

export function drawTerrain(ctx, cam, layer, map, width, height) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  const o = toScreen(cam, 0, 0);
  ctx.imageSmoothingEnabled = cam.scale < TILE_PX;
  ctx.drawImage(layer, o.x, o.y, map.width * cam.scale, map.height * cam.scale);

  if (cam.scale >= 12) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.max(0, Math.floor(cam.x));
    const y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(map.width, Math.ceil(cam.x + width / cam.scale));
    const y1 = Math.min(map.height, Math.ceil(cam.y + height / cam.scale));
    for (let x = x0; x <= x1; x++) {
      const sx = Math.round(toScreen(cam, x, 0).x) + 0.5;
      ctx.moveTo(sx, toScreen(cam, 0, y0).y);
      ctx.lineTo(sx, toScreen(cam, 0, y1).y);
    }
    for (let y = y0; y <= y1; y++) {
      const sy = Math.round(toScreen(cam, 0, y).y) + 0.5;
      ctx.moveTo(toScreen(cam, x0, 0).x, sy);
      ctx.lineTo(toScreen(cam, x1, 0).x, sy);
    }
    ctx.stroke();
  }
}

// paths: [{ from: {x, y}, path: [{x, y}], color, dashed }]
export function drawPaths(ctx, cam, paths) {
  for (const p of paths) {
    if (!p.path.length) continue;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(1.5, cam.scale * 0.12);
    ctx.setLineDash(p.dashed ? [cam.scale * 0.4, cam.scale * 0.3] : []);
    ctx.globalAlpha = p.dashed ? 0.6 : 0.9;
    ctx.beginPath();
    const s = toScreen(cam, p.from.x + 0.5, p.from.y + 0.5);
    ctx.moveTo(s.x, s.y);
    for (const q of p.path) {
      const t = toScreen(cam, q.x + 0.5, q.y + 0.5);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();
    const end = p.path[p.path.length - 1];
    const e = toScreen(cam, end.x + 0.2, end.y + 0.2);
    ctx.setLineDash([]);
    ctx.strokeRect(e.x, e.y, cam.scale * 0.6, cam.scale * 0.6);
    ctx.globalAlpha = 1;
  }
  ctx.setLineDash([]);
}

// Waypoint markers: [{ x, y, color }]
export function drawWaypoints(ctx, cam, points) {
  for (const p of points) {
    const c = toScreen(cam, p.x + 0.5, p.y + 0.5);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(3, cam.scale * 0.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// Suspected contacts: dashed diamond with a question mark at the last known position.
export function drawSuspected(ctx, cam, points) {
  const size = Math.max(8, cam.scale * 0.9);
  for (const p of points) {
    const c = toScreen(cam, p.x + 0.5, p.y + 0.5);
    ctx.strokeStyle = COLORS.opfor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - size * 0.55);
    ctx.lineTo(c.x + size * 0.55, c.y);
    ctx.lineTo(c.x, c.y + size * 0.55);
    ctx.lineTo(c.x - size * 0.55, c.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.opfor;
    ctx.font = `bold ${Math.max(8, Math.round(size * 0.6))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', c.x, c.y + 1);
  }
}

// LOS check lines: [{ from, to, clear, blockedAt }]. Green to the target
// when clear; red up to the blocking tile when not.
export function drawSightLines(ctx, cam, lines) {
  for (const l of lines) {
    const a = toScreen(cam, l.from.x + 0.5, l.from.y + 0.5);
    const end = l.clear ? l.to : l.blockedAt ?? l.to;
    const b = toScreen(cam, end.x + 0.5, end.y + 0.5);
    ctx.strokeStyle = l.clear ? COLORS.losClear : COLORS.losBlocked;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (!l.clear && l.blockedAt) {
      ctx.strokeRect(b.x - cam.scale / 2, b.y - cam.scale / 2, cam.scale, cam.scale);
    }
  }
}

export function drawHover(ctx, cam, tile) {
  if (!tile) return;
  const s = toScreen(cam, tile.x, tile.y);
  ctx.strokeStyle = COLORS.hover;
  ctx.lineWidth = 1;
  ctx.strokeRect(s.x + 0.5, s.y + 0.5, cam.scale - 1, cam.scale - 1);
}

// NATO-style counters. BLUFOR: blue rectangle. OPFOR: red diamond.
// Team color stripe on top. Prone soldiers are drawn flatter.
// soldiers: [{ soldier, pos: {x, y} (fractional tile), selected, ghost }]
// ghost: drawn faint (debug view of soldiers the player has not spotted).
export function drawSoldiers(ctx, cam, soldiers) {
  const size = Math.max(8, cam.scale * 0.9);
  for (const { soldier, pos, selected, ghost } of soldiers) {
    if (soldier.status === 'dead') continue;
    ctx.globalAlpha = ghost ? 0.35 : 1;
    const c = toScreen(cam, pos.x + 0.5, pos.y + 0.5);
    const w = size;
    const h = soldier.stance === 'prone' ? size * 0.5 : size * 0.7;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? COLORS.select : '#000000';
    if (soldier.side === 'OPFOR') {
      ctx.fillStyle = COLORS.opfor;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - h * 0.75);
      ctx.lineTo(c.x + w * 0.5, c.y);
      ctx.lineTo(c.x, c.y + h * 0.75);
      ctx.lineTo(c.x - w * 0.5, c.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = COLORS.blufor;
      ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h);
      ctx.fillStyle = teamColor(soldier.team);
      ctx.fillRect(c.x - w / 2, c.y - h / 2, w, Math.max(2, h * 0.22));
      ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
    }
    if (cam.scale >= 18) {
      ctx.fillStyle = COLORS.counterText;
      ctx.font = `bold ${Math.round(cam.scale * 0.3)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(soldier.role, c.x, c.y + (soldier.side === 'OPFOR' ? 0 : h * 0.1));
    }
  }
  ctx.globalAlpha = 1;
}
