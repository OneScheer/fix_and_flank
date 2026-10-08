// Browser UI: in each of BLUFOR's phases give every unit an order, see each
// preview, commit them all. The sim is only touched through planning helpers
// (moveOptions, projectOrders, checkPlan) and commitOrders. OPFOR's orders
// come from src/ai.

import { moveOptions, validateAction } from '../sim/actions.js';
import { assaultVia } from '../sim/assault.js';
import { center, hexAt, key, mapBounds, neighbors, same } from '../sim/hex.js';
import { visibleFrom } from '../sim/los.js';
import { inBounds, terrainName, terrainOf } from '../sim/map.js';
import { fireDice } from '../sim/combat.js';
import { checkPlan, commitOrders, projectOrders } from '../sim/orders.js';
import { createRng } from '../sim/rng.js';
import { knownEnemies } from '../sim/spotting.js';
import { canActivate, currentPhase, unitsAt } from '../sim/state.js';
import { chooseOrders } from '../ai/basic.js';
import { createCamera, fitCamera, panBy, toWorld, zoomAt } from '../render/camera.js';
import { COLORS, drawCounters, drawFire, drawHexMarks, drawMap, drawPath, drawSuspected, fitCanvas } from '../render/hexmap.js';
import { positionAlong } from './anim.js';
import { eventText, passText, phaseLabel, previewAction, rallyPreview } from './describe.js';

const PLAYER_SIDE = 'BLUFOR';
const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM = 1.15;
const MOVE_ANIM_MS = 220;   // per hex
const SHOT_MS = 650;        // a line of fire stays this long
const SHOT_GAP_MS = 300;    // between shots, in the order they were fired
const AI_DELAY_MS = 450;    // pause before OPFOR commits, so it can be followed
const MAX_LOG = 200;

const $ = (id) => document.getElementById(id);

