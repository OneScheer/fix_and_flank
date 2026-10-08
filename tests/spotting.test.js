// Hex milestone 3 acceptance: the spotting rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction } from '../src/sim/actions.js';
import { commitOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { knownEnemies } from '../src/sim/spotting.js';
import { H, makeState, open, toPhase, trainingState, unit } from './helpers.js';

const act = (s, a) => applyAction(s, a, createRng(s.rngState));
const commit = (s, actions) => commitOrders(s, actions, createRng(s.rngState));
const contact = (s, side, id) => s.contacts[side][id] ?? null;

test('an enemy in the open, in line of sight, is spotted from the start', () => {
  const s = makeState(open(8, 3), [unit('BLUFOR', 'ALPHA', 0, 1), unit('OPFOR', 'ALPHA', 7, 1)]);
  assert.equal(contact(s, 'BLUFOR', 1).level, 'spotted');
  assert.equal(contact(s, 'OPFOR', 0).level, 'spotted', 'same rules for OPFOR');
});

test('an enemy in concealing terrain is not spotted at range', () => {
  for (const c of ['T', ':', 'n', 'B', '%']) {
    const s = makeState([`.......${c}`], [unit('BLUFOR', 'ALPHA', 0, 0), unit('OPFOR', 'ALPHA', 7, 0)]);
    assert.equal(contact(s, 'BLUFOR', 1), null, c);
  }
});

test('...but it is when adjacent', () => {
  const s = makeState(['..T.'], [unit('BLUFOR', 'ALPHA', 1, 0), unit('OPFOR', 'ALPHA', 2, 0)]);
  const c = contact(s, 'BLUFOR', 1);
  assert.equal(c.level, 'spotted');
});

test('no line of sight, no contact, even in the open', () => {
  const s = makeState(['...T....'], [unit('BLUFOR', 'ALPHA', 0, 0), unit('OPFOR', 'ALPHA', 7, 0)]);
  assert.equal(contact(s, 'BLUFOR', 1), null);
});

test('fast moving into concealment: spotted while exposed; walking in: not', () => {
  const rows = ['........', '........', '........', '....:...', '........', '........', '........'];
  const units = [unit('BLUFOR', 'ALPHA', 4, 5), unit('OPFOR', 'ALPHA', 4, 0)];
  const walked = act(makeState(rows, units), { type: 'move', unit: 0, to: H(4, 4) }).state;
  const walkedIn = commit(walked, []).state; // next turn
  const careful = act(walkedIn, { type: 'move', unit: 0, to: H(4, 3) }).state; // into the scrub, walking
  assert.equal(contact(careful, 'OPFOR', 0).level, 'suspected', 'walked into the scrub: lost from view');
  const fast = act(makeState(rows, units), { type: 'fastMove', unit: 0, path: [H(4, 4), H(4, 3)] }).state;
  const c = contact(fast, 'OPFOR', 0);
  assert.equal(c.level, 'spotted', 'fast moved into the scrub: exposed, still seen');
});

test('a fired unit is spotted in concealment (the fire flag is set by milestone 4)', () => {
  const s = makeState(['.......T'], [unit('BLUFOR', 'ALPHA', 0, 0), unit('OPFOR', 'ALPHA', 7, 0)]);
  assert.equal(contact(s, 'BLUFOR', 1), null);
  s.units[1].fired = true;
  const r = act(s, { type: 'pass', unit: 0 });
  assert.equal(contact(r.state, 'BLUFOR', 1).level, 'spotted');
  assert.equal(r.events.find((e) => e.type === 'spotted').why, 'firing');
});

// One row: OPFOR in the open at 4,0 steps into the woods at 5,0.
const ROW = ['.....T..'];

test('losing sight: spotted becomes suspected at the last known hex', () => {
  let s = makeState(ROW, [unit('BLUFOR', 'ALPHA', 1, 0), unit('OPFOR', 'ALPHA', 4, 0)]);
  assert.equal(contact(s, 'BLUFOR', 1).level, 'spotted');
  s = toPhase(s, 'enemy action');
  const r = act(s, { type: 'move', unit: 1, to: H(5, 0) });
  const c = contact(r.state, 'BLUFOR', 1);
  assert.equal(c.level, 'suspected');
  assert.deepEqual(c.pos, H(4, 0), 'where it was last seen, not where it is');
  assert.ok(r.events.some((e) => e.type === 'lost' && e.side === 'BLUFOR'));
});

test('a suspected hex is cleared when a unit gets close enough to see it is empty', () => {
  let s = makeState(ROW, [unit('BLUFOR', 'ALPHA', 1, 0), unit('OPFOR', 'ALPHA', 4, 0)]);
  s = toPhase(s, 'enemy action');
  s = act(s, { type: 'move', unit: 1, to: H(5, 0) }).state; // suspected at 4,0; now turn 2
  const r = act(s, { type: 'fastMove', unit: 0, path: [H(2, 0), H(3, 0)] }); // next to 4,0
  assert.equal(contact(r.state, 'BLUFOR', 1), null);
  assert.equal(r.events.find((e) => e.type === 'contact_dropped').why, 'hex is clear');
});

test('a suspected contact nobody checks is dropped after a few turns', () => {
  let s = makeState(ROW, [unit('BLUFOR', 'ALPHA', 1, 0), unit('OPFOR', 'ALPHA', 4, 0)]);
  s = toPhase(s, 'enemy action');
  s = act(s, { type: 'move', unit: 1, to: H(5, 0) }).state;
  let dropped = null;
  for (let i = 0; i < 12 && !dropped; i++) {
    const r = commit(s, []);
    s = r.state;
    dropped = r.events.find((e) => e.type === 'contact_dropped');
  }
  assert.equal(dropped?.why, 'old');
});

test('on the training map BLUFOR starts without contact; OPFOR sees the squad in the open', () => {
  const s = trainingState();
  assert.deepEqual(knownEnemies(s, 'BLUFOR'), []);
  assert.equal(knownEnemies(s, 'OPFOR').filter((c) => c.level === 'spotted').length, 3);
});

test('closing in on the dug-in team: spotted once adjacent', () => {
  const s = makeState(['...n...', '.......', '.......'], [unit('BLUFOR', 'ALPHA', 3, 2), unit('OPFOR', 'ALPHA', 3, 0)]);
  assert.equal(contact(s, 'BLUFOR', 1), null);
  const r = act(s, { type: 'move', unit: 0, to: H(3, 1) });
  assert.equal(contact(r.state, 'BLUFOR', 1).level, 'spotted');
  assert.equal(r.events.find((e) => e.type === 'spotted').why, 'close by');
});

test('contacts replay identically', () => {
  const play = () => {
    let s = trainingState(5);
    const log = [];
    for (const plan of [[{ type: 'fastMove', unit: 0, path: [H(4, 10), H(4, 9)] }], [], [], [{ type: 'move', unit: 1, to: H(6, 10) }], [], []]) {
      const r = commit(s, plan);
      s = r.state;
      log.push(r.events);
    }
    return { contacts: s.contacts, log };
  };
  assert.deepEqual(play(), play());
});
