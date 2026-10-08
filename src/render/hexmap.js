// Canvas drawing of the hex map and counters. Reads state, never changes it.

import { toScreen } from './camera.js';
import { SIDES, center, corners, neighbors } from '../sim/hex.js';
import { inBounds, terrainName } from '../sim/map.js';

export const COLORS = {
  background: '#111410',
  hexEdge: 'rgba(0, 0, 0, 0.35)',
  terrain: {
    open: '#6b8a4a',
    road: '#a39a84',
    scrub: '#6f8540',
    woods: '#2f4a2a',
    rubble: '#7a746a',
    building: '#6a5f55',
    trench: '#7d6a48',
    water: '#2f5470',
  },
  blufor: '#4a7fd0',
  opfor: '#d04a4a',
  counterEdge: '#0b0d0a',
  counterText: '#ffffff',
  suppressed: '#e8c547',
  pinned: '#ff6a3d',
  exposed: '#ffffff',
  select: '#ffffff',
  move: 'rgba(140, 230, 140, 0.9)',
  fast: 'rgba(255, 190, 80, 0.9)',
  rally: 'rgba(120, 200, 255, 0.95)',
  plan: '#ffffff',
  objective: '#f2d24b',
  hexside: {
    wall: { color: '#c9c3b6', width: 0.13, dash: null, inset: 0 },
    hedge: { color: '#24401f', width: 0.16, dash: [0.12, 0.08], inset: 0 },
    parapet: { color: '#4a3a22', width: 0.14, dash: null, inset: 0.12 },
  },
};

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

