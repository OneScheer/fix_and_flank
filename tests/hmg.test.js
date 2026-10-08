// The HMG team: a third element for the BLUFOR squad (balance.unitTypes.hmg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveOptions, validateAction } from '../src/sim/actions.js';
import { fireDice, fireSolution } from '../src/sim/combat.js';
import { applyAction } from '../src/sim/actions.js';
import { commitOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { mayFire, unitType } from '../src/sim/state.js';
import { H, balance, makeState, open, toPhase, unit } from './helpers.js';

const hmg = (col, row, extra = {}) => unit('BLUFOR', 'HMG', col, row, { type: 'hmg', ...extra });

test('an HMG team is a crew of three that rolls six dice', () => {
  const s = makeState(open(4, 4), [hmg(0, 0), unit('OPFOR', 'ALPHA', 3, 3)]);
  assert.deepEqual(s.units[0].soldiers, ['GNR', 'AG', 'AMMO']);
  assert.equal(fireDice(balance, s.units[0]), 6);
  assert.equal(unitType(balance, s.units[0]).name, 'HMG team');
});

test('it reaches further: no range penalty to 6 hexes, +1 to 12, nothing beyond', () => {
  // HMG on row 0, a rifle team on row 1 at the same column; targets are row 0 and row 1 hexes the same distance away.
  const s = makeState(open(16, 2), [hmg(0, 0), unit('BLUFOR', 'ALPHA', 0, 1), unit('OPFOR', 'ALPHA', 15, 0)]);
  const shot = (u, col) => fireSolution(s, s.units[u], H(col, u === 0 ? 0 : 1));
  assert.equal(shot(0, 6).mods.some((m) => m.why.startsWith('range')), false, 'HMG at 6 hexes');
  assert.equal(shot(1, 6).mods.find((m) => m.why.startsWith('range')).mod, 1, 'a rifle team at 6 hexes');
  assert.equal(shot(0, 12).mods.find((m) => m.why.startsWith('range')).mod, 1);
  assert.match(shot(0, 13).reason, /out of range \(12 hexes\)/);
  assert.match(shot(1, 11).reason, /out of range \(10 hexes\)/);
});

test('it moves only one hex at a time, and never assaults', () => {
  const s = makeState(open(6, 6), [hmg(2, 4), unit('OPFOR', 'ALPHA', 2, 3)]);
  assert.match(validateAction(s, { type: 'fastMove', unit: 0, path: [H(1, 4), H(0, 4)] }).reason, /HMG team cannot fast move/);
  const o = moveOptions(s, s.units[0]);
  assert.ok(o.moves.length > 0, 'it can still move');
  assert.equal(o.fast.size, 0);
  assert.match(validateAction(s, { type: 'move', unit: 0, to: H(2, 3) }).reason, /HMG team does not assault/);
});

test('its crew is lost ammo bearer first, gunner last', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const s = toPhase(makeState(open(8, 4), [unit('OPFOR', 'ALPHA', 0, 1), hmg(4, 1)]), 'enemy action');
    const r = applyAction(s, { type: 'fire', unit: 0, target: H(4, 1) }, createRng(seed));
    const lost = r.events.find((e) => e.type === 'fire').lost;
    if (lost.length >= 2) {
      assert.deepEqual(lost.slice(0, 2), ['AMMO', 'AG']);
      return;
    }
  }
  assert.fail('never lost two');
});

test('it fires only every other turn', () => {
  let s = toPhase(makeState(open(10, 4), [hmg(1, 1), unit('OPFOR', 'ALPHA', 8, 1)]), 'firefight');
  assert.equal(s.turn, 1);
  s = applyAction(s, { type: 'fire', unit: 0, target: H(8, 1) }, createRng(1)).state;
  while (s.turn === 1) s = commitOrders(s, [], createRng(s.rngState)).state;
  assert.equal(s.turn, 2);
  assert.equal(s.units[0].reload, 1, 'turn 2: still reloading');
  assert.match(mayFire(s.units[0]).reason, /reloading/);
  const next = toPhase(s, 'firefight');
  assert.equal(next.turn, 3, 'turn 2 has no firefight for it; turn 3 does');
  assert.equal(validateAction(next, { type: 'fire', unit: 0, target: H(8, 1) }).ok, true);
});

test('a rifle team can fire every turn', () => {
  let s = toPhase(makeState(open(10, 4), [unit('BLUFOR', 'ALPHA', 1, 1), unit('OPFOR', 'ALPHA', 8, 1)]), 'firefight');
  s = applyAction(s, { type: 'fire', unit: 0, target: H(8, 1) }, createRng(1)).state;
  s = toPhase(s, 'firefight');
  assert.equal(validateAction(s, { type: 'fire', unit: 0, target: H(8, 1) }).ok, true);
});
