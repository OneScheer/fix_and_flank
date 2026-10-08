import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/sim/rng.js';

test('same seed gives the same sequence', () => {
  const a = createRng(1234);
  const b = createRng(1234);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('different seeds diverge', () => {
  assert.notEqual(createRng(1).next(), createRng(2).next());
});

test('values stay in [0, 1) and int stays in range', () => {
  const r = createRng(99);
  for (let i = 0; i < 1000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
    const n = r.int(3, 6);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 6);
  }
});
