// Milestone 5 acceptance: the preview matches what actually happens in the sim.
// Each test reads a prediction from the preview, runs the sim, and checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOfSight } from '../src/sim/los.js';
import { tileAt } from '../src/sim/map.js';
import { ammoForecast, knownEnemies, routeExposure, suppressionPerSec } from '../src/sim/predict.js';
import { resolveTurn } from '../src/sim/step.js';
import { previewTurn } from '../src/ui/preview.js';
import { balance, grass, makeState } from './helpers.js';

const unit = (side, team, role, x, y, stance) => ({ side, team, role, pos: [x, y], ...(stance ? { stance } : {}) });
const B = (team, type, extra) => ({ type, side: 'BLUFOR', team, ...extra });
const spot = (s, id, level = 'spotted') => {
  s.contacts.BLUFOR[id] = { level, pos: { ...s.soldiers[id].pos }, lastSeenSec: 0 };
};
const endOfTick = (s, e) => (e.tick + 1) * s.tickSec;

// OPFOR rifleman crouched behind a low wall at (20,6); BLUFOR fireteam 20 tiles south.
// The RFL is behind a full wall of his own and has no shot.
function range() {
  const rows = grass(41, 30);
  rows[7] = '.'.repeat(20) + '-' + '.'.repeat(20);
  rows[25] = '.'.repeat(24) + '#' + '.'.repeat(16);
  const s = makeState(rows, [
    unit('BLUFOR', 'ALPHA', 'TL', 18, 26),
    unit('BLUFOR', 'ALPHA', 'AR', 21, 26),
    unit('BLUFOR', 'ALPHA', 'RFL', 24, 26, 'prone'), // wall right in front of him at (24,25)
    unit('OPFOR', 'ALPHA', 'RFL', 20, 6, 'crouch'),
  ]);
  s.soldiers[3].ammo = 0; // the target holds fire, so nothing changes under us
  return s;
}

test('fire: the previewed hit chances are the ones the sim rolls, soldier by soldier', () => {
  const s = range();
  spot(s, 3);
  const orders = [B('ALPHA', 'fire', { target: 3 })];
  const p = previewTurn(s, 'BLUFOR', orders);
  const { events } = resolveTurn(s, orders);
  for (const id of [0, 1]) {
    const predicted = p.actions.get(id);
    const first = events.find((e) => e.type === 'fire' && e.id === id);
    assert.equal(first.tick, 0);
    assert.equal(first.target, predicted.target.id);
    assert.equal(first.chance, predicted.chance, `soldier ${id}`);
  }
  // The RFL has no shot: the preview says so, and the sim never fires him at the target.
  assert.equal(p.actions.get(2), null);
  assert.ok(p.lines[0].notes.some((n) => n.startsWith('RFL has no shot at the target')));
  assert.equal(events.filter((e) => e.type === 'fire' && e.id === 2).length, 0);
  assert.match(p.lines[0].text, /2 of 3 have a shot/);
});

test('suppress: who cannot fire, and why, is exactly what the sim reports', () => {
  const s = range();
  spot(s, 3, 'suspected');
  const orders = [B('ALPHA', 'suppress', { at: { x: 20, y: 6 }, target: 3 })];
  const p = previewTurn(s, 'BLUFOR', orders);
  const { events } = resolveTurn(s, orders);
  const note = p.lines[0].notes.find((n) => n.startsWith('RFL cannot fire'));
  const simReason = events.find((e) => e.type === 'no_fire' && e.id === 2).reason;
  assert.ok(note.includes(simReason), `${note} vs ${simReason}`);
  for (const id of [0, 1]) assert.ok(events.some((e) => e.type === 'fire' && e.id === id && e.mode === 'suppress'));
});

test('suppress: the previewed suppression per second is what lands on the point', () => {
  // Target standing in the open exactly on the aim point, so it takes the full amount.
  const s = makeState(grass(30, 10), [unit('BLUFOR', 'ALPHA', 'AR', 0, 5), unit('BLUFOR', 'ALPHA', 'RFL', 0, 6),
    unit('OPFOR', 'ALPHA', 'RFL', 20, 5, 'prone')]);
  s.soldiers[2].ammo = 0;
  const orders = [B('ALPHA', 'suppress', { at: { x: 20, y: 5 } })];
  const predicted = s.soldiers.slice(0, 2).reduce((a, x) => a + suppressionPerSec(s, x, 'suppress'), 0);
  const { events } = resolveTurn(s, orders);
  const landed = events.filter((e) => e.type === 'fire')
    .flatMap((e) => e.suppressed).filter((x) => x.id === 2).reduce((a, x) => a + x.amount, 0);
  assert.ok(Math.abs(landed - predicted * balance.turn.durationSec) < 1e-6, `landed ${landed}, predicted ${predicted}/s`);
});

