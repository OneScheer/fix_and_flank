import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from '../src/sim/path.js';
import { balance, grass, makeMap } from './helpers.js';

const movement = balance.movement;
const P = (x, y) => ({ x, y });

test('straight path on open ground', () => {
  const r = findPath(makeMap(grass(6, 1)), movement, P(0, 0), P(5, 0));
  assert.deepEqual(r.path, [P(1, 0), P(2, 0), P(3, 0), P(4, 0), P(5, 0)]);
  assert.equal(r.cost, 5);
});

test('same start and goal gives an empty path', () => {
  assert.deepEqual(findPath(makeMap(grass(3, 3)), movement, P(1, 1), P(1, 1)), { path: [], cost: 0 });
});

test('routes through the door of a walled building', () => {
  const map = makeMap([
    '.......',
    '.#####.',
    '.#...#.',
    '.##D##.',
    '.......',
  ]);
  const r = findPath(map, movement, P(3, 4), P(3, 2));
  assert.deepEqual(r.path, [P(3, 3), P(3, 2)]);
  const around = findPath(map, movement, P(3, 0), P(3, 2));
  assert.ok(around.path.some((p) => p.x === 3 && p.y === 3), 'path from the north must use the south door');
});

test('unreachable or impassable goals return null', () => {
  const map = makeMap([
    '#####',
    '#...#',
    '#####',
    '.....',
  ]);
  assert.equal(findPath(map, movement, P(0, 3), P(2, 1)), null);
  assert.equal(findPath(map, movement, P(0, 3), P(0, 0)), null);
});

test('prefers a longer road over a short forest crossing when it is cheaper', () => {
  const map = makeMap([
    '.......',
    '.TTTTT.',
    '.......',
  ]);
  const r = findPath(map, movement, P(0, 1), P(6, 1));
  assert.ok(r.path.every((p) => p.y !== 1 || p.x === 6), 'should go around the forest');
});

test('paths are identical across runs', () => {
  const map = makeMap(grass(20, 20));
  const a = findPath(map, movement, P(0, 0), P(19, 7));
  const b = findPath(map, movement, P(0, 0), P(19, 7));
  assert.deepEqual(a, b);
});
