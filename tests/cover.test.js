import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverFrom, directionTo } from '../src/sim/cover.js';
import { parseMap } from '../src/sim/map.js';
import { LEGEND, balance, grass, makeMap } from './helpers.js';

const P = (x, y) => ({ x, y });
const hard = balance.cover.protection.hard;

// 21 x 21 grass with a low wall on the tile north of the center (10,10).
function wallNorth() {
  const rows = grass(21, 21);
  rows[9] = '.'.repeat(10) + '-' + '.'.repeat(10);
  return makeMap(rows);
}

test('directions snap to the nearest of 8', () => {
  assert.equal(directionTo(P(10, 10), P(10, 0)).name, 'north');
  assert.equal(directionTo(P(10, 10), P(20, 11)).name, 'east');
  assert.equal(directionTo(P(10, 10), P(20, 20)).name, 'south-east');
  assert.equal(directionTo(P(10, 10), P(0, 18)).name, 'south-west');
});

test('behind a low wall: protected from the wall side, exposed from every other side', () => {
  const map = wallNorth();
  const target = { pos: P(10, 10), stance: 'crouch' };
  const front = coverFrom(map, balance, target, P(10, 0));
  assert.equal(front.source, 'neighbor');
  assert.deepEqual({ x: front.tile.x, y: front.tile.y }, P(10, 9));
  assert.equal(front.protection, hard * balance.cover.lowCoverStance.crouch);
  for (const from of [P(20, 10), P(0, 10), P(10, 20), P(20, 20), P(0, 20)]) {
    assert.equal(coverFrom(map, balance, target, from).protection, 0, `from ${from.x},${from.y}`);
  }
});

test('stance scales low cover: prone gets the most, standing almost none', () => {
  const map = wallNorth();
  const p = (stance) => coverFrom(map, balance, { pos: P(10, 10), stance }, P(10, 0)).protection;
  assert.ok(p('prone') > p('crouch'));
  assert.ok(p('crouch') > p('stand'));
  assert.ok(p('stand') <= hard * 0.3 + 1e-9);
});

test('a full-height wall protects at any stance', () => {
  const rows = grass(5, 5);
  rows[1] = '..#..';
  const map = makeMap(rows);
  for (const stance of ['stand', 'crouch', 'prone']) {
    assert.equal(coverFrom(map, balance, { pos: P(2, 2), stance }, P(2, 0)).protection, hard);
  }
});

test('cover on the soldier\'s own tile protects from every direction', () => {
  const map = parseMap({
    width: 5, height: 5, rows: grass(5, 5).map((r, y) => (y === 2 ? '..R..' : r)),
    legend: { ...LEGEND, R: { terrain: 'rubble', cover: 'heavy', concealment: 'partial' } },
  });
  const target = { pos: P(2, 2), stance: 'prone' };
  for (const from of [P(2, 0), P(4, 2), P(0, 4)]) {
    const c = coverFrom(map, balance, target, from);
    assert.equal(c.source, 'own');
    assert.equal(c.protection, balance.cover.protection.heavy);
  }
});

test('the better of neighbor and own-tile cover counts', () => {
  const map = parseMap({
    width: 5, height: 5, rows: ['.....', '..-..', '..T..', '.....', '.....'],
    legend: LEGEND,
  });
  const target = { pos: P(2, 2), stance: 'prone' };
  assert.equal(coverFrom(map, balance, target, P(2, 0)).source, 'neighbor'); // low wall (hard) beats trees (light)
  assert.equal(coverFrom(map, balance, target, P(4, 2)).source, 'own');      // only the trees from the east
});

test('a shooter standing on the cover tile itself is past it', () => {
  const map = wallNorth();
  assert.equal(coverFrom(map, balance, { pos: P(10, 10), stance: 'crouch' }, P(10, 9)).protection, 0);
});