test('ammo: "lasts about N s of fire" is when the sim runs dry', () => {
  for (const mode of ['suppress', 'aimed']) {
    const s = makeState(grass(30, 10), [unit('BLUFOR', 'ALPHA', 'AR', 0, 5), unit('OPFOR', 'ALPHA', 'RFL', 20, 5, 'stand')]);
    s.soldiers[0].ammo = 33; // 7 bursts of 5, the last one short
    s.soldiers[1].ammo = 0;
    s.soldiers[1].hp = 1e9; // stays standing, so the AR never runs out of target
    spot(s, 1);
    const order = mode === 'suppress' ? B('ALPHA', 'suppress', { at: { x: 20, y: 5 } }) : B('ALPHA', 'fire', { target: 1 });
    const predicted = ammoForecast(s, s.soldiers[0], mode).lastBurstSec;
    const { lines } = previewTurn(s, 'BLUFOR', [order]);
    assert.ok(lines[0].notes.some((n) => n.includes(`AR about ${predicted < 10 ? Math.round(predicted * 2) / 2 : Math.round(predicted)} s`)), lines[0].notes.join(' | '));
    let state = s;
    let out = null;
    let elapsed = 0;
    for (let turn = 0; turn < 5 && !out; turn++) {
      const r = resolveTurn(state, turn === 0 ? [order] : []);
      out = r.events.find((e) => e.type === 'out_of_ammo');
      if (out) elapsed += endOfTick(s, out);
      else elapsed += balance.turn.durationSec;
      state = r.state;
      if (mode === 'aimed') state.contacts.BLUFOR[1] = { level: 'spotted', pos: { x: 20, y: 5 }, lastSeenSec: 0 };
    }
    assert.ok(out, `${mode}: ran dry`);
    assert.equal(elapsed, predicted, mode);
  }
});

test('move: "crosses N m of open ground in view" counts the tiles the team really walks in view', () => {
  const rows = grass(40, 40);
  rows[20] = '.'.repeat(5) + 'TTTTT' + '.'.repeat(30); // a patch of trees on the way
  const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 7, 35), unit('OPFOR', 'ALPHA', 'RFL', 30, 10, 'crouch')]);
  s.soldiers[1].ammo = 0;
  spot(s, 1);
  const orders = [B('ALPHA', 'move', { dest: { x: 7, y: 5 }, speed: 'run' })];
  const p = previewTurn(s, 'BLUFOR', orders);
  const path = p.plans[0].soldiers[0].path;
  const predicted = routeExposure(s, 'BLUFOR', path, 'stand');
  assert.ok(p.lines[0].notes.some((n) => n.includes(`about ${predicted.meters} m of open ground in view`)));
  // Run the sim and check every tile the TL actually stepped on.
  let state = s;
  const walked = [];
  for (let t = 0; t < 4; t++) {
    const r = resolveTurn(state, t === 0 ? orders : []);
    walked.push(...r.events.filter((e) => e.type === 'moved' && e.id === 0).map((e) => e.to));
    state = r.state;
  }
  assert.deepEqual(walked, path);
  const enemy = knownEnemies(s, 'BLUFOR')[0];
  const inView = walked.filter((pos) => tileAt(s.map, pos.x, pos.y).concealment === 'none'
    && (() => { const l = lineOfSight(s.map, s.balance, enemy, { pos, stance: 'stand' }); return l.clear && !l.partial; })());
  assert.equal(inView.length, predicted.tiles);
  assert.ok(predicted.tiles > 0 && predicted.tiles < path.length, 'the trees break the line of sight for part of the route');
});

test('grenade: explodes when the preview says, and DANGER CLOSE names who gets caught', () => {
  const s = makeState(grass(30, 10), [
    unit('BLUFOR', 'ALPHA', 'TL', 2, 5),
    unit('BLUFOR', 'BRAVO', 'RFL', 13, 6), // too close to the impact
    unit('OPFOR', 'ALPHA', 'RFL', 13, 5),
  ]);
  for (const x of s.soldiers) x.ammo = 0;
  const orders = [B('ALPHA', 'grenade', { at: { x: 13, y: 5 } })];
  const p = previewTurn(s, 'BLUFOR', orders);
  const line = p.lines.find((l) => l.team === 'ALPHA');
  assert.match(line.text, /throws a hand grenade/);
  const sec = Number(line.text.match(/explodes about ([\d.]+) s into the turn/)[1]);
  assert.match(line.notes.join(' '), /DANGER CLOSE: BRAVO RFL/);
  const { events } = resolveTurn(s, orders);
  const boom = events.find((e) => e.type === 'explosion');
  assert.equal(endOfTick(s, boom), sec);
  assert.ok(boom.effects.find((e) => e.id === 1).chance > 0, 'the friendly really is in the blast');
});

