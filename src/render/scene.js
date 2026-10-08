// Draws the map view: ground, tile grid, fire markers, team counters.
import { COLORS } from './style.js';
import { drawFireLine, drawFireTarget, drawTeamCounter } from './counters.js';

export function tileCenter(pos, tile) {
  return { x: (pos.x + 0.5) * tile, y: (pos.y + 0.5) * tile };
}

export function drawScene(ctx, { map, summaries, fireMarkers, tile }) {
  const w = map.width * tile;
  const h = map.height * tile;
  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= map.width; x++) {
    ctx.moveTo(x * tile + 0.5, 0);
    ctx.lineTo(x * tile + 0.5, h);
  }
  for (let y = 0; y <= map.height; y++) {
    ctx.moveTo(0, y * tile + 0.5);
    ctx.lineTo(w, y * tile + 0.5);
  }
  ctx.stroke();

  const byId = new Map(summaries.map((s) => [s.id, s]));
  for (const f of fireMarkers) {
    const from = tileCenter(f.from, tile);
    const to = tileCenter(f.target, tile);
    drawFireLine(ctx, from.x, from.y, to.x, to.y);
  }
  for (const f of fireMarkers) {
    const to = tileCenter(f.target, tile);
    drawFireTarget(ctx, byId.get(f.team)?.letter ?? '?', to.x, to.y, tile);
  }
  for (const s of summaries) {
    if (!s.pos) continue;
    const c = tileCenter(s.pos, tile);
    drawTeamCounter(ctx, s, c.x, c.y);
  }
}
