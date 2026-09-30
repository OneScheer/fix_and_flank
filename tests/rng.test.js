import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/sim/rng.js';

function take(rng, n) {
  return Array.from({ length: n }, () => rng.next());
}

test('same seed gives the same sequence', () => {
  assert.deepEqual(take(createRng(42), 100), take(createRng(42), 100));
});

test('different seeds give different sequences', () => {
  assert.notDeepEqual(take(createRng(1), 10), take(createRng(2), 10));
});

test('known values for seed 0 (guards against accidental algorithm changes)', () => {
  const rng = createRng(0);
  const values = take(rng, 3).map((v) => Math.round(v * 1e9));
  assert.deepEqual(values, KNOWN_SEED0);
});

test('next() stays in [0, 1)', () => {
  const rng = createRng(123);
  for (let i = 0; i < 10000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('int(n) stays in [0, n) and covers every value', () => {
  const rng = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const v = rng.int(6);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 6);
    seen.add(v);
  }
  assert.equal(seen.size, 6);
});

test('int(n) rejects bad input', () => {
  const rng = createRng(1);
  assert.throws(() => rng.int(0), RangeError);
  assert.throws(() => rng.int(2.5), RangeError);
});

test('state can be saved and restored for replay', () => {
  const rng = createRng(99);
  take(rng, 5);
  const saved = rng.getState();
  const a = take(rng, 20);
  rng.setState(saved);
  assert.deepEqual(take(rng, 20), a);
});

test('distribution is roughly uniform', () => {
  const rng = createRng(2024);
  const n = 100000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rng.next();
  assert.ok(Math.abs(sum / n - 0.5) < 0.01);
});

// Reference mulberry32 output for seed 0, scaled by 1e9 and rounded.
const KNOWN_SEED0 = [266429209, 329746, 223272027];
