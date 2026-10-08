// Browser UI: input, order planning, preview, and turn playback.
// The sim is only touched through previewTurn (built on sim code) and
// resolveTurn (ENGAGE).

import { lineOfSight } from '../sim/los.js';
import { inBounds, isPassable, tileAt } from '../sim/map.js';
import { SPEEDS, STANCES } from '../sim/orders.js';
import { teamsOf } from '../sim/state.js';
import { resolveTurn } from '../sim/step.js';
import { createCamera, fitCamera, panBy, toTile, zoomAt } from '../render/camera.js';
import {
  buildTerrainLayer, drawArc, drawExplosions, drawFireLines, drawHits, drawHover, drawPaths, drawRings, drawSightLines,
  drawTracers, drawSoldiers, drawSuspected, drawTerrain, drawWaypoints, fitCanvas, teamColor,
} from '../render/canvas.js';
import { buildFrames, contactsAt, eventsUpTo, positionAt, soldiersAt } from './playback.js';
import { describePoint, explainShot, previewTurn } from './preview.js';

const PLAYER_SIDE = 'BLUFOR';
const PLAYBACK_SPEEDS = [1, 2, 4];
const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM = 1.15;
const TRACER_TICKS = 1;   // how long a tracer stays on screen, in ticks
const HIT_FLASH_TICKS = 1;
const BLAST_TICKS = 2;
const OVERWATCH_DRAW_TILES = 30; // how far the arc is drawn, not a rule
// Order modes: what a click on the map orders the selected team to do.
const MODES = ['move', 'fire', 'suppress', 'overwatch', 'assault', 'grenade'];
const MODE_KEYS = { m: 'move', f: 'fire', s: 'suppress', o: 'overwatch', a: 'assault', t: 'grenade' };
const MODE_HINT = {
  move: 'Click: move. Shift+click: add waypoint.',
  fire: 'Click a spotted enemy: aimed fire on it.',
  suppress: 'Click a contact or a tile: suppress it.',
  overwatch: 'Click: overwatch toward that point (90 degree arc).',
  assault: 'Click a contact or a tile: assault it.',
  grenade: 'Click a tile: grenade (GRN 40 mm, or nearest hand grenade).',
};

const $ = (id) => document.getElementById(id);

