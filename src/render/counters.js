// NATO-style team counters, state badges and fire markers. Canvas drawing
// only: everything drawn here is read from a team summary or fire marker
// produced by the sim.
import { COLORS, COUNTER, FIRE_MARKER, FONT } from './style.js';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Down chevrons centred on (cx, cy): one for suppressed, two for pinned.
function drawChevrons(ctx, cx, cy, count, color) {
  const halfW = 6;
  const drop = 4;
  const step = 5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'miter';
  const top = cy - ((count - 1) * step) / 2 - drop / 2;
  for (let i = 0; i < count; i++) {
    const y = top + i * step;
    ctx.beginPath();
    ctx.moveTo(cx - halfW, y);
    ctx.lineTo(cx, y + drop);
    ctx.lineTo(cx + halfW, y);
    ctx.stroke();
  }
  ctx.restore();
}

// Suppression badge for the counter's top-right corner. Draws nothing for
// level 'none'. (x, y) is the frame's top-right corner.
export function drawStateBadge(ctx, level, x, y) {
  if (level !== 'suppressed' && level !== 'pinned') return;
  const b = COUNTER.badge;
  const pinned = level === 'pinned';
  const h = pinned ? b.pinnedH : b.suppressedH;
  const bx = x + b.overhangX - b.w;
  const by = y + b.dropY - h;
  ctx.save();
  roundRect(ctx, bx, by, b.w, h, b.radius);
  ctx.fillStyle = pinned ? COLORS.pinned : COLORS.suppressed;
  ctx.fill();
  ctx.lineWidth = b.stroke;
  ctx.strokeStyle = COLORS.ink;
  ctx.stroke();
  ctx.restore();
  drawChevrons(ctx, bx + b.w / 2, by + h / 2, pinned ? 2 : 1, pinned ? COLORS.pinnedInk : COLORS.ink);
}

function drawEchelonTeam(ctx, cx, cy, size) {
  const r = size * 0.31;
  ctx.save();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = size * 0.115;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.38, cy + size * 0.38);
  ctx.lineTo(cx + size * 0.38, cy - size * 0.38);
  ctx.stroke();
  ctx.restore();
}

function drawPip(ctx, x, y, filled) {
  const r = COUNTER.pip / 2;
  ctx.beginPath();
  ctx.arc(x + r, y + r, r - COUNTER.pipStroke / 2, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = COLORS.ink;
    ctx.fill();
  }
  ctx.lineWidth = COUNTER.pipStroke;
  ctx.strokeStyle = COLORS.ink;
  ctx.stroke();
}

// One pip group per soldier, in roster order. Filled = hitpoint left,
// hollow = hitpoint lost.
export function drawHitpoints(ctx, roster, x, y) {
  ctx.save();
  let px = x;
  for (const s of roster) {
    for (let i = 0; i < s.hpMax; i++) {
      drawPip(ctx, px, y, i < s.hp);
      px += COUNTER.pip + COUNTER.pipGap;
    }
    px += COUNTER.pipGroupGap - COUNTER.pipGap;
  }
  ctx.restore();
}

// Friendly infantry fireteam counter centred on (cx, cy) in pixels.
export function drawTeamCounter(ctx, summary, cx, cy) {
  const { w, h, stroke } = COUNTER;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const pinned = summary.suppressionLevel === 'pinned';

  ctx.save();
  ctx.fillStyle = COLORS.friendly;
  ctx.fillRect(x, y, w, h);

  if (pinned) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = COLORS.hatch;
    ctx.lineWidth = COUNTER.hatchWidth;
    for (let d = -h; d < w + h; d += COUNTER.hatchSpacing) {
      ctx.beginPath();
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + d - h, y + h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Infantry: an X corner to corner inside the frame.
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = stroke;
  const i = stroke / 2;
  ctx.beginPath();
  ctx.moveTo(x + i, y + i);
  ctx.lineTo(x + w - i, y + h - i);
  ctx.moveTo(x + w - i, y + i);
  ctx.lineTo(x + i, y + h - i);
  ctx.stroke();
  ctx.strokeRect(x + i, y + i, w - stroke, h - stroke);

  // Echelon: fireteam.
  drawEchelonTeam(ctx, cx, y - COUNTER.echelonGap - COUNTER.echelonSize / 2, COUNTER.echelonSize);

  // Unique designation to the right of the frame.
  ctx.fillStyle = COLORS.ink;
  ctx.font = `700 ${COUNTER.letterSize}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(summary.letter, x + w + COUNTER.letterGap, y + h);
  ctx.restore();

  drawStateBadge(ctx, summary.suppressionLevel, x + w, y);
  drawHitpoints(ctx, summary.roster, x, y + h + COUNTER.pipTop);
}

// Crosshair on the tile a team fired at this turn, with the team letter.
// (tx, ty) is the target tile's centre, tile is the tile size in pixels.
export function drawFireTarget(ctx, letter, tx, ty, tile) {
  const m = FIRE_MARKER;
  const r = m.size * 0.27;
  const half = m.size / 2;
  ctx.save();
  ctx.fillStyle = COLORS.fireTile;
  ctx.fillRect(tx - tile / 2, ty - tile / 2, tile, tile);
  ctx.strokeStyle = COLORS.fire;
  ctx.lineWidth = m.stroke;
  ctx.strokeRect(tx - tile / 2, ty - tile / 2, tile, tile);

  ctx.beginPath();
  ctx.arc(tx, ty, r, 0, Math.PI * 2);
  ctx.moveTo(tx, ty - half);
  ctx.lineTo(tx, ty - r);
  ctx.moveTo(tx, ty + r);
  ctx.lineTo(tx, ty + half);
  ctx.moveTo(tx - half, ty);
  ctx.lineTo(tx - r, ty);
  ctx.moveTo(tx + r, ty);
  ctx.lineTo(tx + half, ty);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tx, ty, m.stroke * 1.2, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.fire;
  ctx.fill();

  ctx.font = `700 ${m.tagSize}px ${FONT}`;
  const tagW = ctx.measureText(letter).width + 10;
  const tagH = m.tagSize + 4;
  const tagX = tx + half - 4;
  const tagY = ty - half - tagH / 2;
  ctx.fillRect(tagX, tagY, tagW, tagH);
  ctx.fillStyle = COLORS.fireInk;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, tagX + tagW / 2, tagY + tagH / 2 + 1);
  ctx.restore();
}

// Dashed line of fire from the shooter to the target, both in pixels.
export function drawFireLine(ctx, fromX, fromY, toX, toY) {
  ctx.save();
  ctx.strokeStyle = COLORS.fire;
  ctx.lineWidth = FIRE_MARKER.lineWidth;
  ctx.setLineDash(FIRE_MARKER.dash);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  ctx.restore();
}