function hexPath(ctx, cam, h, inset = 0) {
  const c = center(h);
  const pts = corners(h).map((p) => toScreen(cam, c.x + (p.x - c.x) * (1 - inset), c.y + (p.y - c.y) * (1 - inset)));
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

// Deterministic speckle so textures look the same every frame.
function speckle(col, row, i) {
  let h = (col * 374761393 + row * 668265263 + i * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

function drawTerrainDetail(ctx, cam, h, terrain, map) {
  const c = toScreen(cam, center(h).x, center(h).y);
  const s = cam.scale;
  const dot = (x, y, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const scatter = (n, r, color) => {
    for (let i = 0; i < n; i++) {
      const a = speckle(h.col, h.row, i) * Math.PI * 2;
      const d = Math.sqrt(speckle(h.col, h.row, i + 17)) * 0.62 * s;
      dot(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, r, color);
    }
  };
  switch (terrain) {
    case 'woods': scatter(9, s * 0.16, '#1f331c'); break;
    case 'scrub': scatter(7, s * 0.07, '#8aa35a'); break;
    case 'rubble': scatter(10, s * 0.05, '#4f4b45'); break;
    case 'building':
      ctx.fillStyle = '#3d3630';
      ctx.fillRect(c.x - s * 0.45, c.y - s * 0.35, s * 0.9, s * 0.7);
      ctx.strokeStyle = '#2a2420';
      ctx.lineWidth = 2;
      ctx.strokeRect(c.x - s * 0.45, c.y - s * 0.35, s * 0.9, s * 0.7);
      break;
    case 'trench': {
      ctx.strokeStyle = '#3a2e1c';
      ctx.lineWidth = Math.max(2, s * 0.08);
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const x = c.x - s * 0.6 + (i * s * 1.2) / 6;
        const y = c.y + (i % 2 ? -1 : 1) * s * 0.15;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case 'road': {
      // Join the center to each neighboring road hex, so the road reads as one line.
      ctx.strokeStyle = '#8c846f';
      ctx.lineWidth = s * 0.24;
      ctx.lineCap = 'round';
      for (const n of neighbors(h)) {
        if (!inBounds(map, n) || terrainName(map, n) !== 'road') continue;
        const m = center(n);
        const e = toScreen(cam, (center(h).x + m.x) / 2, (center(h).y + m.y) / 2);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      break;
    }
    default:
      break;
  }
}

export function drawMap(ctx, cam, map, width, height, objective) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const h = { col, row };
      const t = terrainName(map, h);
      hexPath(ctx, cam, h);
      ctx.fillStyle = COLORS.terrain[t];
      ctx.fill();
      drawTerrainDetail(ctx, cam, h, t, map);
      hexPath(ctx, cam, h);
      ctx.strokeStyle = COLORS.hexEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  drawHexsides(ctx, cam, map);
  if (objective) {
    const c = toScreen(cam, center(objective).x, center(objective).y);
    ctx.strokeStyle = COLORS.objective;
    ctx.lineWidth = 2;
    hexPath(ctx, cam, objective, 0.08);
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.objective;
    ctx.font = `bold ${Math.round(cam.scale * 0.3)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('OBJ', c.x, c.y - cam.scale * 0.62);
  }
}

// Walls and hedges on the edge between hexes; parapets just inside their hex.
function drawHexsides(ctx, cam, map) {
  for (const [k, sides] of Object.entries(map.sides)) {
    const [col, row] = k.split(',').map(Number);
    const h = { col, row };
    const c = center(h);
    const pts = corners(h);
    for (const [side, feature] of Object.entries(sides)) {
      const style = COLORS.hexside[feature];
      const i = SIDES.indexOf(side);
      const [p, q] = [pts[i], pts[(i + 1) % 6]].map((pt) => ({ x: pt.x + (c.x - pt.x) * style.inset, y: pt.y + (c.y - pt.y) * style.inset }));
      const a = toScreen(cam, p.x, p.y);
      const b = toScreen(cam, q.x, q.y);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = Math.max(2, style.width * cam.scale);
      ctx.setLineDash(style.dash ? style.dash.map((d) => d * cam.scale) : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

// Suspected contacts: a dashed red outline with a question mark, at hex centers.
export function drawSuspected(ctx, cam, hexes) {
  for (const h of hexes) {
    const c = toScreen(cam, center(h).x, center(h).y);
    const w = cam.scale * 0.9;
    const hh = w * 0.78;
    ctx.strokeStyle = COLORS.opfor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(c.x - w / 2, c.y - hh / 2, w, hh);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.opfor;
    ctx.font = `bold ${Math.round(cam.scale * 0.5)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', c.x, c.y + 1);
  }
}

// Hex outlines: [{ hex, color, width, dashed, fill }]
export function drawHexMarks(ctx, cam, marks) {
  for (const m of marks) {
    hexPath(ctx, cam, m.hex, m.inset ?? 0.1);
    if (m.fill) {
      ctx.fillStyle = m.fill;
      ctx.fill();
    }
    if (!m.color) continue;
    ctx.strokeStyle = m.color;
    ctx.lineWidth = m.width ?? 2;
    ctx.setLineDash(m.dashed ? [5, 4] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// A planned path: hex centers joined by a line.
export function drawPath(ctx, cam, from, path, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, cam.scale * 0.08);
  ctx.beginPath();
  [from, ...path].forEach((h, i) => {
    const c = center(h);
    const p = toScreen(cam, c.x, c.y);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.stroke();
}

function badge(ctx, x, y, r, fill, text) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.counterEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#000000';
  ctx.font = `bold ${Math.round(r * 1.3)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

// NATO-style counters. units: [{ unit, pos: {x, y} world center, selected }].
// A fireteam: square with the infantry X, team name, one pip per soldier.
// The SL: smaller, with the headquarters staff line, drawn at the hex's
// upper right when it shares the hex with a team.
export function drawCounters(ctx, cam, units, roster) {
  for (const { unit, pos, selected, stackedWithTeam, ghost } of units) {
    if (unit.status === 'eliminated') continue;
    const leader = unit.kind === 'leader';
    const size = cam.scale * (leader ? 0.62 : 1.0);
    const offset = leader && stackedWithTeam ? cam.scale * 0.5 : 0;
    const c = toScreen(cam, pos.x + offset / cam.scale, pos.y - offset / cam.scale);
    const w = size;
    const h = size * 0.78;
    const x0 = c.x - w / 2;
    const y0 = c.y - h / 2;

    ctx.globalAlpha = ghost ? 0.3 : unit.activated ? 0.55 : 1;
    ctx.fillStyle = unit.side === 'OPFOR' ? COLORS.opfor : COLORS.blufor;
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = selected ? COLORS.select : COLORS.counterEdge;
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeRect(x0, y0, w, h);

    // Symbol box
    const bw = w * 0.56;
    const bh = h * 0.42;
    const bx = c.x - bw / 2;
    const by = y0 + h * 0.12;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, size * 0.04);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + bw, by + bh);
    ctx.moveTo(bx + bw, by);
    ctx.lineTo(bx, by + bh);
    ctx.stroke();
    if (leader) {
      ctx.beginPath();
      ctx.moveTo(bx, by + bh);
      ctx.lineTo(bx, by + bh + h * 0.3);
      ctx.stroke();
    }

    ctx.fillStyle = COLORS.counterText;
    ctx.font = `bold ${Math.max(8, Math.round(size * 0.2))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(unit.team, c.x + (leader ? w * 0.1 : 0), y0 + h * 0.86);

    // Pips: soldiers left out of the full roster.
    if (!leader) {
      const total = roster.length;
      const r = Math.max(1.5, size * 0.045);
      for (let i = 0; i < total; i++) {
        const px = x0 + w * 0.12 + i * r * 2.6;
        ctx.beginPath();
        ctx.arc(px, y0 + h * 0.07 + r, r, 0, Math.PI * 2);
        ctx.fillStyle = i < unit.soldiers.length ? '#ffffff' : 'rgba(0, 0, 0, 0.4)';
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    const br = Math.max(6, size * 0.16);
    if (unit.status === 'suppressed') badge(ctx, x0 + w, y0, br, COLORS.suppressed, 'S');
    if (unit.status === 'pinned') badge(ctx, x0 + w, y0, br, COLORS.pinned, 'P');
    if (unit.exposed) badge(ctx, x0, y0, br, COLORS.exposed, '!');
  }
}
