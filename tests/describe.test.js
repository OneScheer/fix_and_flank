import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOrders } from '../src/ai/basic.js';
import { applyAction } from '../src/sim/actions.js';
import { createRng } from '../src/sim/rng.js';
import { eventText, passText, previewAction } from '../src/ui/describe.js';
import { H, makeState, open, unit } from './helpers.js';

function squad() {
  return makeState(open(8, 8), [
    unit('BLUFOR', 'SL', 3, 6, { kind: 'leader' }), unit('BLUFOR', 'ALPHA', 3, 5), unit('OPFOR', 'ALPHA', 3, 0),
  ]);
}

test('previews say what will happen, with the odds for dice', () => {
  const s = squad();
  assert.match(previewAction(s, { type: 'move', unit: 1, to: H(3, 4) }), /ALPHA moves 1 hex to 3,4 \(open\)/);
  assert.match(previewAction(s, { type: 'fastMove', unit: 1, path: [H(3, 4), H(3, 3)] }), /fast moves 2 hexes .* Exposed until its next activation/);
  s.units[1].status = 'pinned';
  assert.equal(previewAction(s, { type: 'rally', unit: 0, target: 1 }),
    'SL rallies ALPHA (pinned): needs 3+ on a d6, 4 in 6 (67%). Success: ALPHA becomes suppressed.');
  assert.match(previewAction(s, { type: 'move', unit: 1, to: H(3, 4) }), /cannot do that, ALPHA is pinned and cannot move/);
});

test('log lines report the dice', () => {
  const s = squad();
  s.units[1].status = 'pinned';
  const r = applyAction(s, { type: 'rally', unit: 0, target: 1 }, createRng(4));
  const e = r.events.find((x) => x.type === 'rally');
  assert.match(eventText(r.state, e), new RegExp(`rallies ALPHA: rolled ${e.roll} \\(needed 3\\+\\)`));
});

test('the placeholder OPFOR gives no orders: all its units hold', () => {
  assert.deepEqual(chooseOrders(squad(), 'OPFOR'), []);
});

test('the log only tells BLUFOR what it knows', () => {
  // OPFOR in a trench, unseen: its hold and its moves stay out of BLUFOR's log.
  let s = makeState(['...nn..', '.......', '.......', '.......', '.......'], [
    unit('BLUFOR', 'ALPHA', 3, 4), unit('OPFOR', 'ALPHA', 3, 0),
  ]);
  s = applyAction(s, { type: 'pass', unit: 0 }, createRng(1)).state;
  const r = applyAction(s, { type: 'move', unit: 1, to: H(4, 0) }, createRng(1));
  for (const e of r.events) {
    const line = eventText(r.state, e, 'BLUFOR') ?? '';
    assert.ok(!/OPFOR ALPHA moves/.test(line), line);
  }
  assert.equal(passText(s, { type: 'activated', action: 'pass', unit: 1 }, 'BLUFOR'), null);
});

test('the move preview warns when the destination is in view of a known enemy', () => {
  const s = makeState(open(8, 6), [unit('BLUFOR', 'ALPHA', 3, 5), unit('OPFOR', 'ALPHA', 3, 0)]);
  assert.match(previewAction(s, { type: 'move', unit: 0, to: H(3, 4) }), /Ends in view of enemy at 3,0: will be seen/);
  const hidden = makeState(['........', '........', '........', '...:....', '........', '........'], [unit('BLUFOR', 'ALPHA', 3, 4), unit('OPFOR', 'ALPHA', 3, 0)]);
  assert.match(previewAction(hidden, { type: 'move', unit: 0, to: H(3, 3) }), /concealed: seen only if one is adjacent/);
});
