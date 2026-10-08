// Order preview: one status line per team, plus notes, saying what the sim
// will actually do. Everything comes from sim code (planOrders, the sim's
// own fire decision on a copy of the state, and the predictions in
// sim/predict.js). No DOM.

import { stepCost } from '../sim/map.js';
import {
  ammoForecast, assaultForecast, firstActions, friendliesInDanger, grenadeLandingSec, knownEnemies,
  routeExposure, suppressionPerSec,
} from '../sim/predict.js';
import { inArc } from '../sim/combat.js';
import { teamsOf } from '../sim/state.js';

function roundSec(sec) {
  return sec < 10 ? Math.round(sec * 2) / 2 : Math.round(sec);
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function span(values, fmt) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`;
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

// "enemy at 40,21", "suspected enemy at 40,21" or "40,21", from what `side` knows.
export function describePoint(state, side, pos, targetId = null) {
  const c = targetId !== null && targetId !== undefined ? state.contacts[side]?.[targetId] : null;
  const p = c ? c.pos : pos;
  if (c?.level === 'spotted') return `enemy at ${p.x},${p.y}`;
  if (c?.level === 'suspected') return `suspected enemy at ${p.x},${p.y}`;
  return `${p.x},${p.y}`;
}

// Why a shot's chance is what it is, in plain words (also used by the log).
export function explainShot(state, shot) {
  const { combat } = state.balance;
  const f = shot.factors;
  const parts = [`range ${Math.round(shot.rangeM)} m`];
  if (f.cover < 1 && shot.cover?.tile) {
    const t = shot.cover.tile;
    const dir = typeof shot.cover.direction === 'string' ? shot.cover.direction : shot.cover.direction?.name;
    parts.push(t.x === shot.at?.x && t.y === shot.at?.y ? `target in ${t.what}` : `target behind ${t.what} from the ${dir}`);
  }
  const stance = Object.keys(combat.targetStance).find((k) => combat.targetStance[k] === f.targetStance);
  if (stance && stance !== 'stand') parts.push(`target ${stance === 'crouch' ? 'crouched' : stance}`);
  if (f.movement < 1) parts.push('firing on the move');
  if (f.suppression < 1) {
    parts.push(`shooter ${Object.keys(combat.suppressionAccuracy).find((k) => combat.suppressionAccuracy[k] === f.suppression)}`);
  }
  if (f.wounded < 1) parts.push('shooter wounded');
  if (f.fireMode !== undefined && f.fireMode !== 1) {
    const m = Object.keys(state.balance.orders.fireMode).find((k) => state.balance.orders.fireMode[k] === f.fireMode);
    parts.push({ overwatch: 'on overwatch', suppress: 'area fire', suppressUnseen: 'area fire at an unseen target' }[m] ?? m);
  }
  return parts.join(', ');
}

// ---- per order ----

function moveLine(state, side, team, plan, order) {
  const tileMeters = state.balance.map.tileMeters;
  const moving = plan.soldiers.filter((p) => p.path);
  const notes = [];
  for (const p of plan.soldiers) {
    if (!p.path) notes.push(`${state.soldiers[p.id].role} will not move: ${p.reason}.`);
  }
  const dest = order.type === 'assault' ? order.at : order.dest;
  if (moving.length === 0) return { text: `${team}: cannot move to ${dest.x},${dest.y}.`, notes, moving };
  const speed = order.type === 'assault' ? state.balance.orders.assault.speed : order.speed;
  const meters = Math.round(Math.max(...moving.map((p) => p.path.length)) * tileMeters);
  const sec = Math.max(...moving.map((p) => p.etaSec));
  const lead = moving[0];
  const exposure = routeExposure(state, side, lead.path, state.balance.movement.stanceForSpeed[speed]);
  if (exposure.tiles > 0) {
    notes.push(`Route crosses about ${exposure.meters} m of open ground in view of known enemy positions.`);
  }
  const verb = order.type === 'assault' ? `assault ${describePoint(state, side, order.at, order.target)}: run` : `${speed} to ${dest.x},${dest.y}${viaText(order.via)}.`;
  const text = order.type === 'assault'
    ? `${team}: ${verb} ${meters} m, about ${roundSec(sec)} s, ${arrival(sec, state.balance.turn.durationSec)}.`
    : `${team}: ${verb} About ${meters} m, ${roundSec(sec)} s, ${arrival(sec, state.balance.turn.durationSec)}.`;
  return { text, notes, moving, exposure };
}

function ammoNote(state, members, mode) {
  const byRole = new Map();
  for (const s of members) {
    if (s.ammo <= 0) continue;
    const sec = ammoForecast(state, s, mode).lastBurstSec;
    byRole.set(s.role, Math.min(byRole.get(s.role) ?? Infinity, sec));
  }
  if (!byRole.size) return 'Out of ammo.';
  return `Ammo lasts: ${[...byRole].map(([r, sec]) => `${r} about ${roundSec(sec)} s`).join(', ')} of fire.`;
}

function fireLines(fx, team, task, members) {
  const { state, actions, noFire, side } = fx;
  const notes = [];
  const label = (s) => s.role;

  if (task.type === 'suppress') {
    const firing = members.filter((s) => actions.get(s.id)?.mode === 'suppress');
    for (const s of members) {
      if (!firing.includes(s)) notes.push(`${label(s)} cannot fire: ${noFire.get(s.id) ?? (s.ammo <= 0 ? 'out of ammo' : 'not able to fire')}.`);
    }
    const where = describePoint(state, side, task.at, task.target);
    if (!firing.length) return { text: `${team}: suppress ${where}. Nobody has a line of fire: no fire.`, notes };
    const perSec = firing.reduce((a, s) => a + suppressionPerSec(state, s, 'suppress'), 0);
    const hitters = firing.map((s) => actions.get(s.id)).filter((a) => a.target);
    const hits = hitters.length
      ? `Can hit the exposed soldier there at ${span(hitters.map((a) => a.chance), pct)} per round.`
      : 'No exposed enemy at the point: suppression only, no hits.';
    notes.push(ammoNote(state, firing, 'suppress'));
    return {
      text: `${team}: suppress ${where}. ${firing.length} of ${members.length} have a line of fire, about ${Math.round(perSec)} suppression per second on the point. ${hits}`,
      notes,
    };
  }

  if (task.type === 'fire') {
    const where = describePoint(state, side, null, task.target);
    const onTarget = members.map((s) => actions.get(s.id)).filter((a) => a?.target?.id === task.target);
    for (const s of members) {
      const a = actions.get(s.id);
      if (a?.target?.id === task.target) continue;
      notes.push(a?.target
        ? `${label(s)} has no shot at the target: fires at will on ${describePoint(state, side, a.target.pos, a.target.id)}.`
        : `${label(s)} has no shot at the target${s.ammo <= 0 ? ' (out of ammo)' : ''}.`);
    }
    if (!onTarget.length) return { text: `${team}: fire on ${where}. Nobody has a shot at it.`, notes };
    notes.push(ammoNote(state, members, 'aimed'));
    return {
      text: `${team}: fire on ${where}. ${onTarget.length} of ${members.length} have a shot, hit chance ${span(onTarget.map((a) => a.chance), pct)} per round (${explainShot(state, onTarget[0])}).`,
      notes,
    };
  }

  if (task.type === 'overwatch') {
    const inside = knownEnemies(state, side).filter((e) => members.some((s) => inArc(state, s, task.toward, e.pos)));
    const engaging = members.map((s) => actions.get(s.id)).filter((a) => a?.target);
    const now = engaging.length
      ? ` Engages at once: ${engaging.length} of ${members.length} have a shot (${span(engaging.map((a) => a.chance), pct)} per round).`
      : '';
    return {
      text: `${team}: overwatch toward ${task.toward.x},${task.toward.y} (${state.balance.orders.overwatch.arcDeg} degree arc). Holds position, fires only inside the arc. Known contacts in the arc: ${inside.length}.${now}`,
      notes,
    };
  }
  return null;
}

// Full preview for `side` with these pending orders.
// Returns { lines: [{ team, text, notes }], plans, actions, noFire, state }.
export function previewTurn(state, side, orders) {
  const fx = { ...firstActions(state, side, orders), side };
  const { durationSec } = state.balance.turn;
  const lines = [];

  for (const team of teamsOf(state, side)) {
    const plan = fx.plans.find((p) => p.order?.side === side && p.order?.team === team && p.ok !== false)
      ?? fx.plans.find((p) => p.order?.side === side && p.order?.team === team);
    const members = fx.state.soldiers.filter((s) => s.side === side && s.team === team && s.status !== 'down' && s.status !== 'dead');
    const add = (text, notes = []) => lines.push({ team, text, notes });

    if (!members.length) {
      add(`${team}: no one left able to fight.`);
      continue;
    }
    if (plan && !plan.ok) {
      add(`${team}: order not valid, ${plan.reason}.`);
      continue;
    }
    const order = plan?.order;

    if (order?.type === 'move' || order?.type === 'assault') {
      const m = moveLine(state, side, team, plan, order);
      if (order.type === 'assault') {
        const f = assaultForecast(state, side, plan, order.target);
        if (!f) m.notes.push('Close assault odds unknown: no known enemy named as the target.');
        else if (!f.statusKnown) m.notes.push(`Target only suspected, status unknown. If it is alert: close assault kill chance about ${pct(f.chance)} per attempt.`);
        else if (f.factors.targetStatus >= 1) m.notes.push(`Target pinned: close assault kill chance about ${pct(f.chance)} per attempt.`);
        else if (f.factors.exposure >= 1) m.notes.push(`Target exposed from that side: close assault kill chance about ${pct(f.chance)} per attempt.`);
        else m.notes.push(`Target not suppressed and in cover from that side: close assault kill chance about ${pct(f.chance)} per attempt. Expect losses.`);
      }
      add(m.text, m.notes);
      continue;
    }
    if (order?.type === 'grenade') {
      const g = plan.grenade;
      const who = state.soldiers[g.thrower];
      const weapon = state.weapons.grenades[g.kind].name;
      const verb = g.kind === '40mm' ? 'fires' : 'throws';
      const scatter = g.scatterTiles ? `may land up to ${g.scatterTiles} tile${g.scatterTiles > 1 ? 's' : ''} off` : 'lands on the spot';
      const notes = [];
      const danger = friendliesInDanger(state, side, order.at, g.scatterTiles);
      if (danger.length) notes.push(`DANGER CLOSE: ${danger.map((s) => `${s.team} ${s.role}`).join(', ')} within reach of the blast.`);
      add(`${team}: ${who.role} ${verb} a ${weapon} at ${describePoint(state, side, order.at)}: ${Math.round(g.rangeM)} m, explodes about ${roundSec(grenadeLandingSec(state, g.flightSec))} s into the turn, ${scatter}.`, notes);
      continue;
    }
    if (order?.type === 'stance') {
      add(`${team}: go ${order.stance === 'crouch' ? 'to a crouch' : order.stance} and hold position. Fires at will.`);
      continue;
    }
    if (order?.type === 'hold') {
      add(`${team}: hold. Stops where they are and fires at will.`);
      continue;
    }

    // Fire, suppress, overwatch (new or continuing), or nothing new.
    const task = members.find((s) => s.task && s.task.type !== 'grenade' && s.task.type !== 'assault')?.task;
    if (task) {
      const f = fireLines(fx, team, task, members.filter((s) => s.task?.type === task.type));
      if (!order) f.text = f.text.replace(`${team}: `, `${team}: continuing `);
      add(f.text, f.notes);
      continue;
    }
    const moving = state.soldiers.filter((s) => s.side === side && s.team === team && s.move);
    if (moving.length) {
      const sec = Math.max(...moving.map((s) => remainingMoveSec(state, s)));
      const lead = moving.find((s) => s.role === 'TL') ?? moving[0];
      const what = lead.task?.type === 'assault' ? 'assault' : lead.move.speed;
      add(`${team}: continuing ${what} to ${lead.move.dest.x},${lead.move.dest.y}. About ${roundSec(sec)} s left, ${arrival(sec, durationSec)}.`);
      continue;
    }
    add(`${team}: holding. Fires at will.`);
  }
  return { lines, plans: fx.plans, actions: fx.actions, noFire: fx.noFire, state: fx.state };
}

export function previewLines(state, side, orders) {
  return previewTurn(state, side, orders).lines;
}
