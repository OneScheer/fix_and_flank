import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAlong } from '../src/ui/anim.js';

const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4 }];

test('interpolates along the path', () => {
  assert.deepEqual(positionAlong(pts, 0.5), { x: 1, y: 0 });
  assert.deepEqual(positionAlong(pts, 1.5), { x: 2, y: 2 });
});

// Regression: a frame timestamp earlier than the confirm time gave t < 0,
// read points[-1] and stopped the drawing loop, so every counter vanished.
test('a slightly negative or overshooting time is clamped to the path', () => {
  assert.deepEqual(positionAlong(pts, -0.02), { x: 0, y: 0 });
  assert.deepEqual(positionAlong(pts, 7), { x: 2, y: 4 });
  assert.deepEqual(positionAlong([{ x: 3, y: 3 }], 0.4), { x: 3, y: 3 });
});