export function startApp(initialState, { reveal = false } = {}) {
  const app = {
    reveal,            // debug: draw unseen OPFOR faintly (?reveal=1)
    view: false,       // shade hexes the selected unit cannot see (V)
    viewCache: null,
    state: initialState,
    cam: createCamera(),
    selected: null,
    plan: [],          // BLUFOR's orders for this turn, in the order they will run
    log: [],
    anim: [],
    shots: [],         // lines of fire being shown: { from, to, start, side }
    fireCache: null,
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
  const planning = () => !app.state.result && app.state.activeSide === PLAYER_SIDE && !app.aiPending && !app.anim.length;
  const myUnits = () => app.state.units.filter((u) => u.side === PLAYER_SIDE && canActivate(app.state, u));
  const orderIndex = (id) => app.plan.findIndex((a) => a.unit === id);
  const spotted = (u) => app.state.contacts[PLAYER_SIDE]?.[u.id]?.level === 'spotted';
  const shown = (u) => u.side === PLAYER_SIDE || spotted(u);

  // The state a unit's order is planned against: the orders before it applied.
  function projectedFor(id) {
    const i = orderIndex(id);
    return projectOrders(app.state, i === -1 ? app.plan : app.plan.slice(0, i));
  }

  // Selection: left click a unit to select it, right click (or Esc) to deselect.
  function select(id) {
    app.selected = id;
    app.message = '';
    render();
  }

  function deselect() {
    app.selected = null;
    app.message = '';
    render();
  }

  // ---- planning ----

  function options() {
    if (app.selected === null || !planning()) return { moves: [], fast: new Map(), fire: new Set(), assault: [], from: null };
    const p = projectedFor(app.selected);
    const u = p.units[app.selected];
    const assault = neighbors(u.pos).filter((h) => assaultVia(p, { type: 'move', unit: u.id, to: h })
      && validateAction(p, { type: 'move', unit: u.id, to: h }).ok);
    return { ...moveOptions(p, u), fire: fireTargets(p, u), assault, from: u.pos };
  }

  // Hexes the unit can fire at (keys). Cached: it checks line of sight to every hex in range.
  function fireTargets(p, u) {
    const k = `${u.id}|${JSON.stringify(app.plan)}`;
    if (app.fireCache?.state === app.state && app.fireCache.k === k) return app.fireCache.set;
    const set = new Set();
    if (firefight()) {
      for (let row = 0; row < p.map.height; row++) {
        for (let col = 0; col < p.map.width; col++) {
          if (validateAction(p, { type: 'fire', unit: u.id, target: { col, row } }).ok) set.add(`${col},${row}`);
        }
      }
    }
    app.fireCache = { state: app.state, k, set };
    return set;
  }

  // Give (or replace) the selected unit's order. A replaced order keeps its place.
  function setOrder(action) {
    const i = orderIndex(action.unit);
    if (i === -1) app.plan.push(action);
    else app.plan[i] = action;
    app.message = '';
    app.selected = null; // order given: the next click picks the next unit
    render();
  }

  // The order a click on hex h gives the selected unit, or null. In the
  // movement phase the distance decides: a next hex is a move, a hex two away
  // a fast move. In the firefight, any hex it can fire at.
  function orderFor(h) {
    if (app.selected === null) return null;
    const id = app.selected;
    const o = options();
    if (o.fire.has(key(h))) return { type: 'fire', unit: id, target: h };
    if (o.assault.some((m) => same(m, h))) return { type: 'move', unit: id, to: h };
    if (o.moves.some((m) => same(m, h))) return { type: 'move', unit: id, to: h };
    if (o.fast.has(key(h))) return { type: 'fastMove', unit: id, path: o.fast.get(key(h)) };
    return null;
  }

  function holdSelected() {
    if (app.selected === null || !planning()) return;
    const i = orderIndex(app.selected);
    if (i !== -1) app.plan.splice(i, 1);
    render();
  }

  function clearAll() {
    if (!planning()) return;
    app.plan = [];
    render();
  }

  // ---- commit ----

  function run(actions) {
    const before = app.state;
    const r = commitOrders(before, actions, createRng(before.rngState));
    let turn = before.turn;
    for (const e of r.events) {
      if (e.type === 'turn_start') turn = e.turn;
      const line = passText(before, e, PLAYER_SIDE) ?? eventText(r.state, e, PLAYER_SIDE);
      if (!line) continue;
      if (e.type === 'turn_start') app.log.push('');
      const heading = ['turn_end', 'turn_start', 'phase_start', 'game_over'].includes(e.type);
      app.log.push(heading ? line : `T${turn}  ${line}`);
    }
    if (app.log.length > MAX_LOG) app.log.splice(0, app.log.length - MAX_LOG);
    // Animate the moves one unit after another, in the order they ran, then
    // show the lines of fire the player could see.
    let delay = 0;
    const byUnit = new Map();
    for (const e of r.events.filter((x) => x.type === 'moved')) {
      if (!byUnit.has(e.unit)) byUnit.set(e.unit, [e.from]);
      byUnit.get(e.unit).push(e.to);
    }
    const now = performance.now();
    for (const [id, hexes] of byUnit) {
      app.anim.push({ id, points: hexes.map(center), start: now + delay });
      delay += (hexes.length - 1) * MOVE_ANIM_MS;
    }
    for (const e of r.events.filter((x) => x.type === 'fire')) {
      if (!eventText(r.state, e, PLAYER_SIDE)) continue;
      app.shots.push({ from: e.from, to: e.hex, start: now + delay, side: r.state.units[e.unit].side });
      delay += SHOT_GAP_MS;
    }
    app.state = r.state;
    render();
    return delay;
  }

  function commit() {
    if (!planning()) return;
    const bad = checkPlan(app.state, app.plan).filter((c) => !c.ok);
    if (bad.length) {
      app.message = `Fix or clear these orders first: ${bad.map((c) => `${unit(c.action.unit).team} (${c.reason})`).join('; ')}.`;
      render();
      return;
    }
    app.message = '';
    const delay = run(app.plan);
    app.plan = [];
    enemyTurn(delay);
  }

  function enemyTurn(delay) {
    if (app.state.activeSide === PLAYER_SIDE || app.state.activeSide === null) {
      app.selected = null;
      render();
      return;
    }
    app.aiPending = true;
    render();
    setTimeout(() => {
      app.aiPending = false;
      const side = app.state.activeSide;
      const d = run(chooseOrders(app.state, side));
      enemyTurn(d);
    }, AI_DELAY_MS + delay);
  }

  function toggleView() {
    app.view = !app.view;
    render();
  }

  function nextUnit() {
    const ready = myUnits();
    if (!ready.length) return;
    const i = ready.findIndex((u) => u.id === app.selected);
    select(ready[(i + 1) % ready.length].id);
  }

  // ---- panel ----

  function orderLine(u) {
    const i = orderIndex(u.id);
    if (!canActivate(app.state, u)) return rallyPreview(app.state, u) ?? (u.moved ? 'moved: cannot fire this turn' : '');
    if (i === -1) return firefight() ? 'no order: holds fire' : 'no order: holds';
    const check = checkPlan(app.state, app.plan)[i];
    return check.ok ? `${i + 1}. ${previewAction(projectedFor(u.id), app.plan[i]).replace(new RegExp(`^${u.team} `), '')}` : `${i + 1}. NOT POSSIBLE: ${check.reason}`;
  }

  const firefight = () => !(currentPhase(app.state).actions ?? []).includes('move');

  function activeText() {
    const s = app.state;
    if (s.result) {
      return `Mission over: ${s.result.winner === PLAYER_SIDE ? 'you win' : 'you lose'}. ${s.result.why.charAt(0).toUpperCase()}${s.result.why.slice(1)}. Reload the page to play again (add ?seed=2 for other dice).`;
    }
    if (!planning()) return app.aiPending || s.activeSide !== PLAYER_SIDE ? 'Enemy action: OPFOR is acting.' : 'Carrying out orders.';
    const total = myUnits().length;
    if (firefight()) {
      return `Firefight phase: ${total} unit${total === 1 ? '' : 's'} that did not move can fire. ${app.plan.length} of ${total} have a target; the rest hold fire.`;
    }
    return `Movement phase: give move orders, then commit. A unit that moves cannot fire this turn. ${app.plan.length} of ${total} have an order; the rest hold.`;
  }

  // Header: the turn's phases, the current one lit.
  function renderPhases() {
    const s = app.state;
    const spans = s.balance.turn.phases.map((p, i) => {
      const el = document.createElement('span');
      el.textContent = phaseLabel(p.name);
      el.title = `${p.side}${p.automatic ? ', automatic' : ''}`;
      if (i < s.phase) el.className = 'done';
      if (i === s.phase && s.activeSide !== null) el.className = 'now';
      return el;
    });
    $('phases').replaceChildren(...spans);
  }

  function render() {
    const s = app.state;
    $('active').textContent = activeText();
    renderPhases();

    const list = $('units');
    list.replaceChildren(...s.units.filter((u) => u.side === PLAYER_SIDE).map((u) => {
      const b = document.createElement('button');
      b.className = 'unit' + (u.id === app.selected ? ' selected' : '');
      b.disabled = !canActivate(s, u) || !planning();
      const status = u.status === 'ok' ? '' : ` ${u.status.toUpperCase()}`;
      const men = u.kind === 'leader' ? '(squad leader)' : u.soldiers.join(' ');
      const head = document.createElement('div');
      head.textContent = `${u.team}  ${men}${status}${u.exposed ? ' exposed' : ''}${u.status === 'eliminated' ? ' (eliminated)' : ''}`;
      const order = document.createElement('div');
      order.className = 'order';
      order.textContent = u.status === 'eliminated' ? '' : orderLine(u);
      if (order.textContent.includes('NOT POSSIBLE')) order.classList.add('bad');
      b.append(head, order);
      b.onclick = () => select(u.id);
      return b;
    }));

    const sel = app.selected !== null ? unit(app.selected) : null;
    $('hold').disabled = !planning() || !sel || orderIndex(sel.id) === -1;
    $('clear').disabled = !planning() || !app.plan.length;
    $('commit').disabled = !planning();
    $('commit').textContent = firefight() ? 'COMMIT FIRE' : 'COMMIT MOVES';
    $('view').classList.toggle('selected', app.view);
    const contacts = knownEnemies(s, PLAYER_SIDE);
    const sp = contacts.filter((c) => c.level === 'spotted').length;
    const m = s.map.mission;
    $('turn').textContent = `${m ? `${s.map.name}. ` : ''}Turn ${s.turn}${m ? ` of ${m.turns}` : ''}. ${contacts.length ? `Contacts: ${sp} spotted, ${contacts.length - sp} suspected.` : 'No contact.'}${app.reveal ? ' DEBUG: showing all OPFOR.' : ''}`;
    $('preview').textContent = hint(sel);
    $('message').textContent = app.message;
    const log = $('log');
    log.textContent = app.log.join('\n') || 'No orders carried out yet.';
    log.scrollTop = log.scrollHeight;
  }

  function hint(u) {
    if (!planning()) return '';
    if (!u) return 'Left click one of your units to select it.';
    const deselect = ' Right click to deselect.';
    if (firefight()) {
      const h = app.hover;
      if (h && options().fire.has(key(h))) return previewAction(projectedFor(u.id), { type: 'fire', unit: u.id, target: h });
      return `${u.team} selected (${fireDiceText(u)}). Point at a hex to see the odds; click to fire. Red ring: spotted enemy (aimed fire; in the next hex, an assault). Elsewhere in the red area: suppressive fire.${deselect}`;
    }
    const lead = u.kind === 'leader' ? ' Teams in his hex rally for sure in the rally phase; further away the roll must beat the distance to him.' : '';
    const h = app.hover;
    const o = options();
    if (h && o.assault.some((m) => same(m, h))) return previewAction(projectedFor(u.id), { type: 'move', unit: u.id, to: h });
    const assault = o.assault.length ? ' Red ring: assault the enemy there (point at it for the odds).' : '';
    return `${u.team} selected. Click a green hex to move 1 hex, an orange hex to fast move 2.${assault}${lead}${deselect}`;
  }

  const fireDiceText = (u) => { const n = fireDice(app.state.balance, u); return `${n} ${n === 1 ? 'die' : 'dice'}`; };

  function renderHover() {
    if (planning() && app.selected !== null) $('preview').textContent = hint(unit(app.selected));
    const h = app.hover;
    if (!h || !inBounds(app.state.map, h)) {
      $('status').textContent = 'Click a unit, then a hex to give its order. Space commits all orders. Drag: pan. Wheel: zoom.';
      return;
    }
    const t = terrainName(app.state.map, h);
    const info = terrainOf(app.state.map, app.state.balance, h);
    const parts = [`${key(h)} ${t}`, `${app.state.balance.map.hexMeters} m hex`, info.move === 'rough' ? 'rough (ends a fast move)' : info.move,
      `casualties on ${info.casualtyOn}+`, info.concealing ? 'concealing' : 'no concealment', info.blocksLos ? 'blocks line of sight' : null].filter(Boolean);
    const sides = Object.entries(app.state.map.sides[key(h)] ?? {});
    if (sides.length) {
      parts.push(sides.map(([side, f]) => `${f} on ${side} side (casualties on ${app.state.balance.hexsides[f].casualtyOn}+ from that side)`).join(', '));
    }
    const here = unitsAt(app.state, h).filter(shown).map((u) => `${u.side} ${u.team} ${u.soldiers.length} men ${u.status}${u.moved ? ', moved (cannot fire this turn)' : ''}`);
    const suspect = knownEnemies(app.state, PLAYER_SIDE).find((c) => c.level === 'suspected' && same(c.pos, h));
    if (suspect) here.push('suspected enemy (last known position)');
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
    for (const h of o.moves) marks.push({ hex: h, color: COLORS.move });
    for (const path of o.fast.values()) {
      const end = path[path.length - 1];
      if (!o.moves.some((m) => same(m, end))) marks.push({ hex: end, color: COLORS.fast });
    }
    const spottedHere = (h) => s.units.some((u) => u.side !== PLAYER_SIDE && spotted(u) && u.status !== 'eliminated' && same(u.pos, h));
    for (const k of o.fire) {
      const [col, row] = k.split(',').map(Number);
      const h = { col, row };
      marks.push(spottedHere(h) ? { hex: h, color: COLORS.fire, width: 3, fill: COLORS.fireZone } : { hex: h, color: null, fill: COLORS.fireZone, inset: 0 });
    }
    for (const h of o.assault) marks.push({ hex: h, color: COLORS.fire, width: 4 });
    if (app.hover && inBounds(s.map, app.hover)) marks.push({ hex: app.hover, color: 'rgba(255, 255, 255, 0.6)', width: 1, inset: 0.02 });
    if (app.view && app.selected !== null) {
      const from = projectedFor(app.selected).units[app.selected].pos;
      const k = `${app.selected}|${key(from)}`;
      if (app.viewCache?.k !== k) app.viewCache = { k, seen: new Set(visibleFrom(s.map, s.balance, from).map(key)) };
      for (let row = 0; row < s.map.height; row++) {
        for (let col = 0; col < s.map.width; col++) {
          if (!app.viewCache.seen.has(`${col},${row}`)) marks.unshift({ hex: { col, row }, color: null, fill: 'rgba(0, 0, 0, 0.6)', inset: 0 });
        }
      }
    }
    drawHexMarks(ctx, app.cam, marks);
    drawSuspected(ctx, app.cam, knownEnemies(s, PLAYER_SIDE).filter((c) => c.level === 'suspected').map((c) => c.pos));

    // Every planned order: a line from where the unit will be when it runs.
    if (planning()) {
      const checks = checkPlan(s, app.plan);
      app.plan.forEach((a, i) => {
        if (a.type === 'pass') return;
        const from = projectOrders(s, app.plan.slice(0, i)).units[a.unit].pos;
        if (a.type === 'fire' || assaultVia(projectOrders(s, app.plan.slice(0, i)), a)) {
          const to = a.type === 'fire' ? a.target : a.to;
          drawFire(ctx, app.cam, from, to, !checks[i].ok ? COLORS.pinned : a.unit === app.selected ? COLORS.plan : COLORS.fire);
          return;
        }
        const path = a.type === 'move' ? [a.to] : a.path;
        const color = !checks[i].ok ? COLORS.pinned : a.unit === app.selected ? COLORS.plan : COLORS.move;
        drawPath(ctx, app.cam, from, path, color);
      });
    }

    app.shots = app.shots.filter((x) => now < x.start + SHOT_MS);
    for (const x of app.shots) {
      if (now >= x.start) drawFire(ctx, app.cam, x.from, x.to, x.side === PLAYER_SIDE ? COLORS.blufor : COLORS.opfor, 1 - (now - x.start) / SHOT_MS);
    }

    const animating = app.anim.length;
    app.anim = app.anim.filter((a) => (now - a.start) / MOVE_ANIM_MS < a.points.length - 1);
    if (animating && !app.anim.length) render(); // the panel waits for moves to finish
    const counters = s.units.filter((u) => shown(u) || app.reveal).map((u) => ({
      unit: u,
      ghost: !shown(u),
      pos: positionOf(u, now),
      selected: u.id === app.selected && planning(),
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
    if (!d || d.moved || !planning()) return;
    if (d.button === 2) {
      deselect();
      return;
    }
    if (d.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const h = hexAt(toWorld(app.cam, e.clientX - r.left, e.clientY - r.top));
    if (!inBounds(app.state.map, h)) return;
    // With a unit selected, a hex it can be ordered to gives the order...
    const order = orderFor(h);
    if (order) {
      setOrder(order);
      return;
    }
    // ...otherwise a click on own units selects (again on a shared hex: switch team / SL).
    const mine = unitsAt(app.state, h).filter((u) => u.side === PLAYER_SIDE && canActivate(app.state, u));
    if (mine.length) {
      const i = mine.findIndex((u) => u.id === app.selected);
      select(mine[(i + 1) % mine.length].id);
      return;
    }
    if (app.selected !== null) {
      const why = firefight() ? validateAction(projectedFor(app.selected), { type: 'fire', unit: app.selected, target: h }).reason : null;
      app.message = firefight()
        ? `Cannot fire there: ${why}. Right click to deselect.`
        : 'That hex is out of reach. Green: move, orange: fast move. Right click to deselect.';
      render();
    }
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
      e.preventDefault(); // also stops a focused button from being clicked by Space
      commit();
    } else if (k === 'tab') {
      e.preventDefault();
      nextUnit();
    } else if (k === 'escape') deselect();
    else if (k === 'h' || k === 'backspace' || k === 'delete') holdSelected();
    else if (k === 'v') toggleView();
    else if (k === 'home' || k === '0') fit();
  });

  $('hold').onclick = holdSelected;
  $('clear').onclick = clearAll;
  $('commit').onclick = commit;
  $('view').onclick = toggleView;

  const brief = app.state.map.mission?.brief;
  if (brief) app.log.push(`${app.state.map.name}. ${brief}`, '');
  app.log.push('Turn 1.', `${phaseLabel(currentPhase(app.state).name)} phase (${app.state.activeSide}).`);
  render();
  renderHover();
  enemyTurn(0);
  requestAnimationFrame(frame);
  return app;
}