test('assault: the previewed close assault odds are the sim\'s', () => {
  const cases = [
    { status: 'pinned', suppression: 100, expect: /Target pinned/ },
    { status: 'active', suppression: 0, expect: /not suppressed and in cover/ },
  ];
  for (const c of cases) {
    const rows = grass(20, 20);
    rows[11] = '.'.repeat(10) + '-' + '.'.repeat(9); // between the target and the attacker
    const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 10, 18), unit('OPFOR', 'ALPHA', 'RFL', 10, 10, 'crouch')]);
    s.soldiers[0].ammo = 0;
    s.soldiers[1].ammo = 0;
    s.soldiers[1].status = c.status;
    s.soldiers[1].suppression = c.suppression;
    s.soldiers[1].underFireUntilSec = 1000;
    spot(s, 1);
    const orders = [B('ALPHA', 'assault', { at: { x: 10, y: 10 }, target: 1 })];
    const p = previewTurn(s, 'BLUFOR', orders);
    const note = p.lines[0].notes.find((n) => /close assault kill chance/.test(n));
    assert.match(note, c.expect);
    const predicted = Number(note.match(/about (\d+)%/)[1]);
    let state = s;
    let first = null;
    for (let t = 0; t < 3 && !first; t++) {
      const r = resolveTurn(state, t === 0 ? orders : []);
      first = r.events.find((e) => e.type === 'assault');
      state = r.state;
      state.contacts.BLUFOR[1] = { level: 'spotted', pos: { x: 10, y: 10 }, lastSeenSec: 0 };
    }
    assert.ok(first, `${c.status}: an assault happened`);
    assert.equal(Math.round(first.chance * 100), predicted, c.status);
  }
});

test('rejected orders: the preview gives the same reason the sim does', () => {
  const s = makeState(grass(100, 5), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 2), unit('OPFOR', 'ALPHA', 'RFL', 50, 2)]);
  for (const order of [
    B('ALPHA', 'grenade', { at: { x: 40, y: 2 } }),
    B('ALPHA', 'fire', { target: 1 }),
    B('ALPHA', 'move', { dest: { x: 500, y: 2 }, speed: 'walk' }),
  ]) {
    const line = previewTurn(s, 'BLUFOR', [order]).lines[0].text;
    const sim = resolveTurn(s, [order]).events.find((e) => e.type === 'order_rejected').reason;
    assert.equal(line, `ALPHA: order not valid, ${sim}.`);
  }
});

test('the preview does not change the state it looks at', () => {
  const s = range();
  spot(s, 3);
  const before = structuredClone({ soldiers: s.soldiers, contacts: s.contacts, grenades: s.grenades });
  previewTurn(s, 'BLUFOR', [B('ALPHA', 'suppress', { at: { x: 20, y: 6 } })]);
  previewTurn(s, 'BLUFOR', [B('ALPHA', 'grenade', { at: { x: 20, y: 12 } })]);
  assert.deepEqual({ soldiers: s.soldiers, contacts: s.contacts, grenades: s.grenades }, before);
});

test('the preview never gives away an enemy the side has not spotted', () => {
  // Same order on the same tile, with and without a hidden enemy standing there.
  const make = (withEnemy) => makeState(grass(30, 10), [
    unit('BLUFOR', 'ALPHA', 'RFL', 0, 5),
    ...(withEnemy ? [unit('OPFOR', 'ALPHA', 'RFL', 20, 5, 'stand')] : [unit('OPFOR', 'ALPHA', 'RFL', 29, 9)]),
  ]);
  for (const order of [B('ALPHA', 'suppress', { at: { x: 20, y: 5 } }), B('ALPHA', 'grenade', { at: { x: 10, y: 5 } })]) {
    const a = previewTurn(make(true), 'BLUFOR', [order]).lines;
    const b = previewTurn(make(false), 'BLUFOR', [order]).lines;
    assert.deepEqual(a, b, order.type);
  }
});

test('hold fire: a moving team does not shoot, and opens up on its next fire order', () => {
  const s = makeState(grass(40, 10), [unit('BLUFOR', 'ALPHA', 'RFL', 0, 5), unit('OPFOR', 'ALPHA', 'RFL', 20, 5, 'stand')]);
  s.soldiers[1].ammo = 0;
  spot(s, 1);
  const order = B('ALPHA', 'move', { dest: { x: 10, y: 5 }, speed: 'walk', holdFire: true });
  assert.ok(previewTurn(s, 'BLUFOR', [order]).lines[0].notes.some((n) => n.startsWith('Holding fire')));
  let r = resolveTurn(s, [order]);
  assert.equal(r.events.filter((e) => e.type === 'fire').length, 0);
  r = resolveTurn(r.state, []);
  assert.equal(r.events.filter((e) => e.type === 'fire').length, 0, 'still holding after arriving');
  r.state.contacts.BLUFOR[1] = { level: 'spotted', pos: { x: 20, y: 5 }, lastSeenSec: 0 };
  r = resolveTurn(r.state, [B('ALPHA', 'fire', { target: 1 })]);
  assert.ok(r.events.some((e) => e.type === 'fire' && e.id === 0));
});
