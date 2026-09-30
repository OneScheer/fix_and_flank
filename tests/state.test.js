import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, ticksPerTurn } from '../src/sim/state.js';

const balance = JSON.parse(readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'));

test('default turn is 10 s in 0.5 s ticks = 20 ticks', () => {
  assert.equal(ticksPerTurn(balance), 20);
});

test('tick length is configurable', () => {
  assert.equal(ticksPerTurn({ turn: { durationSec: 10, tickSec: 0.25 } }), 40);
});

test('turn length must divide evenly into ticks', () => {
  assert.throws(() => ticksPerTurn({ turn: { durationSec: 10, tickSec: 3 } }));
});

test('createState starts at turn 0 with the given seed', () => {
  const s = createState({ balance, seed: 7 });
  assert.equal(s.turn, 0);
  assert.equal(s.tick, 0);
  assert.equal(s.seed, 7);
  assert.equal(s.ticksPerTurn, 20);
});
