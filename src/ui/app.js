// Browser UI: in each of BLUFOR's phases give every unit an order, see each
// preview, commit them all. The sim is only touched through planning helpers
// (moveOptions, projectOrders, checkPlan) and commitOrders. OPFOR's orders
// come from src/ai.

import { moveOptions, validateAction } from '../sim/actions.js';
import { assaultVia } from '../sim/assault.js';
import { center, distance, hexAt, key, mapBounds, neighbors, same } from '../sim/hex.js';
import { visibleFrom } from '../sim/los.js';
import { inBounds, terrainName, terrainOf } from '../sim/map.js';
import { fireDice } from '../sim/combat.js';
import { checkPlan, commitOrders, projectOrders } from '../sim/orders.js';
import { createRng } from '../sim/rng.js';
import { knownEnemies } from '../sim/spotting.js';
import { canActivate, currentPhase, unitType, unitsAt } from '../sim/state.js';
import { chooseOrders } from '../ai/basic.js';
import { createCamera, fitCamera, panBy, toWorld, zoomAt } from '../render/camera.js';
import { COLORS, counterLabel, drawBang, drawCounters, drawFire, drawHexMarks, drawMap, drawPath, drawSuspected, fitCanvas } from '../render/hexmap.js';
import { positionAlong } from './anim.js';
import { createDiceTray } from './dice.js';
import { assaultSummary, eventText, fireSummary, passText, phaseLabel, previewAction, rallyPreview, unitName } from './describe.js';