export function startApp(initialState) {
  const app = {
    state: initialState,
    layer: buildTerrainLayer(initialState.map),
    cam: createCamera(),
    selectedTeam: teamsOf(initialState, PLAYER_SIDE)[0],
    speed: 'walk',
    holdFire: false, // move orders: hold fire on the way (flanking element)
    mode: 'move',
    pending: new Map(),
    plans: [],
    preview: null,
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
    app.preview = previewTurn(app.state, PLAYER_SIDE, [...app.pending.values()]);
    app.plans = app.preview.plans;
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
      ...(app.holdFire ? { holdFire: true } : {}),
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

  // A known contact on or next to the tile (spotted first), from what BLUFOR knows.
  function contactNear(tile, spottedOnly) {
    const known = Object.entries(app.state.contacts[PLAYER_SIDE] ?? {})
      .map(([id, c]) => ({ id: Number(id), ...c }))
      .filter((c) => (!spottedOnly || c.level === 'spotted') && app.state.soldiers[c.id].status !== 'dead')
      .map((c) => ({ ...c, d: Math.hypot(c.pos.x - tile.x, c.pos.y - tile.y) }))
      .filter((c) => c.d <= 1.5)
      .sort((a, b) => (a.level === 'spotted' ? 0 : 1) - (b.level === 'spotted' ? 0 : 1) || a.d - b.d || a.id - b.id);
    return known[0] ?? null;
  }

  function setOrder(order) {
    app.pending.set(app.selectedTeam, { side: PLAYER_SIDE, team: app.selectedTeam, ...order });
    app.message = '';
    replan();
  }

  // A click on the map in the current order mode.
  function orderAt(tile, shift) {
    const { map } = app.state;
    if (!inBounds(map, tile.x, tile.y)) return;
    const c = contactNear(tile, false);
    switch (app.mode) {
      case 'move':
        orderMove(tile, shift);
        break;
      case 'fire': {
        const target = contactNear(tile, true);
        if (!target) setMessage('Fire needs a spotted enemy: click on an enemy counter.');
        else setOrder({ type: 'fire', target: target.id });
        break;
      }
      case 'suppress':
        setOrder(c ? { type: 'suppress', at: { ...c.pos }, target: c.id } : { type: 'suppress', at: { ...tile } });
        break;
      case 'overwatch':
        setOrder({ type: 'overwatch', toward: { ...tile } });
        break;
      case 'assault': {
        const at = c ? c.pos : tile;
        if (!isPassable(tileAt(map, at.x, at.y))) setMessage(`${at.x},${at.y} is impassable.`);
        else setOrder(c ? { type: 'assault', at: { ...at }, target: c.id } : { type: 'assault', at: { ...at } });
        break;
      }
      case 'grenade':
        setOrder({ type: 'grenade', at: { ...tile } });
        break;
      default:
        break;
    }
  }

  function setMode(mode) {
    app.mode = mode;
    app.message = '';
    renderPanel();
    renderHover();
  }

  function orderStance(stance) {
    setOrder({ type: 'stance', stance });
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

  function toggleHoldFire() {
    app.holdFire = !app.holdFire;
    const order = app.pending.get(app.selectedTeam);
    if (order?.type === 'move') {
      const { holdFire, ...rest } = order;
      void holdFire;
      app.pending.set(app.selectedTeam, app.holdFire ? { ...rest, holdFire: true } : rest);
      replan();
    } else {
      renderPanel();
    }
  }

  function selectTeam(team) {
    app.selectedTeam = team;
    const order = app.pending.get(team);
    if (order?.type === 'move') {
      app.speed = order.speed;
      app.holdFire = Boolean(order.holdFire);
    }
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

  function chanceText(e) {
    return `${Math.round(e.chance * 100)}% per round: ${explainShot(app.state, e)}`;
  }

  function orderText(o) {
    const where = (p, id) => describePoint(app.state, PLAYER_SIDE, p, id);
    switch (o.type) {
      case 'move':
        return `move (${o.speed}${o.holdFire ? ', hold fire' : ''}) to ${o.dest.x},${o.dest.y}${o.via?.length ? ` via ${o.via.map((p) => `${p.x},${p.y}`).join(', ')}` : ''}`;
      case 'fire': return `fire on ${where(null, o.target)}`;
      case 'suppress': return `suppress ${where(o.at, o.target)}`;
      case 'overwatch': return `overwatch toward ${o.toward.x},${o.toward.y}`;
      case 'assault': return `assault ${where(o.at, o.target)}`;
      case 'grenade': return `grenade on ${o.at.x},${o.at.y}`;
      case 'stance': return `go ${o.stance}`;
      default: return o.type;
    }
  }

  // Only what the player's side knows goes into the log.
  function formatEvent(e, ctx) {
    const { byId, tickSec, hitByUs, after } = ctx;
    // The sim's clock: an event in tick k happens by the end of it, (k + 1) x tickSec.
    // Orders are given before the turn runs: 0.0 s.
    const at = e.type === 'order' || e.type === 'order_rejected' ? 0 : (e.tick + 1) * tickSec;
    const t = `${at.toFixed(1)} s`;
    const s = byId.get(e.id);
    if (['spotted', 'lost', 'contact_expired', 'suspected'].includes(e.type)) {
      if (e.side !== PLAYER_SIDE) return null;
      if (e.type === 'spotted') return `${t}  CONTACT: enemy at ${e.pos.x},${e.pos.y}, spotted by ${soldierName(byId.get(e.by))}.`;
      if (e.type === 'lost') return `${t}  Lost sight of enemy. Last seen at ${e.pos.x},${e.pos.y}.`;
      if (e.type === 'suspected') return `${t}  Muzzle flash: enemy suspected at ${e.pos.x},${e.pos.y}.`;
      return `${t}  Contact at ${e.pos.x},${e.pos.y} is stale, dropped.`;
    }
    if (e.type === 'fire') {
      const target = e.target === null ? null : byId.get(e.target);
      const hits = `${e.hits} hit${e.hits === 1 ? '' : 's'}`;
      if (s.side === PLAYER_SIDE) {
        if (e.mode === 'suppress') {
          const onWho = target ? ` ${hits} (${chanceText(e)})` : ' no exposed target there, suppression only';
          return `${t}  ${soldierName(s)} suppresses ${e.at.x},${e.at.y} with ${e.rounds} rounds:${onWho}.`;
        }
        return `${t}  ${soldierName(s)} fires ${e.rounds} at enemy at ${e.at.x},${e.at.y}: ${hits}. ${chanceText(e)}.`;
      }
      if (target?.side === PLAYER_SIDE) return `${t}  Taking fire from ${e.from.x},${e.from.y} at ${soldierName(target)}: ${hits}.`;
      if (e.mode === 'suppress' && e.suppressed.some((x) => byId.get(x.id).side === PLAYER_SIDE)) {
        return `${t}  Under suppressive fire from ${e.from.x},${e.from.y}.`;
      }
      return null;
    }
    if (e.type === 'assault') {
      const target = byId.get(e.target);
      const why = `${Math.round(e.chance * 100)}%: target ${target.status === 'pinned' ? 'pinned' : 'not pinned'}, ${e.factors.exposure >= 1 ? 'exposed from that side' : 'in cover from that side'}`;
      if (s.side === PLAYER_SIDE) return `${t}  ${soldierName(s)} close assault on enemy at ${e.at.x},${e.at.y}: ${e.success ? 'KILLED' : 'failed'} (${why}).`;
      if (target.side === PLAYER_SIDE) return `${t}  ${soldierName(target)} assaulted from ${e.from.x},${e.from.y}: ${e.success ? 'killed' : 'held'}.`;
      return null;
    }
    if (e.type === 'throw') {
      if (s.side !== PLAYER_SIDE) return null;
      const name = app.state.weapons.grenades[e.kind].name;
      return `${t}  ${soldierName(s)} ${e.kind === '40mm' ? 'fires' : 'throws'} a ${name} at ${e.aim.x},${e.aim.y}.`;
    }
    if (e.type === 'explosion') {
      const ours = byId.get(e.by).side === PLAYER_SIDE;
      const caught = e.effects.filter((x) => x.hit && byId.get(x.id).side === PLAYER_SIDE).map((x) => soldierName(byId.get(x.id)));
      const enemyHits = e.effects.filter((x) => x.hit && byId.get(x.id).side !== PLAYER_SIDE).length;
      if (!ours && !caught.length && !e.effects.some((x) => byId.get(x.id).side === PLAYER_SIDE)) return null;
      const off = e.pos.x !== e.aim.x || e.pos.y !== e.aim.y ? ` (aimed at ${e.aim.x},${e.aim.y})` : '';
      const parts = [];
      if (ours) parts.push(enemyHits ? `${enemyHits} enemy hit` : 'no enemy hit');
      if (caught.length) parts.push(`OWN CASUALTIES: ${caught.join(', ')}`);
      return `${t}  ${ours ? 'Grenade' : 'Enemy grenade'} explodes at ${e.pos.x},${e.pos.y}${off}${parts.length ? `: ${parts.join('; ')}` : ''}.`;
    }
    if (e.type === 'status' && s.side !== PLAYER_SIDE) {
      if (!hitByUs.has(e.id) || (e.to !== 'down' && e.to !== 'dead')) return null;
      const pos = after.soldiers[e.id].pos;
      return `${t}  Enemy at ${pos.x},${pos.y} ${e.to === 'dead' ? 'killed' : 'down'}.`;
    }
    if ((e.side ?? s?.side) !== PLAYER_SIDE) return null;
    switch (e.type) {
      case 'order':
        return `${t}  ${e.team}: ${orderText(e.order)}.`;
      case 'order_rejected':
        return `${t}  ${e.team}: order rejected, ${e.reason}.`;
      case 'order_failed':
        return `${t}  ${soldierName(s)} could not carry out the order: ${e.reason}.`;
      case 'no_fire':
        return `${t}  ${soldierName(s)} cannot fire: ${e.reason}.`;
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

    if (!app.preview && !busy) app.preview = previewTurn(state, PLAYER_SIDE, [...app.pending.values()]);
    const lines = app.preview?.lines ?? [];
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
    for (const mode of MODES) {
      const b = $(`mode-${mode}`);
      b.classList.toggle('selected', app.mode === mode);
      b.disabled = busy;
    }
    for (const stance of STANCES) $(`stance-${stance}`).disabled = busy;
    $('holdfire').classList.toggle('selected', app.holdFire);
    $('holdfire').disabled = busy;
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
      $('status').textContent = `${MODE_HINT[app.mode]} Drag: pan. Wheel: zoom.`;
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
    const blasts = [];
    const lobbed = [];
    for (const e of entry.events) {
      const age = t - e.tick;
      if ((e.type === 'fire' || e.type === 'assault') && age >= 0 && age < TRACER_TICKS && ours(e)) {
        tracers.push({ from: e.from, to: e.at, side: sideOf(e.id), alpha: 1 - age / TRACER_TICKS });
      } else if (e.type === 'throw' && age >= 0 && ours(e)) {
        const flightTicks = (e.landsAtSec - (entry.before.turn * entry.before.balance.turn.durationSec + (e.tick + 1) * entry.before.tickSec)) / entry.before.tickSec;
        if (age < flightTicks + 1) lobbed.push({ from: e.from, to: e.aim, side: sideOf(e.id), alpha: 0.5 });
      } else if (e.type === 'explosion' && age >= 0 && age < BLAST_TICKS) {
        blasts.push({ pos: e.pos, radius: entry.before.balance.grenade.hitByDistanceTiles.at(-1)[0], alpha: 0.7 * (1 - age / BLAST_TICKS) });
      } else if (e.type === 'hit' && age >= 0 && age < HIT_FLASH_TICKS && ours(e)) {
        hits.push({ pos: positionAt(app.playback.frames, e.id, e.tick + 1), alpha: 1 - age / HIT_FLASH_TICKS });
      }
    }
    return { tracers, hits, blasts, lobbed };
  }

  // Lines of fire, arcs and grenade marks for the planned (or continuing) orders.
  function drawOrderPreview(ctx, cam) {
    const p = app.preview;
    if (!p) return;
    const lines = [];
    const rings = [];
    for (const s of p.state.soldiers) {
      if (s.side !== PLAYER_SIDE || !s.task || s.status === 'dead' || s.status === 'down') continue;
      const color = teamColor(s.team);
      const act = p.actions.get(s.id);
      if (s.task.type === 'suppress') {
        const ok = act?.mode === 'suppress';
        lines.push({ from: s.pos, to: s.task.at, color: ok ? color : 'rgba(240, 90, 70, 0.9)', dashed: true });
        rings.push({ pos: s.task.at, radius: app.state.balance.suppression.nearMissRadiusTiles, color, fill: 'rgba(255, 200, 80, 0.12)' });
      } else if (s.task.type === 'fire' || s.task.type === 'overwatch') {
        if (act?.target) lines.push({ from: s.pos, to: act.target.pos, color });
        if (s.task.type === 'overwatch' && (s.role === 'TL' || !p.state.soldiers.some((x) => x.team === s.team && x.side === s.side && x.role === 'TL'))) {
          drawArc(ctx, cam, {
            from: s.pos, toward: s.task.toward, arcDeg: app.state.balance.orders.overwatch.arcDeg,
            radius: OVERWATCH_DRAW_TILES, color, fill: 'rgba(120, 180, 255, 0.10)',
          });
        }
      } else if (s.task.type === 'grenade') {
        const plan = p.plans.find((x) => x.order?.team === s.team && x.grenade);
        lines.push({ from: s.pos, to: s.task.at, color, dashed: true });
        rings.push({ pos: s.task.at, radius: app.state.balance.grenade.dangerRadiusM / app.state.balance.map.tileMeters + (plan?.grenade.scatterTiles ?? 0),
          color: 'rgba(240, 90, 70, 0.9)', fill: 'rgba(240, 90, 70, 0.10)' });
      }
    }
    drawRings(ctx, cam, rings);
    drawFireLines(ctx, cam, lines);
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
      drawFireLines(ctx, cam, fx.lobbed.map((l) => ({ ...l, color: 'rgba(255, 255, 255, 0.5)', dashed: true })));
      drawTracers(ctx, cam, fx.tracers);
      drawSoldiers(ctx, cam, soldiers);
      drawHits(ctx, cam, fx.hits);
      drawExplosions(ctx, cam, fx.blasts);
      soldiers = [];
      renderLog();
      if (pb.elapsedTicks >= ticks) endPlayback();
    } else {
      const paths = [];
      const planned = new Set();
      for (const plan of app.plans) {
        if (!plan.ok || (plan.order.type !== 'move' && plan.order.type !== 'assault')) continue;
        planned.add(plan.order.team);
        for (const p of plan.soldiers) {
          if (!p.path) continue;
          paths.push({ from: state.soldiers[p.id].pos, path: p.path, color: teamColor(plan.order.team), dashed: false });
        }
      }
      const held = new Set(app.plans.filter((p) => p.ok && p.order.type !== 'move' && p.order.type !== 'assault').map((p) => p.order.team));
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
      drawOrderPreview(ctx, cam);
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
    else orderAt(tile, e.shiftKey);
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
    if (k === 'home' || k === '0') {
      const { width: w, height: h } = fitCanvas(canvas);
      fitCamera(app.cam, app.state.map, w, h);
      return;
    }
    if (app.playback) return;
    if (/^[1-9]$/.test(k) && teams[Number(k) - 1]) selectTeam(teams[Number(k) - 1]);
    else if (MODE_KEYS[k]) setMode(MODE_KEYS[k]);
    else if (k === 'w') setSpeed('walk');
    else if (k === 'r') setSpeed('run');
    else if (k === 'c') setSpeed('crawl');
    else if (k === 'x') toggleHoldFire();
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
  $('holdfire').onclick = toggleHoldFire;
  for (const mode of MODES) $(`mode-${mode}`).onclick = () => setMode(mode);
  for (const stance of STANCES) $(`stance-${stance}`).onclick = () => orderStance(stance);
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
