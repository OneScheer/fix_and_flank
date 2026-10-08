import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacent, center, distance, fromCube, hexAt, key, line, neighbors, toCube } from '../src/sim/hex.js';
import { H } from './helpers.js';

test('offset <-> cube round trip', () => {
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 10; col++) {
      const c = toCube(H(col, row));
      assert.equal(c.x + c.y + c.z, 0);
      assert.deepEqual(fromCube(c), H(col, row));
    }
  }
});

test('six neighbors, each at distance 1, on even and odd rows', () => {
  for (const h of [H(4, 4), H(4, 5)]) {
    const n = neighbors(h);
    assert.equal(n.length, 6);
    assert.equal(new Set(n.map(key)).size, 6);
    for (const x of n) assert.equal(distance(h, x), 1);
  }
  // odd-r: on an odd row the upper neighbors are shifted right
  assert.deepEqual(neighbors(H(4, 5)).map(key).sort(), ['3,5', '4,4', '4,6', '5,4', '5,5', '5,6']);
  assert.deepEqual(neighbors(H(4, 4)).map(key).sort(), ['3,3', '3,4', '3,5', '4,3', '4,5', '5,4']);
});

test('distance', () => {
  assert.equal(distance(H(0, 0), H(0, 0)), 0);
  assert.equal(distance(H(0, 0), H(5, 0)), 5);
  assert.equal(distance(H(0, 0), H(0, 4)), 4);
  assert.equal(distance(H(2, 2), H(5, 9)), 7);
  assert.ok(adjacent(H(4, 5), H(5, 4)));
  assert.ok(!adjacent(H(4, 4), H(5, 3)));
});

test('a line runs through adjacent hexes from end to end', () => {
  for (const [a, b] of [[H(0, 0), H(7, 5)], [H(6, 9), H(1, 0)], [H(3, 3), H(3, 3)]]) {
    const l = line(a, b);
    assert.deepEqual(l[0], a);
    assert.deepEqual(l[l.length - 1], b);
    assert.equal(l.length, distance(a, b) + 1);
    for (let i = 1; i < l.length; i++) assert.ok(adjacent(l[i - 1], l[i]));
  }
});

test('pixel center and back', () => {
  for (const h of [H(0, 0), H(3, 1), H(7, 6), H(11, 11)]) {
    assert.deepEqual(hexAt(center(h)), h);
    const c = center(h);
    assert.deepEqual(hexAt({ x: c.x + 0.4, y: c.y - 0.4 }), h, 'near the center still the same hex');
  }
});
