// Browser UI: select a fireteam, plan an action, see the preview, confirm.
// The sim is only touched through validateAction / moveOptions (planning)
// and applyAction (confirm). OPFOR activations come from src/ai.

import { applyAction, moveOptions, rallyTargets } from '../sim/actions.js';
import { center, hexAt, key, mapBounds, same } from '../sim/hex.js';
import { inBounds, terrainName, terrainOf } from '../sim/map.js';
import { createRng } from '../sim/rng.js';
import { canActivate, unitsAt } from '../sim/state.js';
import { chooseAction } from '../ai/basic.js';
import { createCamera, fitCamera, panBy, toWorld, zoomAt } from '../render/camera.js';
import { COLORS, drawCounters, drawHexMarks, drawMap, drawPath, fitCanvas } from '../render/hexmap.js';
import { positionAlong } from './anim.js';
import { eventText, passText, previewAction } from './describe.js';

const PLAYER_SIDE = 'BLUFOR';
const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM = 1.15;
const MOVE_ANIM_MS = 220;   // per hex
const AI_DELAY_MS = 450;    // pause before an OPFOR activation, so it can be followed
const MAX_LOG = 200;

const $ = (id) => document.getElementById(id);

export function startApp(initialState) {
  const app = {
    state: initialState,
    cam: createCamera(),
    selected: null,
    mode: 'move',
    planned: null,
    log: [],
    anim: [],
    hover: null,
    message: '',
    aiPending: false,
  };
  const canvas = $('board');
  const fit = () => {
    const { width, height } = fitCanvas(canvas);
    fitCamera(app.cam, mapBounds(app.state.map.width, app.state.map.height), width, height);
  };
  fit();

  const unit = (id) => app.state.units[id];
  const myTurn = () => app.state.activeSide === PLAYER_SIDE && !app.aiPending && !app.anim.length;

  function selectFirstReady() {
    const ready = app.state.units.filter((u) => u.side === PLAYER_SIDE && canActivate(app.state, u));
    if (!ready.some((u) => u.id === app.selected)) app.selected = ready[0]?.id ?? null;
    if (app.selected !== null && unit(app.selected).kind !== 'leader' && app.mode === 'rally') app.mode = 'move';
  }

  function setMode(mode) {
    if (mode === 'rally' && (app.selected === null || unit(app.selected).kind !== 'leader')) {
      app.message = 'Only the SL can rally. Select the SL first.';
    } else {
      app.mode = mode;
      app.message = '';
    }
    app.planned = null;
    render();
  }

  function select(id) {
    app.selected = id;
    app.planned = null;
    app.message = '';
    if (unit(id).kind !== 'leader' && app.mode === 'rally') app.mode = 'move';
    render();
  }

  // ---- planning ----

  function options() {
    if (app.selected === null || !myTurn()) return { moves: [], fast: new Map(), rally: [] };
    const u = unit(app.selected);
    const o = moveOptions(app.state, u);
    return { ...o, rally: rallyTargets(app.state, u) };
  }

  function planAt(h) {
    const u = unit(app.selected);
    const o = options();
    let action = null;
    if (app.mode === 'move' && o.moves.some((m) => same(m, h))) action = { type: 'move', unit: u.id, to: h };
    else if (app.mode === 'fast' && o.fast.has(key(h))) action = { type: 'fastMove', unit: u.id, path: o.fast.get(key(h)) };
    else if (app.mode === 'rally') {
      const t = o.rally.find((x) => same(x.pos, h));
      if (t) action = { type: 'rally', unit: u.id, target: t.id };
    }
    if (!action) {
      app.message = app.mode === 'rally' ? 'Click a suppressed or pinned team next to the SL.' : 'Not a hex this team can reach with that order.';
      app.planned = null;
    } else {
      app.message = '';
      app.planned = action;
    }
    render();
  }

  // ---- doing ----

  function perform(action) {
    const before = app.state;
    const r = applyAction(before, action, createRng(before.rngState));
    if (r.events[0]?.type === 'rejected') {
      app.message = eventText(before, r.events[0]);
      render();
      return;
    }
    for (const e of r.events) {
      const line = passText(before, e) ?? eventText(r.state, e);
      const turnLine = e.type === 'turn_end' || e.type === 'turn_start';
      if (line) app.log.push(turnLine ? line : `T${e.type === 'recover' ? r.state.turn : before.turn}  ${line}`);
      if (e.type === 'turn_start') app.log.push('');
    }
    if (app.log.length > MAX_LOG) app.log.splice(0, app.log.length - MAX_LOG);
    // Animate moves hex by hex.
    const moved = r.events.filter((e) => e.type === 'moved');
    if (moved.length) {
      const id = moved[0].unit;
      app.anim.push({ id, points: [moved[0].from, ...moved.map((e) => e.to)].map(center), start: performance.now() });
    }
    app.state = r.state;
    app.planned = null;
    selectFirstReady();
    render();
    afterAction();
  }

  function afterAction() {
    if (app.state.activeSide === PLAYER_SIDE || app.state.activeSide === null) return;
    app.aiPending = true;
    render();
    setTimeout(() => {
      app.aiPending = false;
      const a = chooseAction(app.state, app.state.activeSide);
      if (a) perform(a);
      else render();
    }, AI_DELAY_MS + app.anim.length * MOVE_ANIM_MS * 2);
  }

  function confirm() {
    if (!myTurn()) return;
    if (app.planned) perform(app.planned);
  }

  function pass() {
    if (!myTurn() || app.selected === null) return;
    perform({ type: 'pass', unit: app.selected });
  }

  function nextUnit() {
    const ready = app.state.units.filter((u) => u.side === PLAYER_SIDE && canActivate(app.state, u));
    if (!ready.length) return;
    const i = ready.findIndex((u) => u.id === app.selected);
    select(ready[(i + 1) % ready.length].id);
  }

  // ---- panel ----

  function render() {
    const s = app.state;
    const left = (side) => s.units.filter((u) => u.side === side && canActivate(s, u)).length;
    $('turn').textContent = `Turn ${s.turn}`;
    $('active').textContent = app.aiPending || s.activeSide !== PLAYER_SIDE
      ? `OPFOR is acting. (BLUFOR ${left('BLUFOR')} left, OPFOR ${left('OPFOR')} left to act this turn.)`
      : `Your activation. Pick a unit and an order. (BLUFOR ${left('BLUFOR')} left, OPFOR ${left('OPFOR')} left.)`;

    const list = $('units');
    list.replaceChildren(...s.units.filter((u) => u.side === PLAYER_SIDE).map((u) => {
      const b = document.createElement('button');
      b.className = 'unit' + (u.id === app.selected ? ' selected' : '');
      b.disabled = !canActivate(s, u) || !myTurn();
      const status = u.status === 'ok' ? '' : ` ${u.status.toUpperCase()}`;
      const acted = u.status === 'eliminated' ? ' (eliminated)' : u.activated ? ' (acted)' : '';
      const men = u.kind === 'leader' ? '(squad leader)' : u.soldiers.join(' ');
      b.textContent = `${u.team}  ${men}${status}${u.exposed ? ' exposed' : ''}${acted}`;
      b.onclick = () => select(u.id);
      return b;
    }));

    const sel = app.selected !== null ? unit(app.selected) : null;
    for (const m of ['move', 'fast', 'rally']) {
      const b = $(`mode-${m}`);
      b.classList.toggle('selected', app.mode === m);
      b.disabled = !myTurn() || !sel || (m === 'rally' && sel.kind !== 'leader');
    }
    $('pass').disabled = !myTurn() || !sel;
    $('confirm').disabled = !myTurn() || !app.planned;
    $('preview').textContent = app.planned ? previewAction(s, app.planned) : (sel ? hint(sel) : '');
    $('message').textContent = app.message;
    const log = $('log');
    log.textContent = app.log.join('\n') || 'No actions yet.';
    log.scrollTop = log.scrollHeight;
  }

  function hint(u) {
    if (!canActivate(app.state, u)) return `${u.team} has acted this turn.`;
    if (u.status !== 'ok') return `${u.team} is ${u.status}: cannot move.${u.kind === 'leader' && u.status !== 'pinned' ? ' Can still rally.' : ''} Pass, or wait for a rally.`;
    return { move: `${u.team}: click a green hex to move 1 hex.`, fast: `${u.team}: click an orange hex to fast move up to 2 hexes.`, rally: `${u.team}: click a blue hex to rally that team.` }[app.mode];
  }

  function renderHover() {
    const h = app.hover;
    if (!h || !inBounds(app.state.map, h)) {
      $('status').textContent = 'Click a unit to select it. Click a hex to plan, click again or press Space to confirm. Drag: pan. Wheel: zoom.';
      return;
    }
    const t = terrainName(app.state.map, h);
    const info = terrainOf(app.state.map, app.state.balance, h);
    const parts = [`${key(h)} ${t}`, `${app.state.balance.map.hexMeters} m hex`, info.move === 'rough' ? 'rough (ends a fast move)' : info.move,
      `casualties on ${info.casualtyOn}+`, info.concealing ? 'concealing' : 'no concealment', info.blocksLos ? 'blocks line of sight' : null].filter(Boolean);
    const here = unitsAt(app.state, h).map((u) => `${u.side} ${u.team} ${u.soldiers.length} men ${u.status}`);
    $('status').textContent = parts.join(', ') + (here.length ? ` | ${here.join('; ')}` : '');
  }

  // ---- drawing ----

  function positionOf(u, now) {
    const a = app.anim.find((x) => x.id === u.id);
    if (!a) return center(u.pos);
    return positionAlong(a.points, (now - a.start) / MOVE_ANIM_MS);
  }

  // Draw every frame; an error is shown instead of silently stopping the loop.
  function frame(now) {
    try {
      draw(now);
    } catch (err) {
      console.error(err);
      $('message').textContent = `Display error: ${err.message}`;
    }
    requestAnimationFrame(frame);
  }

  function draw(now) {
    const { ctx, width, height } = fitCanvas(canvas);
    const s = app.state;
    const obj = s.map.objective ? { col: s.map.objective[0], row: s.map.objective[1] } : null;
    drawMap(ctx, app.cam, s.map, width, height, obj);

    const marks = [];
    const o = options();
    if (app.mode === 'move') for (const h of o.moves) marks.push({ hex: h, color: COLORS.move });
    if (app.mode === 'fast') for (const path of o.fast.values()) marks.push({ hex: path[path.length - 1], color: COLORS.fast });
    if (app.mode === 'rally') for (const t of o.rally) marks.push({ hex: t.pos, color: COLORS.rally, width: 3 });
    if (app.hover && inBounds(s.map, app.hover)) marks.push({ hex: app.hover, color: 'rgba(255, 255, 255, 0.6)', width: 1, inset: 0.02 });
    drawHexMarks(ctx, app.cam, marks);

    if (app.planned && app.planned.type !== 'pass') {
      const u = unit(app.planned.unit);
      const path = app.planned.type === 'move' ? [app.planned.to] : app.planned.type === 'fastMove' ? app.planned.path : [unit(app.planned.target).pos];
      drawPath(ctx, app.cam, u.pos, path, COLORS.plan);
    }

    const animating = app.anim.length;
    app.anim = app.anim.filter((a) => (now - a.start) / MOVE_ANIM_MS < a.points.length - 1);
    if (animating && !app.anim.length) render(); // the panel waits for moves to finish
    const counters = s.units.map((u) => ({
      unit: u,
      pos: positionOf(u, now),
      selected: u.id === app.selected,
      stackedWithTeam: u.kind === 'leader' && unitsAt(s, u.pos).some((x) => x.kind === 'team'),
    }));
    // Teams first so the SL sits on top.
    counters.sort((a, b) => (a.unit.kind === 'leader') - (b.unit.kind === 'leader'));
    drawCounters(ctx, app.cam, counters, s.balance.unit.roles);
  }

  // ---- input ----

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    app.hover = hexAt(toWorld(app.cam, e.clientX - r.left, e.clientY - r.top));
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
    if (!d || d.moved || d.button !== 0 || !myTurn()) return;
    const r = canvas.getBoundingClientRect();
    const h = hexAt(toWorld(app.cam, e.clientX - r.left, e.clientY - r.top));
    if (!inBounds(app.state.map, h)) return;
    // Second click on the planned hex confirms.
    if (app.planned) {
      const p = app.planned;
      const target = p.type === 'move' ? p.to : p.type === 'fastMove' ? p.path[p.path.length - 1] : p.type === 'rally' ? unit(p.target).pos : null;
      if (target && same(target, h)) {
        confirm();
        return;
      }
    }
    // A rally target click comes before selecting the team in that hex.
    if (app.mode === 'rally' && app.selected !== null && options().rally.some((t) => same(t.pos, h))) {
      planAt(h);
      return;
    }
    const mine = unitsAt(app.state, h).filter((u) => u.side === PLAYER_SIDE && canActivate(app.state, u));
    if (mine.length) {
      // Clicking a stacked hex again switches between the team and the SL.
      const i = mine.findIndex((u) => u.id === app.selected);
      select(mine[(i + 1) % mine.length].id);
      return;
    }
    if (app.selected !== null) planAt(h);
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
  window.addEventListener('resize', fit);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      e.preventDefault();
      confirm();
    } else if (k === 'escape') {
      app.planned = null;
      render();
    } else if (k === 'tab') {
      e.preventDefault();
      nextUnit();
    } else if (k === 'm') setMode('move');
    else if (k === 'r') setMode('fast');
    else if (k === 'l') setMode('rally');
    else if (k === 'p') pass();
    else if (k === 'home' || k === '0') fit();
  });

  $('mode-move').onclick = () => setMode('move');
  $('mode-fast').onclick = () => setMode('fast');
  $('mode-rally').onclick = () => setMode('rally');
  $('pass').onclick = pass;
  $('confirm').onclick = confirm;

  app.log.push(`Turn 1. ${app.state.activeSide} has the initiative.`);
  selectFirstReady();
  render();
  renderHover();
  afterAction();
  requestAnimationFrame(frame);
  return app;
}
