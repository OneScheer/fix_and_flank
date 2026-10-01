// Browser UI: input, order planning, preview, and turn playback.
// The sim is only touched through planOrders (preview) and resolveTurn (ENGAGE).

import { lineOfSight } from '../sim/los.js';
import { inBounds, isPassable, tileAt } from '../sim/map.js';
import { planOrders, SPEEDS } from '../sim/orders.js';
import { teamsOf } from '../sim/state.js';
import { resolveTurn } from '../sim/step.js';
import { createCamera, fitCamera, panBy, toTile, zoomAt } from '../render/camera.js';
import {
  buildTerrainLayer, drawHits, drawHover, drawPaths, drawSightLines, drawTracers, drawSoldiers, drawSuspected, drawTerrain, drawWaypoints,
  fitCanvas, teamColor,
} from '../render/canvas.js';
import { buildFrames, contactsAt, eventsUpTo, positionAt, soldiersAt } from './playback.js';
import { previewLines } from './preview.js';

const PLAYER_SIDE = 'BLUFOR';
const PLAYBACK_SPEEDS = [1, 2, 4];
const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM = 1.15;
const TRACER_TICKS = 1;   // how long a tracer stays on screen, in ticks
const HIT_FLASH_TICKS = 1;

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
    losTool: false, // draw sight lines from the selected team to the hovered tile
    reveal: false,  // debug: show OPFOR the player has not spotted, faintly
    showGrid: false, // debug: tile grid lines
    enemyCasualties: new Map(), // enemy id -> pos, for enemies BLUFOR saw go down or die
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

  // Plain click: new move order. Shift+click: extend the current move order,
  // the old destination becomes a waypoint.
  function orderMove(tile, addWaypoint) {
    const { map } = app.state;
    if (!inBounds(map, tile.x, tile.y)) return;
    if (!isPassable(tileAt(map, tile.x, tile.y))) {
      setMessage(`${tile.x},${tile.y} is impassable.`);
      return;
    }
    const current = app.pending.get(app.selectedTeam);
    let via = [];
    if (addWaypoint && current?.type === 'move') {
      via = [...(current.via ?? []), current.dest];
      const max = app.state.balance.movement.maxWaypoints;
      if (via.length > max) {
        setMessage(`At most ${max} waypoints per order.`);
        return;
      }
    }
    app.pending.set(app.selectedTeam, {
      type: 'move', side: PLAYER_SIDE, team: app.selectedTeam, dest: { x: tile.x, y: tile.y }, speed: app.speed, via,
    });
    app.message = '';
    replan();
  }

  // Remove the last point of the move order; clears the order when none are left.
  function undoPoint() {
    const order = app.pending.get(app.selectedTeam);
    if (order?.type === 'move' && order.via?.length) {
      const via = order.via.slice(0, -1);
      app.pending.set(app.selectedTeam, { ...order, dest: order.via[order.via.length - 1], via });
      replan();
    } else {
      clearOrder();
    }
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
    for (const id of enemyCasualtiesSeen(entry)) app.enemyCasualties.set(id, after.soldiers[id].pos);
    app.pending.clear();
    app.plans = [];
    app.message = '';
    startPlayback(entry);
  }

  function startPlayback(entry) {
    app.playback = {
      entry,
      // Enemy casualties already known before this turn (replays recompute from history).
      casualtiesBefore: new Map(app.history.slice(0, app.history.indexOf(entry))
        .flatMap((h) => enemyCasualtiesSeen(h).map((id) => [id, h.after.soldiers[id].pos]))),
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

  function toggleLosTool() {
    app.losTool = !app.losTool;
    renderPanel();
    renderHover();
  }

  function replayLast() {
    if (app.playback || app.history.length === 0) return;
    startPlayback(app.history[app.history.length - 1]);
  }

  // ---- panel ----

  function soldierName(s) {
    return `${s.team} ${s.role}`;
  }

  // Enemies BLUFOR hit this turn that went down or died: the shooter saw it.
  function enemyCasualtiesSeen(entry) {
    const hitByUs = new Set(entry.events.filter((e) => e.type === 'hit'
      && entry.before.soldiers[e.by].side === PLAYER_SIDE).map((e) => e.id));
    return entry.events
      .filter((e) => e.type === 'status' && (e.to === 'down' || e.to === 'dead') && hitByUs.has(e.id))
      .map((e) => e.id);
  }

  // Why a shot was hard, in plain words: the factors that cut the chance most.
  function explainChance(e) {
    const { combat } = app.state.balance;
    const f = e.factors;
    const parts = [`range ${Math.round(e.rangeM)} m`];
    if (f.cover < 1 && e.cover.tile) {
      const where = e.cover.tile.x === e.at.x && e.cover.tile.y === e.at.y
        ? `target in ${e.cover.tile.what}`
        : `target behind ${e.cover.tile.what} from the ${e.cover.direction}`;
      parts.push(where);
    }
    const stance = Object.keys(combat.targetStance).find((k) => combat.targetStance[k] === f.targetStance);
    if (stance && stance !== 'stand') parts.push(`target ${stance === 'crouch' ? 'crouched' : stance}`);
    if (f.movement < 1) parts.push('firing on the move');
    if (f.suppression < 1) {
      const level = Object.keys(combat.suppressionAccuracy).find((k) => combat.suppressionAccuracy[k] === f.suppression);
      parts.push(`shooter ${level}`);
    }
    if (f.wounded < 1) parts.push('shooter wounded');
    return `${Math.round(e.chance * 100)}% per round: ${parts.join(', ')}`;
  }

  // Only what the player's side knows goes into the log.
  function formatEvent(e, ctx) {
    const { byId, tickSec, hitByUs, after } = ctx;
    const t = `${(e.tick * tickSec).toFixed(1)} s`;
    const s = byId.get(e.id);
    if (['spotted', 'lost', 'contact_expired', 'suspected'].includes(e.type)) {
      if (e.side !== PLAYER_SIDE) return null;
      if (e.type === 'spotted') return `${t}  CONTACT: enemy at ${e.pos.x},${e.pos.y}, spotted by ${soldierName(byId.get(e.by))}.`;
      if (e.type === 'lost') return `${t}  Lost sight of enemy. Last seen at ${e.pos.x},${e.pos.y}.`;
      if (e.type === 'suspected') return `${t}  Muzzle flash: enemy suspected at ${e.pos.x},${e.pos.y}.`;
      return `${t}  Contact at ${e.pos.x},${e.pos.y} is stale, dropped.`;
    }
    if (e.type === 'fire') {
      const target = byId.get(e.target);
      const hits = `${e.hits} hit${e.hits === 1 ? '' : 's'}`;
      if (s.side === PLAYER_SIDE) {
        return `${t}  ${soldierName(s)} fires ${e.rounds} at enemy at ${e.at.x},${e.at.y}: ${hits}. ${explainChance(e)}.`;
      }
      if (target.side === PLAYER_SIDE) {
        return `${t}  Taking fire from ${e.from.x},${e.from.y} at ${soldierName(target)}: ${hits}.`;
      }
      return null;
    }
    if (e.type === 'status' && s.side !== PLAYER_SIDE) {
      if (!hitByUs.has(e.id) || (e.to !== 'down' && e.to !== 'dead')) return null;
      const pos = after.soldiers[e.id].pos;
      return `${t}  Enemy at ${pos.x},${pos.y} ${e.to === 'dead' ? 'killed' : 'down'}.`;
    }
    if ((e.side ?? s?.side) !== PLAYER_SIDE) return null;
    switch (e.type) {
      case 'order':
        return `${t}  ${e.team}: ${e.order.type}${e.order.type === 'move' ? ` (${e.order.speed}) to ${e.order.dest.x},${e.order.dest.y}${e.order.via?.length ? ` via ${e.order.via.map((p) => `${p.x},${p.y}`).join(', ')}` : ''}` : ''}.`;
      case 'order_rejected':
        return `${t}  ${e.team}: order rejected, ${e.reason}.`;
      case 'order_failed':
        return `${t}  ${soldierName(s)} did not move: ${e.reason}.`;
      case 'blocked':
        return `${t}  ${soldierName(s)} blocked at ${e.at.x},${e.at.y}, waiting.`;
      case 'arrived':
        return `${t}  ${soldierName(s)} in position at ${e.pos.x},${e.pos.y}.`;
      case 'status': {
        const words = {
          active: 'recovered', wounded: 'wounded', shaken: 'shaken (accuracy down)',
          pinned: 'PINNED (will not move, poor return fire)', down: 'DOWN (casualty)', dead: 'KILLED',
        };
        return `${t}  ${soldierName(s)} ${words[e.to]}.`;
      }
      case 'out_of_ammo':
        return `${t}  ${soldierName(s)} is out of ammo.`;
      default:
        return null;
    }
  }

  function renderPanel() {
    const { state } = app;
    const busy = Boolean(app.playback);
    const contacts = Object.values(state.contacts[PLAYER_SIDE] ?? {});
    const spotted = contacts.filter((c) => c.level === 'spotted').length;
    const suspected = contacts.length - spotted;
    const contactText = contacts.length ? `Contacts: ${spotted} spotted, ${suspected} suspected.` : 'No contact.';
    $('turn').textContent = busy
      ? `Turn ${app.playback.entry.before.turn + 1}: playing`
      : `Turn ${state.turn + 1}: planning. ${contactText}${app.reveal ? ' DEBUG: showing all OPFOR.' : ''}`;
    $('lostool').classList.toggle('selected', app.losTool);

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
    const ctx = {
      byId: new Map(entry.before.soldiers.map((s) => [s.id, s])),
      tickSec: entry.before.tickSec,
      hitByUs: new Set(entry.events.filter((e) => e.type === 'hit' && entry.before.soldiers[e.by].side === PLAYER_SIDE).map((e) => e.id)),
      after: entry.after,
    };
    const text = shown.map((e) => formatEvent(e, ctx)).filter(Boolean);
    log.textContent = text.length ? text.join('\n') : 'Nothing to report.';
    log.scrollTop = log.scrollHeight;
  }

  function renderHover() {
    const t = app.hover;
    const { map } = app.state;
    if (!t || !inBounds(map, t.x, t.y)) {
      $('status').textContent = 'Click: move selected team. Shift+click: add waypoint. Drag: pan. Wheel: zoom.';
      return;
    }
    const tile = tileAt(map, t.x, t.y);
    const parts = [`${t.x},${t.y}`, tile.terrain];
    if (tile.feature !== 'none') parts.push(tile.feature);
    else if (tile.height === 2) parts.push('wall');
    else if (tile.height === 1) parts.push('low wall');
    parts.push(`cover ${tile.cover}`, `concealment ${tile.concealment}`);
    let text = parts.join(', ');
    if (!app.playback) {
      const known = app.state.contacts[PLAYER_SIDE] ?? {};
      const s = app.state.soldiers.find((x) => x.pos.x === t.x && x.pos.y === t.y && x.status !== 'dead');
      if (s && (s.side === PLAYER_SIDE || known[s.id]?.level === 'spotted' || app.reveal)) {
        text += ` | ${s.side} ${soldierName(s)}, ${s.stance}, ${s.status}`;
        if (s.side === PLAYER_SIDE) {
          const w = app.state.weapons.weapons[s.weapon];
          text += `, hp ${s.hp}, suppression ${Math.round(s.suppression)}, ${w.name} ammo ${s.ammo}/${w.ammo}`;
        }
      }
      const suspected = Object.values(known).find((c) => c.level === 'suspected' && c.pos.x === t.x && c.pos.y === t.y);
      if (suspected) text += ' | suspected enemy (last known position)';
      if (app.losTool) text += ` | ${sightSummary(t)}`;
    }
    $('status').textContent = text;
  }

  // ---- line of sight tool ----

  // Target stance for the LOS check: the soldier on that tile if the player
  // can see one, else crouched (the default stance).
  function sightTarget(t) {
    const known = app.state.contacts[PLAYER_SIDE] ?? {};
    const s = app.state.soldiers.find((x) => x.pos.x === t.x && x.pos.y === t.y && x.status !== 'dead'
      && (x.side === PLAYER_SIDE || known[x.id]?.level === 'spotted' || app.reveal));
    return { pos: t, stance: s?.stance ?? app.state.balance.soldier.startStance };
  }

  function sightChecks(t) {
    const { map, balance, soldiers } = app.state;
    const target = sightTarget(t);
    return soldiers
      .filter((s) => s.side === PLAYER_SIDE && s.team === app.selectedTeam && s.status !== 'dead')
      .filter((s) => s.pos.x !== t.x || s.pos.y !== t.y)
      .map((s) => ({ soldier: s, target, los: lineOfSight(map, balance, s, target) }));
  }

  function sightSummary(t) {
    if (!inBounds(app.state.map, t.x, t.y)) return '';
    const checks = sightChecks(t);
    const stance = checks[0]?.target.stance;
    return `LOS to a ${stance} target: ` + checks.map(({ soldier, los }) => {
      if (!los.clear) return `${soldier.role} no (${los.reason})`;
      const extra = [los.partial ? 'partly hidden' : null, los.concealment > 0 ? `concealment ${los.concealment.toFixed(2)}` : null]
        .filter(Boolean).join(', ');
      return `${soldier.role} yes${extra ? ` (${extra})` : ''}`;
    }).join('; ');
  }

  // ---- drawing ----

  // Enemy counters and markers the player is allowed to see.
  // statusOf(s) -> { status, stance } at the moment being drawn.
  function enemyView(known, positionOf, statusOf, casualties) {
    const counters = [];
    const suspected = [];
    for (const s of app.state.soldiers) {
      if (s.side === PLAYER_SIDE) continue;
      const c = known.get(s.id);
      if (c?.level === 'spotted') counters.push({ soldier: s, pos: positionOf(s), ...statusOf(s) });
      else if (casualties.has(s.id)) counters.push({ soldier: s, pos: casualties.get(s.id), ...statusOf(s) });
      else {
        if (c?.level === 'suspected') suspected.push(c.pos);
        if (app.reveal) counters.push({ soldier: s, pos: positionOf(s), ghost: true, ...statusOf(s) });
      }
    }
    return { counters, suspected };
  }

  // Tracers and hit flashes the player can see at fractional tick t.
  function combatEffects(entry, t) {
    const sideOf = (id) => entry.before.soldiers[id].side;
    const ours = (e) => sideOf(e.id) === PLAYER_SIDE || sideOf(e.target ?? e.id) === PLAYER_SIDE
      || (e.by !== undefined && sideOf(e.by) === PLAYER_SIDE);
    const tracers = [];
    const hits = [];
    for (const e of entry.events) {
      const age = t - e.tick;
      if (e.type === 'fire' && age >= 0 && age < TRACER_TICKS && ours(e)) {
        tracers.push({ from: e.from, to: e.at, side: sideOf(e.id), alpha: 1 - age / TRACER_TICKS });
      } else if (e.type === 'hit' && age >= 0 && age < HIT_FLASH_TICKS && ours(e)) {
        hits.push({ pos: positionAt(app.playback.frames, e.id, e.tick + 1), alpha: 1 - age / HIT_FLASH_TICKS });
      }
    }
    return { tracers, hits };
  }

  function frame(now) {
    const { ctx, width: w, height: h } = fitCanvas(canvas);
    const { state, cam } = app;
    drawTerrain(ctx, cam, app.layer, state.map, w, h, app.showGrid);

    let soldiers;
    if (app.playback) {
      const pb = app.playback;
      pb.elapsedTicks += ((now - pb.last) / 1000 / state.tickSec) * app.playbackSpeed;
      pb.last = now;
      const ticks = pb.entry.before.ticksPerTurn;
      const t = Math.min(pb.elapsedTicks, ticks);
      const known = contactsAt(pb.entry.before.contacts[PLAYER_SIDE], pb.entry.events, PLAYER_SIDE, t);
      const status = soldiersAt(pb.entry.before.soldiers, pb.entry.events, t);
      const casualties = new Map(pb.casualtiesBefore);
      const view = enemyView(known, (s) => positionAt(pb.frames, s.id, t), (s) => status.get(s.id), casualties);
      drawSuspected(ctx, cam, view.suspected);
      soldiers = [
        ...pb.entry.before.soldiers.filter((s) => s.side === PLAYER_SIDE)
          .map((s) => ({ soldier: s, pos: positionAt(pb.frames, s.id, t), ...status.get(s.id) })),
        ...view.counters,
      ];
      const fx = combatEffects(pb.entry, t);
      drawTracers(ctx, cam, fx.tracers);
      drawSoldiers(ctx, cam, soldiers);
      drawHits(ctx, cam, fx.hits);
      soldiers = [];
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
      const waypoints = [];
      for (const plan of app.plans) {
        if (plan.ok && plan.order.type === 'move') {
          for (const p of plan.order.via ?? []) waypoints.push({ ...p, color: teamColor(plan.order.team) });
        }
      }
      drawWaypoints(ctx, cam, waypoints);
      const known = new Map(Object.entries(state.contacts[PLAYER_SIDE] ?? {}).map(([id, c]) => [Number(id), c]));
      const view = enemyView(known, (s) => s.pos, () => ({}), app.enemyCasualties);
      drawSuspected(ctx, cam, view.suspected);
      if (app.losTool && app.hover && inBounds(state.map, app.hover.x, app.hover.y)) {
        drawSightLines(ctx, cam, sightChecks(app.hover).map(({ soldier, los }) => ({
          from: soldier.pos, to: app.hover, clear: los.clear, blockedAt: los.blockedAt,
        })));
      }
      soldiers = [
        ...state.soldiers.filter((s) => s.side === PLAYER_SIDE).map((s) => ({
          soldier: s, pos: s.pos, selected: s.team === app.selectedTeam, suppression: s.suppression,
        })),
        ...view.counters,
      ];
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
    if (own && !e.shiftKey) selectTeam(own.team);
    else orderMove(tile, e.shiftKey);
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
    else if (k === 'backspace') undoPoint();
    else if (k === 'delete') clearOrder();
    else if (k === 'p') replayLast();
    else if (k === 'l') toggleLosTool();
    else if (k === 'g') app.showGrid = !app.showGrid;
    else if (k === 'v') {
      app.reveal = !app.reveal;
      renderPanel();
    }
  });

  for (const speed of SPEEDS) $(`speed-${speed}`).onclick = () => setSpeed(speed);
  $('hold').onclick = orderHold;
  $('clear').onclick = clearOrder;
  $('engage').onclick = engage;
  $('replay').onclick = replayLast;
  $('lostool').onclick = toggleLosTool;
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
