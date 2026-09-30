// Order preview text. Built from the same planOrders the sim uses,
// so what it says is what will happen. No DOM.

import { stepCost } from '../sim/map.js';
import { teamsOf } from '../sim/state.js';

const SPEED_WORD = { walk: 'walk', run: 'run', crawl: 'crawl' };

function roundSec(sec) {
  return sec < 10 ? Math.round(sec * 2) / 2 : Math.round(sec);
}

function viaText(via) {
  if (!via?.length) return '';
  return via.length === 1 ? ' via 1 waypoint' : ` via ${via.length} waypoints`;
}

function arrival(sec, durationSec) {
  const turns = Math.max(1, Math.ceil(sec / durationSec));
  return turns === 1 ? 'arrives this turn' : `arrives in ${turns} turns`;
}

// Seconds left on a move already under way.
export function remainingMoveSec(state, soldier) {
  const m = soldier.move;
  if (!m) return 0;
  const { movement } = state.balance;
  let cost = 0;
  let at = soldier.pos;
  for (let i = m.i; i < m.path.length; i++) {
    cost += stepCost(state.map, movement, at, m.path[i]);
    at = m.path[i];
  }
  return Math.max(0, cost - m.progress) / (movement.speedMps[m.speed] / state.balance.map.tileMeters);
}

// Returns [{ team, text, notes: [string] }] for each team on `side`.
export function previewLines(state, side, plans) {
  const { durationSec } = state.balance.turn;
  const tileMeters = state.balance.map.tileMeters;
  const soldierById = new Map(state.soldiers.map((s) => [s.id, s]));
  const lines = [];

  for (const team of teamsOf(state, side)) {
    const plan = plans.find((p) => p.order?.side === side && p.order?.team === team && p.ok !== false)
      ?? plans.find((p) => p.order?.side === side && p.order?.team === team);
    const notes = [];

    if (plan && !plan.ok) {
      lines.push({ team, text: `${team}: order not valid, ${plan.reason}.`, notes });
      continue;
    }
    if (plan?.order.type === 'hold') {
      lines.push({ team, text: `${team}: hold. Stops at current position.`, notes });
      continue;
    }
    if (plan?.order.type === 'move') {
      const { dest, speed } = plan.order;
      const moving = plan.soldiers.filter((p) => p.path);
      for (const p of plan.soldiers) {
        if (!p.path) notes.push(`${soldierById.get(p.id).role} will not move: ${p.reason}.`);
      }
      if (moving.length === 0) {
        lines.push({ team, text: `${team}: cannot move to ${dest.x},${dest.y}.`, notes });
        continue;
      }
      const meters = Math.round(Math.max(...moving.map((p) => p.path.length)) * tileMeters);
      const sec = Math.max(...moving.map((p) => p.etaSec));
      lines.push({
        team,
        text: `${team}: ${SPEED_WORD[speed]} to ${dest.x},${dest.y}${viaText(plan.order.via)}. About ${meters} m, ${roundSec(sec)} s, ${arrival(sec, durationSec)}.`,
        notes,
      });
      continue;
    }

    const moving = state.soldiers.filter((s) => s.side === side && s.team === team && s.move);
    if (moving.length > 0) {
      const sec = Math.max(...moving.map((s) => remainingMoveSec(state, s)));
      const lead = moving.find((s) => s.role === 'TL') ?? moving[0];
      lines.push({
        team,
        text: `${team}: continuing ${SPEED_WORD[lead.move.speed]} to ${lead.move.dest.x},${lead.move.dest.y}. About ${roundSec(sec)} s left, ${arrival(sec, durationSec)}.`,
        notes,
      });
    } else {
      lines.push({ team, text: `${team}: holding. No order.`, notes });
    }
  }
  return lines;
}