const PLAYER_SIDE = 'BLUFOR';
const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM = 1.15;
const MOVE_ANIM_MS = 220;   // per hex
const DICE_ROLL_MS = 1100;  // dice tumble this long before they settle
const DICE_STAGGER_MS = 350; // a second row (casualty rolls, the defender) settles this much later
const DICE_HOLD_MS = 800;   // the settled roll stays on screen this long
const RALLY_ROLL_MS = 700;
const RALLY_HOLD_MS = 500;
const BANG_MS = 900;        // a bang marker's life
const STEP_GAP_MS = 120;    // between steps without moves
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
    shots: [],         // lines of fire being shown: { from, to, start, ms, side, tag }
    bangs: [],         // bang markers being shown: { hex, start, k }
    playing: false,    // a commit is being played back
    timers: [],
    fireCache: null,
    hover: null,
    message: '',
    aiPending: false,
  };
  const canvas = $('board');
  const tray = createDiceTray($('dice'));
  const fit = () => {
    const { width, height } = fitCanvas(canvas);
    fitCamera(app.cam, mapBounds(app.state.map.width, app.state.map.height), width, height);
  };
  fit();

  const unit = (id) => app.state.units[id];
  const planning = () => !app.playing && !app.state.result && app.state.activeSide === PLAYER_SIDE && !app.aiPending && !app.anim.length;
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

  // ---- playback: one step at a time, dice first, then the result ----

  // Is this event's roll something the player gets to see?
  const seen = (state, e) => !!eventText(state, e, PLAYER_SIDE);
  const rolls = (e) => (e.type === 'fire' || e.type === 'assault' || (e.type === 'rally' && e.roll !== null && !e.blocked));
  const label = (u) => counterLabel(u);

  function diceSpec(state, e) {
    if (e.type === 'fire') {
      const shooter = state.units[e.unit];
      const target = e.target === null ? null : state.units[e.target];
      const known = target && (target.side === PLAYER_SIDE || e.aimed || state.contacts[PLAYER_SIDE]?.[target.id]?.level === 'spotted');
      const rows = [{ label: `To hit · needs ${e.tn}+`, values: e.dice, need: e.tn }];
      if (known && e.casualtyRolls.length) rows.push({ label: `Casualties · needs ${e.casualtyOn}+`, values: e.casualtyRolls.map((c) => c.roll), need: e.casualtyOn });
      return {
        title: `${unitName(shooter)} ${e.aimed ? 'fires on' : 'puts suppressive fire on'} ${key(e.hex)}`,
        rows, result: fireSummary(state, e, PLAYER_SIDE), rollMs: DICE_ROLL_MS, staggerMs: DICE_STAGGER_MS,
      };
    }
    if (e.type === 'assault') {
      const a = state.units[e.unit];
      const d = state.units[e.defender];
      return {
        title: `${unitName(a)} assaults ${unitName(d)} at ${key(e.hex)}`,
        rows: [
          { label: `${unitName(a)} · needs ${e.attackTn}+`, values: e.attackRolls, need: e.attackTn },
          e.defendRolls.length
            ? { label: `${unitName(d)} · needs ${e.defendTn}+`, values: e.defendRolls, need: e.defendTn }
            : { label: unitName(d), values: [], note: 'pinned: cannot shoot back' },
        ],
        result: assaultSummary(state, e), rollMs: DICE_ROLL_MS, staggerMs: 0,
      };
    }
    const u = state.units[e.unit];
    return {
      title: `${unitName(u)} rallies`,
      rows: [{ label: `Needs ${e.need}+`, values: [e.roll], need: e.need }],
      result: e.success ? `Now ${e.to}.` : `Still ${e.from}.`, rollMs: RALLY_ROLL_MS, staggerMs: 0,
    };
  }

  // How long a roll stays on screen.
  const diceMs = (spec) => spec.rollMs + spec.staggerMs * (spec.rows.length - 1) + (spec.rollMs === RALLY_ROLL_MS ? RALLY_HOLD_MS : DICE_HOLD_MS);

  function logStep(before, after, events, turnRef) {
    for (const e of events) {
      if (e.type === 'turn_start') turnRef.turn = e.turn;
      const line = passText(before, e, PLAYER_SIDE) ?? eventText(after, e, PLAYER_SIDE);
      if (!line) continue;
      const kind = e.type === 'game_over' ? 'over' : ['turn_end', 'turn_start', 'phase_start'].includes(e.type) ? 'head' : 'line';
      app.log.push({ text: line, kind, turn: turnRef.turn });
    }
    if (app.log.length > MAX_LOG) app.log.splice(0, app.log.length - MAX_LOG);
  }

  // Animate this step's moves (of units the player can see), one unit after another. Returns the time it takes.
  function animateMoves(state, events) {
    let delay = 0;
    const byUnit = new Map();
    for (const e of events.filter((x) => x.type === 'moved')) {
      const u = state.units[e.unit];
      if (u.side !== PLAYER_SIDE && state.contacts[PLAYER_SIDE]?.[u.id]?.level !== 'spotted') continue;
      if (!byUnit.has(e.unit)) byUnit.set(e.unit, [e.from]);
      byUnit.get(e.unit).push(e.to);
    }
    const now = performance.now();
    for (const [id, hexes] of byUnit) {
      app.anim.push({ id, points: hexes.map(center), start: now + delay });
      delay += (hexes.length - 1) * MOVE_ANIM_MS;
    }
    return delay;
  }

  // Carry out the orders, then play them back: each step's dice, then its
  // result on the map, the roster and the log, then its moves. `done` runs at the end.
  function run(actions, done) {
    const before = app.state;
    const steps = [];
    const final = commitOrders(before, actions, createRng(before.rngState), (state, events) => steps.push({ state, events })).state;
    app.playing = true;
    render();
    const turnRef = { turn: before.turn };
    let prev = before;
    let t = 0;
    const later = (ms, fn) => app.timers.push(setTimeout(fn, ms));
    for (const step of steps) {
      const from = prev;
      for (const e of step.events.filter((x) => rolls(x) && seen(step.state, x))) {
        const spec = diceSpec(step.state, e);
        const ms = diceMs(spec);
        later(t, () => {
          tray.show(spec);
          const now = performance.now();
          if (e.type === 'fire' || e.type === 'assault') {
            const shooter = step.state.units[e.unit];
            app.shots.push({ from: e.from, to: e.hex, start: now, ms, side: shooter.side, tag: label(shooter) });
            app.bangs.push({ hex: e.hex, start: now, k: 0 });
            const second = e.type === 'assault' || e.hits > 0; // a second bang when the dice show hits
            if (second) app.bangs.push({ hex: e.hex, start: now + spec.rollMs * 0.85, k: 1 });
          }
        });
        t += ms;
      }
      const reveal = t;
      later(reveal, () => {
        tray.hide();
        app.state = step.state;
        logStep(from, step.state, step.events, turnRef);
        animateMoves(step.state, step.events);
        render();
      });
      t += Math.max(STEP_GAP_MS, moveTime(step));
      prev = step.state;
    }
    later(t, () => {
      tray.hide();
      app.state = final;
      app.playing = false;
      app.timers = [];
      render();
      done?.();
    });
  }

  function moveTime(step) {
    let ms = 0;
    const byUnit = new Map();
    for (const e of step.events.filter((x) => x.type === 'moved')) {
      const u = step.state.units[e.unit];
      if (u.side !== PLAYER_SIDE && step.state.contacts[PLAYER_SIDE]?.[u.id]?.level !== 'spotted') continue;
      byUnit.set(e.unit, (byUnit.get(e.unit) ?? 0) + 1);
    }
    for (const n of byUnit.values()) ms += n * MOVE_ANIM_MS;
    return ms;
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
    const plan = app.plan;
    app.plan = [];
    app.selected = null;
    run(plan, enemyTurn);
  }

  function enemyTurn() {
    if (app.state.activeSide === PLAYER_SIDE || app.state.activeSide === null) {
      render();
      return;
    }
    app.aiPending = true;
    render();
    setTimeout(() => {
      app.aiPending = false;
      const side = app.state.activeSide;
      run(chooseOrders(app.state, side), enemyTurn);
    }, AI_DELAY_MS);
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
    if (!canActivate(app.state, u)) {
      return rallyPreview(app.state, u) ?? (u.moved ? 'moved: cannot fire this turn' : reloading(u) ? `reloading: cannot fire ${u.fired ? 'next' : 'this'} turn` : '');
    }
    if (i === -1) return firefight() ? 'no order: holds fire' : 'no order: holds';
    const check = checkPlan(app.state, app.plan)[i];
    return check.ok ? `${i + 1}. ${previewAction(projectedFor(u.id), app.plan[i]).replace(new RegExp(`^${u.team} `), '')}` : `${i + 1}. NOT POSSIBLE: ${check.reason}`;
  }

  // Still reloading on its side's next turn (the HMG after firing). Every unit's
  // reload runs until its side's next turn starts; only one that lasts longer is shown.
  const reloading = (u) => (u.fired ? u.reload > 1 : u.reload > 0);
  const firefight = () => !(currentPhase(app.state).actions ?? []).includes('move');

  function activeText() {
    const s = app.state;
    if (s.result) {
      return `${s.result.why.charAt(0).toUpperCase()}${s.result.why.slice(1)}. Reload the page to play again (add ?seed=2 for other dice).`;
    }
    if (!planning()) return app.aiPending || s.activeSide !== PLAYER_SIDE ? 'OPFOR is acting.' : 'Carrying out orders.';
    const total = myUnits().length;
    if (firefight()) {
      return `${total} unit${total === 1 ? '' : 's'} that did not move can fire. ${app.plan.length} of ${total} have a target; the rest hold fire.`;
    }
    return `Give move orders, then commit. A unit that moves cannot fire this turn. ${app.plan.length} of ${total} have an order; the rest hold.`;
  }

  function phaseTitle() {
    const s = app.state;
    if (s.result) return s.result.winner === PLAYER_SIDE ? 'Mission accomplished' : 'Mission failed';
    if (s.activeSide !== PLAYER_SIDE) return 'Enemy action';
    return phaseLabel(currentPhase(s).name);
  }

  // Header: the turn's phases, the current one lit.
  function renderPhases() {
    const s = app.state;
    const spans = s.balance.turn.phases.map((p, i) => {
      const el = document.createElement('span');
      el.textContent = phaseLabel(p.name);
      el.title = `${p.side}${p.automatic ? ', automatic' : ''}`;
      const cls = [];
      if (p.side !== PLAYER_SIDE) cls.push('enemy');
      if (i < s.phase || s.result) cls.push('done');
      if (i === s.phase && s.activeSide !== null) cls.push('now');
      el.className = cls.join(' ');
      return el;
    });
    $('phases').replaceChildren(...spans);
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // A small counter for the roster: the NATO frame with the infantry X and the echelon mark.
  function chip(u) {
    const svg = svgEl('svg', { class: 'chip', viewBox: '0 0 62 48', 'aria-hidden': 'true' });
    const ink = COLORS.ink;
    if (u.kind === 'leader') svg.append(svgEl('circle', { cx: 31, cy: 6, r: 3, fill: ink }));
    else {
      svg.append(svgEl('circle', { cx: 31, cy: 7, r: 4.5, fill: 'none', stroke: ink, 'stroke-width': 2 }));
      svg.append(svgEl('line', { x1: 24, y1: 14, x2: 38, y2: 0, stroke: ink, 'stroke-width': 2 }));
    }
    const fill = u.status === 'eliminated' ? '#b9b5a8' : COLORS.blufor;
    svg.append(svgEl('rect', { x: 2, y: 15, width: 58, height: 31, fill, stroke: ink, 'stroke-width': 3 }));
    svg.append(svgEl('path', { d: 'M2 15 L60 46 M60 15 L2 46', stroke: ink, 'stroke-width': 2.5 }));
    if (u.type === 'hmg') svg.append(svgEl('path', { d: 'M31 42 L31 19 M25 25 L31 19 L37 25', fill: 'none', stroke: ink, 'stroke-width': 2.5 }));
    return svg;
  }

  const ROLE_NAMES = { TL: 'TL', AR: 'AR', GRN: 'GR', RFL: 'RFL', SL: 'SL' };

  function unitCard(s, u) {
    const b = el('button', 'unit');
    if (u.id === app.selected) b.classList.add('selected');
    const ready = canActivate(s, u) && planning();
    b.disabled = !ready;
    if (!ready) b.classList.add('idle');
    const who = el('div');
    const name = el('div', 'name', u.kind === 'leader' ? 'Squad leader' : u.team);
    const roles = el('div', 'roles');
    const roster = unitType(s.balance, u).roles;
    for (const r of roster) {
      const alive = u.soldiers.includes(r);
      const span = el('span', alive ? '' : 'lost');
      span.append(el('i', alive ? 'on' : ''), document.createTextNode(ROLE_NAMES[r] ?? r));
      roles.append(span);
    }
    if (u.exposed) roles.append(el('span', '', 'exposed'));
    who.append(name, roles);
    const status = u.status !== 'ok' ? u.status : u.moved ? 'moved' : reloading(u) ? 'reloading' : 'ready';
    const tag = el('span', `tag ${u.status}`, status);
    const order = el('div', 'order', u.status === 'eliminated' ? '' : orderLine(u));
    if (order.textContent.includes('NOT POSSIBLE')) order.classList.add('bad');
    b.append(chip(u), who, tag, order);
    b.onclick = () => select(u.id);
    return b;
  }

  function render() {
    const s = app.state;
    $('mission').textContent = s.map.name;
    $('phaseName').textContent = phaseTitle();
    $('phaseCard').className = s.result ? (s.result.winner === PLAYER_SIDE ? 'won' : 'lost') : '';
    $('active').textContent = activeText();
    renderPhases();

    $('units').replaceChildren(...s.units.filter((u) => u.side === PLAYER_SIDE).map((u) => unitCard(s, u)));

    const sel = app.selected !== null ? unit(app.selected) : null;
    $('hold').disabled = !planning() || !sel || orderIndex(sel.id) === -1;
    $('clear').disabled = !planning() || !app.plan.length;
    $('commit').disabled = !planning();
    $('commit').textContent = s.result ? 'Mission over' : firefight() ? 'Commit fire' : 'Commit moves';
    $('view').classList.toggle('on', app.view);
    const contacts = knownEnemies(s, PLAYER_SIDE);
    const sp = contacts.filter((c) => c.level === 'spotted').length;
    const m = s.map.mission;
    const turn = $('turn');
    turn.replaceChildren(document.createTextNode(`Turn ${s.turn}`));
    if (m) turn.append(el('small', '', ` / ${m.turns}`));
    $('contacts').textContent = (contacts.length ? `${sp} spotted · ${contacts.length - sp} suspected` : 'No contact') + (app.reveal ? ' · debug: all OPFOR shown' : '');
    $('preview').textContent = hint(sel);
    $('message').textContent = app.message;
    const log = $('log');
    log.replaceChildren(...app.log.map((entry) => {
      const line = el('p', entry.kind === 'line' ? '' : entry.kind);
      if (entry.kind === 'line') line.append(el('b', '', `T${entry.turn}`));
      line.append(document.createTextNode(entry.text));
      return line;
    }));
    log.scrollTop = log.scrollHeight;
  }

  function hint(u) {
    if (!planning()) return '';
    if (!u) return 'Left click one of your units to select it.';
    const deselect = ' Right click to deselect.';
    if (firefight()) {
      const h = app.hover;
      if (h && options().fire.has(key(h))) return previewAction(projectedFor(u.id), { type: 'fire', unit: u.id, target: h });
      return `${u.team} selected (${fireDiceText(u)}). Point at a hex to see the odds; click to fire. Blue ring: spotted enemy (aimed fire). Red ring, in the next hex: assault. Elsewhere in the shaded area: suppressive fire.${deselect}`;
    }
    const lead = u.kind === 'leader' ? ' Teams in his hex rally for sure in the rally phase; further away the roll must beat the distance to him.' : '';
    const h = app.hover;
    const o = options();
    if (h && o.assault.some((m) => same(m, h))) return previewAction(projectedFor(u.id), { type: 'move', unit: u.id, to: h });
    const assault = o.assault.length ? ' Red ring: assault the enemy there (point at it for the odds).' : '';
    const type = unitType(app.state.balance, u);
    const moves = type.fastMove ? 'Click a green hex to move 1 hex, an orange hex to fast move 2.' : `Click a green hex to move 1 hex (the ${type.name} cannot fast move).`;
    return `${u.team} selected. ${moves}${assault}${lead}${deselect}`;
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
      const ring = !spottedHere(h) ? null : o.from && distance(o.from, h) === 1 ? COLORS.assault : COLORS.fireInk;
      marks.push(ring ? { hex: h, color: ring, width: 3, fill: COLORS.fireZone } : { hex: h, color: null, fill: COLORS.fireZone, inset: 0 });
    }
    for (const h of o.assault) marks.push({ hex: h, color: COLORS.assault, width: 4 });
    if (app.hover && inBounds(s.map, app.hover)) marks.push({ hex: app.hover, color: COLORS.hover, width: 1.5, inset: 0.02 });
    if (app.view && app.selected !== null) {
      const from = projectedFor(app.selected).units[app.selected].pos;
      const k = `${app.selected}|${key(from)}`;
      if (app.viewCache?.k !== k) app.viewCache = { k, seen: new Set(visibleFrom(s.map, s.balance, from).map(key)) };
      for (let row = 0; row < s.map.height; row++) {
        for (let col = 0; col < s.map.width; col++) {
          if (!app.viewCache.seen.has(`${col},${row}`)) marks.unshift({ hex: { col, row }, color: null, fill: COLORS.shade, inset: 0 });
        }
      }
    }
    drawHexMarks(ctx, app.cam, marks);
    drawSuspected(ctx, app.cam, knownEnemies(s, PLAYER_SIDE).filter((c) => c.level === 'suspected').map((c) => c.pos));

    // Every planned order: a line from where the unit will be when it runs.
    // Fire and assault lines go on top of the counters (drawn last), so the
    // crosshair shows on its target.
    const overlay = [];
    if (planning()) {
      const checks = checkPlan(s, app.plan);
      app.plan.forEach((a, i) => {
        if (a.type === 'pass') return;
        const from = projectOrders(s, app.plan.slice(0, i)).units[a.unit].pos;
        if (a.type === 'fire' || assaultVia(projectOrders(s, app.plan.slice(0, i)), a)) {
          const to = a.type === 'fire' ? a.target : a.to;
          const color = !checks[i].ok ? COLORS.invalid : a.type === 'move' ? COLORS.assault : a.unit === app.selected ? COLORS.plan : COLORS.fireInk;
          overlay.push(() => drawFire(ctx, app.cam, from, to, color, 1, counterLabel(unit(a.unit))));
          if (a.second) overlay.push(() => drawFire(ctx, app.cam, from, a.second, color, 1, counterLabel(unit(a.unit))));
          return;
        }
        const path = a.type === 'move' ? [a.to] : a.path;
        const color = !checks[i].ok ? COLORS.invalid : a.unit === app.selected ? COLORS.plan : COLORS.move;
        drawPath(ctx, app.cam, from, path, color);
      });
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
    drawCounters(ctx, app.cam, counters, (u) => unitType(s.balance, u).roles);

    for (const f of overlay) f();
    app.shots = app.shots.filter((x) => now < x.start + x.ms);
    for (const x of app.shots) {
      const t = (now - x.start) / x.ms;
      if (t >= 0) drawFire(ctx, app.cam, x.from, x.to, x.side === PLAYER_SIDE ? COLORS.fireInk : COLORS.hostileFireInk, t < 0.75 ? 1 : (1 - t) * 4, x.tag);
    }
    app.bangs = app.bangs.filter((b) => now < b.start + BANG_MS);
    for (const b of app.bangs) drawBang(ctx, app.cam, b.hex, (now - b.start) / BANG_MS, b.k);
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
  if (brief) app.log.push({ text: brief, kind: 'brief' });
  app.log.push({ text: 'Turn 1.', kind: 'head' }, { text: `${phaseLabel(currentPhase(app.state).name)} phase (${app.state.activeSide}).`, kind: 'head' });
  render();
  renderHover();
  enemyTurn(0);
  requestAnimationFrame(frame);
  return app;
}
