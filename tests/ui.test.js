import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOrders } from '../src/sim/orders.js';
import { resolveTurn } from '../src/sim/step.js';
import { buildFrames, contactsAt, positionAt } from '../src/ui/playback.js';
import { previewLines, remainingMoveSec } from '../src/ui/preview.js';
import { grass, holdFire, makeState, trainingState } from './helpers.js';

const move = (side, team, x, y, speed = 'walk') => ({ type: 'move', side, team, dest: { x, y }, speed });

test('playback frames start at the old positions and end at the new state', () => {
  const s = trainingState();
  const orders = [move('BLUFOR', 'ALPHA', 30, 50, 'run'), move('BLUFOR', 'BRAVO', 60, 60)];
  const { state, events } = resolveTurn(s, orders);
  const frames = buildFrames(s.soldiers, events, s.ticksPerTurn);
  assert.equal(frames.length, s.ticksPerTurn + 1);
  for (const soldier of s.soldiers) {
    assert.deepEqual(positionAt(frames, soldier.id, 0), soldier.pos);
    assert.deepEqual(positionAt(frames, soldier.id, s.ticksPerTurn), state.soldiers[soldier.id].pos);
  }
});

test('playback interpolates between ticks', () => {
  const s = makeState(grass(30, 1), [{ side: 'BLUFOR', team: 'ALPHA', role: 'TL', pos: [0, 0] }]);
  const { events } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 29, 0, 'run')]);
  const frames = buildFrames(s.soldiers, events, s.ticksPerTurn);
  const a = positionAt(frames, 0, 3);
  const b = positionAt(frames, 0, 4);
  const mid = positionAt(frames, 0, 3.5);
  assert.equal(mid.x, (a.x + b.x) / 2);
});

test('preview says whether the team arrives this turn, and the sim agrees', () => {
  const units = [{ side: 'BLUFOR', team: 'ALPHA', role: 'TL', pos: [0, 0] }];
  const s = makeState(grass(40, 1), units);
  for (const [x, arrivesNow] of [[5, true], [30, false]]) {
    const orders = [move('BLUFOR', 'ALPHA', x, 0, 'walk')];
    const [line] = previewLines(s, 'BLUFOR', planOrders(s, orders));
    assert.equal(line.text.includes('arrives this turn'), arrivesNow, line.text);
    const { state } = resolveTurn(s, orders);
    assert.equal(state.soldiers[0].move === null, arrivesNow);
  }
});

test('preview reports soldiers that cannot move', () => {
  const rows = ['......###...', '......#.#...', '......###...'];
  // RFL is boxed in by high walls; its formation slot (11,1) is outside the box.
  const units = [
    { side: 'BLUFOR', team: 'ALPHA', role: 'TL', pos: [0, 1] },
    { side: 'BLUFOR', team: 'ALPHA', role: 'RFL', pos: [7, 1] },
  ];
  const s = makeState(rows, units);
  const [line] = previewLines(s, 'BLUFOR', planOrders(s, [move('BLUFOR', 'ALPHA', 4, 1)]));
  assert.ok(line.notes.some((n) => n.startsWith('RFL will not move')), JSON.stringify(line));
});

test('remaining time on a move in progress counts down', () => {
  const s = makeState(grass(60, 1), [{ side: 'BLUFOR', team: 'ALPHA', role: 'TL', pos: [0, 0] }]);
  const { state } = resolveTurn(s, [move('BLUFOR', 'ALPHA', 40, 0, 'walk')]);
  const [plan] = planOrders(s, [move('BLUFOR', 'ALPHA', 40, 0, 'walk')]);
  const left = remainingMoveSec(state, state.soldiers[0]);
  assert.ok(Math.abs(left - (plan.soldiers[0].etaSec - s.balance.turn.durationSec)) < 1e-6);
  const [line] = previewLines(state, 'BLUFOR', []);
  assert.match(line.text, /continuing walk to 40,0/);
});

test('playback contact timeline ends where the sim ends', () => {
  const rows = ['..............', '...........#..', '..............'];
  const units = [
    { side: 'BLUFOR', team: 'ALPHA', role: 'TL', pos: [0, 1] },
    { side: 'OPFOR', team: 'ALPHA', role: 'TL', pos: [2, 1] },
  ];
  const s0 = holdFire(makeState(rows, units));
  const t1 = resolveTurn(s0, []);
  assert.equal(contactsAt(s0.contacts.BLUFOR, t1.events, 'BLUFOR', 0).size, 0, 'nothing known before the first tick');
  assert.equal(contactsAt(s0.contacts.BLUFOR, t1.events, 'BLUFOR', s0.ticksPerTurn).get(1).level, 'spotted');
  const t2 = resolveTurn(t1.state, [move('OPFOR', 'ALPHA', 13, 1, 'run')]);
  const end = contactsAt(t1.state.contacts.BLUFOR, t2.events, 'BLUFOR', s0.ticksPerTurn);
  assert.deepEqual(end.get(1), { level: t2.state.contacts.BLUFOR[1].level, pos: t2.state.contacts.BLUFOR[1].pos });
  assert.equal(end.get(1).level, 'suspected');
});
