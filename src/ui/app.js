// Browser UI: input, order planning, preview, and turn playback.
// The sim is only touched through planOrders (preview) and resolveTurn (ENGAGE).

import { inBounds, isPassable, tileAt } from '../sim/map.js';
import { planOrders, SPEEDS } from '../sim/orders.js';
import { teamsOf } from '../sim/state.js';
import { resolveTurn } from '../sim/step.js';
import { createCamera, fitCamera, panBy, toTile, zoomAt } from '../render/camera.js';
import {
  buildTerrainLayer, drawHover, drawPaths, drawSoldiers, drawTerrain, fitCanvas, teamColor,
} from '../render/canvas.js';
import { buildFrames, eventsUpTo, positionAt } from './playback.js';
import { previewLines } from './preview.js';

const PLAYER_SIDE = 'BLUFOR';
const PLAYBACK_SPEEDS = [1, 2, 4];
const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM = 1.15;

const $ = (id) => document.getElementById(id);

export function startApp(initialState) {
  const app = {
    state: initialState,
    layer: buildTerrainLayer(initialState.map),
    cam: createCamera(),
    selectedTeam: teamsOf(initialState, PLAYER_SIDE)[0],
    speed: 'walk',
    pending: new Map(),
    plans: [],
    history: [],
    playback: null,
    playbackSpeed: 1,
    hover: null,
    message: '',
  };

  const canvas = $('board');
  const { width, height } = fitCanvas(canvas);
  fitCamera(app.cam, app.state.map, width, height);

  function replan() {
    app.plans = planOrders(app.state, [...app.pending.values()]);
    renderPanel();
  }

  function setMessage(text) {
    app.message = text;
    renderPanel();
  }

  // ---- orders ----

  function orderMove(tile) {
    const { map } = app.state;
    if (!inBounds(map, tile.x, tile.y)) return;
    if (!isPassable(tileAt(map, tile.x, tile.y))) {
      setMessage(`${tile.x},${tile.y} is impassable.`);
      return;
    }
    app.pending.set(app.selectedTeam, {
      type: 'move', side: PLAYER_SIDE, team: app.selectedTeam, dest: { x: tile.x, y: tile.y }, speed: app.speed,
    });
    app.message = '';
    replan();
  }

  function orderHold() {
    app.pending.set(app.selectedTeam, { type: 'hold', side: PLAYER_SIDE, team: app.selectedTeam });
    replan();
  }

  function clearOrder() {
    app.pending.delete(app.selectedTeam);
    replan();
  }

  function setSpeed(speed) {
    app.speed = speed;
    const order = app.pending.get(app.selectedTeam);
    if (order?.type === 'move') {
      app.pending.set(app.selectedTeam, { ...order, speed });
      replan();
    } else {
      renderPanel();
    }
  }

  function selectTeam(team) {
    app.selectedTeam = team;
    const order = app.pending.get(team);
    if (order?.type === 'move') app.speed = order.speed;
    renderPanel();
  }

  // ---- turn ----

  function engage() {
    if (app.playback) return;
    const orders = [...app.pending.values()];
    const before = app.state;
    const { state: after, events } = resolveTurn(before, orders);
    const entry = { before, orders, events, after };
    app.history.push(entry);
    app.state = after;
    app.pending.clear();
    app.plans = [];
    app.message = '';
    startPlayback(entry);
  }

  function startPlayback(entry) {
    app.playback = {
      entry,
      frames: buildFrames(entry.before.soldiers, entry.events, entry.before.ticksPerTurn),
      elapsedTicks: 0,
      last: performance.now(),
    };
    renderPanel();
  }

  function endPlayback() {
    app.playback = null;
    replan();
  }

  function replayLast() {
    if (app.playback || app.history.length === 0) return;
    startPlayback(app.history[app.history.length - 1]);
  }

  // ---- panel ----

  function soldierName(s) {
    return `${s.team} ${s.role}`;
  }

  function formatEvent(e, byId, tickSec) {
    const t = `${(e.tick * tickSec).toFixed(1)} s`;
    const s = byId.get(e.id);
    switch (e.type) {
      case 'order':
        return `${t}  ${e.team}: ${e.order.type}${e.order.type === 'move' ? ` (${e.order.speed}) to ${e.order.dest.x},${e.order.dest.y}` : ''}.`;
      case 'order_rejected':
        return `${t}  ${e.team}: order rejected, ${e.reason}.`;
      case 'order_failed':
        return `${t}  ${soldierName(s)} did not move: ${e.reason}.`;
      case 'blocked':
        return `${t}  ${soldierName(s)} blocked at ${e.at.x},${e.at.y}, waiting.`;
      case 'arrived':
        return `${t}  ${soldierName(s)} in position at ${e.pos.x},${e.pos.y}.`;
      default:
        return null;
    }
  }

  function renderPanel() {
    const { state } = app;
    const busy = Boolean(app.playback);
    $('turn').textContent = busy
      ? `Turn ${app.playback.entry.before.turn + 1}: playing`
      : `Turn ${state.turn + 1}: planning`;

    const lines = previewLines(state, PLAYER_SIDE, app.plans);
    const teams = $('teams');
    teams.replaceChildren(...lines.map((line) => {
      const row = document.createElement('button');
      row.className = 'team' + (line.team === app.selectedTeam ? ' selected' : '');
      row.style.borderLeftColor = teamColor(line.team);
      row.disabled = busy;
      row.onclick = () => selectTeam(line.team);
      const text = document.createElement('div');
      text.textContent = line.text;
      row.append(text);
      for (const note of line.notes) {
        const n = document.createElement('div');
        n.className = 'note';
        n.textContent = note;
        row.append(n);
      }
      return row;
    }));

    for (const speed of SPEEDS) {
      const b = $(`speed-${speed}`);
      b.classList.toggle('selected', app.speed === speed);
      b.disabled = busy;
    }
    $('hold').disabled = busy;
    $('clear').disabled = busy || !app.pending.has(app.selectedTeam);
    $('engage').disabled = busy;
    $('replay').disabled = busy || app.history.length === 0;
    $('pbspeed').textContent = `Playback ${app.playbackSpeed}x`;
    $('message').textContent = app.message;

    renderLog();
  }

  let loggedCount = -1;
  function renderLog() {
    const entry = app.playback?.entry ?? app.history[app.history.length - 1];
    const log = $('log');
    if (!entry) {
      log.textContent = 'No turns played yet.';
      loggedCount = -1;
      return;
    }
    const shown = app.playback ? eventsUpTo(entry.events, app.playback.elapsedTicks) : entry.events;
    if (shown.length === loggedCount) return;
    loggedCount = shown.length;
    const byId = new Map(entry.before.soldiers.map((s) => [s.id, s]));
    const text = shown.map((e) => formatEvent(e, byId, entry.before.tickSec)).filter(Boolean);
    log.textContent = text.length ? text.join('\n') : 'Nothing to report.';
    log.scrollTop = log.scrollHeight;
  }

  function renderHover() {
    const t = app.hover;
    const { map } = app.state;
    if (!t || !inBounds(map, t.x, t.y)) {
      $('status').textContent = 'Left click: move selected team. Drag or right drag: pan. Wheel: zoom.';
      return;
    }
    const tile = tileAt(map, t.x, t.y);
    const parts = [`${t.x},${t.y}`, tile.terrain];
    if (tile.feature !== 'none') parts.push(tile.feature);
    else if (tile.height === 2) parts.push('wall');
    else if (tile.height === 1) parts.push('low wall');
    parts.push(`cover ${tile.cover}`, `concealment ${tile.concealment}`);
    const s = app.state.soldiers.find((x) => x.pos.x === t.x && x.pos.y === t.y && x.status !== 'dead');
    if (s && !app.playback) parts.push(`| ${s.side} ${soldierName(s)}, ${s.stance}, ${s.status}`);
    $('status').textContent = parts.join(', ').replace(', |', ' |');
  }

  // ---- drawing ----

  function frame(now) {
    const { ctx, width: w, height: h } = fitCanvas(canvas);
    const { state, cam } = app;
    drawTerrain(ctx, cam, app.layer, state.map, w, h);

    let soldiers;
    if (app.playback) {
      const pb = app.playback;
      pb.elapsedTicks += ((now - pb.last) / 1000 / state.tickSec) * app.playbackSpeed;
      pb.last = now;
      const ticks = pb.entry.before.ticksPerTurn;
      const t = Math.min(pb.elapsedTicks, ticks);
      soldiers = pb.entry.before.soldiers.map((s) => ({ soldier: s, pos: positionAt(pb.frames, s.id, t) }));
      renderLog();
      if (pb.elapsedTicks >= ticks) endPlayback();
    } else {
      const paths = [];
      const planned = new Set();
      for (const plan of app.plans) {
        if (!plan.ok || plan.order.type !== 'move') continue;
        planned.add(plan.order.team);
        for (const p of plan.soldiers) {
          if (!p.path) continue;
          paths.push({ from: state.soldiers[p.id].pos, path: p.path, color: teamColor(plan.order.team), dashed: false });
        }
      }
      const held = new Set(app.plans.filter((p) => p.ok && p.order.type === 'hold').map((p) => p.order.team));
      for (const s of state.soldiers) {
        if (!s.move || s.side !== PLAYER_SIDE || planned.has(s.team) || held.has(s.team)) continue;
        paths.push({ from: s.pos, path: s.move.path.slice(s.move.i), color: teamColor(s.team), dashed: true });
      }
      drawPaths(ctx, cam, paths);
      soldiers = state.soldiers.map((s) => ({
        soldier: s, pos: s.pos, selected: s.side === PLAYER_SIDE && s.team === app.selectedTeam,
      }));
    }
    drawSoldiers(ctx, cam, soldiers);
    drawHover(ctx, cam, app.hover);
    requestAnimationFrame(frame);
  }

  // ---- input ----

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    app.hover = toTile(app.cam, e.clientX - r.left, e.clientY - r.top);
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.moved || Math.hypot(dx, dy) > CLICK_SLOP_PX) {
        drag.moved = true;
        panBy(app.cam, dx, dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
      }
    }
    renderHover();
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || d.button !== 0 || app.playback) return;
    const r = canvas.getBoundingClientRect();
    const tile = toTile(app.cam, e.clientX - r.left, e.clientY - r.top);
    const own = app.state.soldiers.find(
      (s) => s.side === PLAYER_SIDE && s.status !== 'dead' && s.pos.x === tile.x && s.pos.y === tile.y,
    );
    if (own) selectTeam(own.team);
    else orderMove(tile);
  });
  canvas.addEventListener('pointerleave', () => {
    app.hover = null;
    renderHover();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(app.cam, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM);
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const teams = teamsOf(app.state, PLAYER_SIDE);
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      e.preventDefault();
      if (app.playback) app.playback.elapsedTicks = Infinity;
      else engage();
      return;
    }
    if (k === 'f') {
      const { width: w, height: h } = fitCanvas(canvas);
      fitCamera(app.cam, app.state.map, w, h);
      return;
    }
    if (app.playback) return;
    if (/^[1-9]$/.test(k) && teams[Number(k) - 1]) selectTeam(teams[Number(k) - 1]);
    else if (k === 'w') setSpeed('walk');
    else if (k === 'r') setSpeed('run');
    else if (k === 'c') setSpeed('crawl');
    else if (k === 'h') orderHold();
    else if (k === 'backspace' || k === 'delete') clearOrder();
    else if (k === 'p') replayLast();
  });

  for (const speed of SPEEDS) $(`speed-${speed}`).onclick = () => setSpeed(speed);
  $('hold').onclick = orderHold;
  $('clear').onclick = clearOrder;
  $('engage').onclick = engage;
  $('replay').onclick = replayLast;
  $('pbspeed').onclick = () => {
    const i = PLAYBACK_SPEEDS.indexOf(app.playbackSpeed);
    app.playbackSpeed = PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length];
    renderPanel();
  };

  replan();
  renderHover();
  requestAnimationFrame(frame);
  return app;
}
