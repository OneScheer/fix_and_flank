import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrders, formationSlots, planOrders, validateOrder } from '../src/sim/orders.js';
import { cloneState } from '../src/sim/state.js';
import { grass, makeState } from './helpers.js';

const unit = (side, team, role, x, y) => ({ side, team, role, pos: [x, y] });
// ALPHA starts in its wedge facing north (spacing 2): AR back-left, RFL back-right.
const squad = [
  unit('BLUFOR', 'ALPHA', 'TL', 5, 15),
  unit('BLUFOR', 'ALPHA', 'AR', 3, 17),
  unit('BLUFOR', 'ALPHA', 'RFL', 7, 17),
  unit('BLUFOR', 'BRAVO', 'TL', 10, 15),
  unit('OPFOR', 'ALPHA', 'TL', 10, 2),
];
const s0 = () => makeState(grass(5, 5));
const move = (team, x, y, speed = 'walk', side = 'BLUFOR') => ({ type: 'move', side, team, dest: { x, y }, speed });

test('validation catches bad orders', () => {
  const s = makeState([...grass(20, 19), '~'.repeat(20)], squad);
  assert.equal(validateOrder(s, move('ALPHA', 5, 5)).ok, true);
  assert.match(validateOrder(s, move('ALPHA', 50, 5)).reason, /off the map/);
  assert.match(validateOrder(s, move('ALPHA', 5, 19)).reason, /impassable/);
  assert.match(validateOrder(s, move('ALPHA', 5, 5, 'sprint')).reason, /unknown speed/);
  assert.match(validateOrder(s, move('CHARLIE', 5, 5)).reason, /no soldiers/);
  assert.match(validateOrder(s, { type: 'dance', side: 'BLUFOR', team: 'ALPHA' }).reason, /unknown order type/);
});

test('the team forms a wedge on the destination, facing the direction of travel', () => {
  const s = makeState(grass(30, 30), squad);
  const north = planOrders(s, [move('ALPHA', 5, 5)])[0];
  assert.deepEqual(north.soldiers.map((p) => p.dest), [{ x: 5, y: 5 }, { x: 3, y: 7 }, { x: 7, y: 7 }]);
  // Moving east the wedge turns: "back" is now west, "left" is north.
  const east = planOrders(s, [move('ALPHA', 25, 15)])[0];
  assert.deepEqual(east.soldiers.map((p) => p.dest), [{ x: 25, y: 15 }, { x: 23, y: 13 }, { x: 23, y: 17 }]);
});

test('formation slots turn with the facing and stay on the grid', () => {
  const f = s0().balance.movement.formation;
  const slots = formationSlots(f, 4, { x: Math.SQRT1_2, y: -Math.SQRT1_2 }); // north-east
  assert.deepEqual(slots[0], { x: 0, y: 0 });
  for (const p of slots) assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
  assert.equal(new Set(slots.map((p) => `${p.x},${p.y}`)).size, 4);
});

test('a soldier who fell behind rejoins his slot on the next order', () => {
  // AR lags far behind the TL; the next move puts him back in the wedge.
  const lagging = [
    unit('BLUFOR', 'ALPHA', 'TL', 5, 10),
    unit('BLUFOR', 'ALPHA', 'AR', 3, 25),
    unit('BLUFOR', 'ALPHA', 'RFL', 7, 12),
  ];
  const s = makeState(grass(30, 30), lagging);
  const [plan] = planOrders(s, [move('ALPHA', 5, 3)]);
  assert.deepEqual(plan.soldiers.find((p) => p.id === 1).dest, { x: 3, y: 5 });
  assert.ok(plan.soldiers.find((p) => p.id === 1).path, 'AR has a route to his slot');
});

test('on open ground followers in their slots take the leader route shifted over', () => {
  const s = makeState(grass(20, 20), squad);
  const [plan] = planOrders(s, [move('ALPHA', 5, 4)]);
  const [lead, ...rest] = plan.soldiers;
  for (const p of rest) {
    const dx = s.soldiers[p.id].pos.x - s.soldiers[lead.id].pos.x;
    const dy = s.soldiers[p.id].pos.y - s.soldiers[lead.id].pos.y;
    assert.deepEqual(p.path, lead.path.map((q) => ({ x: q.x + dx, y: q.y + dy })));
  }
});

test('a follower whose shifted route hits a wall finds its own way', () => {
  const rows = grass(20, 20);
  rows[10] = '...#' + '.'.repeat(16); // wall at 3,10: on AR's shifted route (TL walks column 5)
  const s = makeState(rows, squad);
  const [plan] = planOrders(s, [move('ALPHA', 5, 3)]);
  const ar = plan.soldiers.find((p) => s.soldiers[p.id].role === 'AR');
  assert.ok(ar.path, 'AR still has a route');
  assert.ok(ar.path.every((q) => !(q.x === 3 && q.y === 10)));
});

test('formation slots on impassable or taken tiles shift to the nearest free tile', () => {
  const rows = grass(20, 20);
  rows[7] = '...~' + '.'.repeat(16); // AR's slot for dest (5,5) is 3,7: water
  const s = makeState(rows, squad);
  const [plan] = planOrders(s, [move('ALPHA', 5, 5)]);
  const dests = plan.soldiers.map((p) => `${p.dest.x},${p.dest.y}`);
  assert.equal(new Set(dests).size, 3, 'no two soldiers share a destination');
  assert.ok(!dests.includes('3,7'));
});

test('destinations avoid own soldiers that are not moving', () => {
  const s = makeState(grass(20, 20), squad);
  const [plan] = planOrders(s, [move('ALPHA', 10, 15)]); // BRAVO TL stands on 10,15
  assert.notDeepEqual(plan.soldiers[0].dest, { x: 10, y: 15 });
});

test('a later order for the same team replaces the earlier one', () => {
  const s = makeState(grass(20, 20), squad);
  const plans = planOrders(s, [move('ALPHA', 5, 5), move('ALPHA', 8, 8)]);
  assert.equal(plans[0].ok, false);
  assert.equal(plans[1].ok, true);
});

test('eta follows path cost and speed', () => {
  const s = makeState(grass(20, 20), squad);
  const [walk] = planOrders(s, [move('BRAVO', 10, 5, 'walk')]);
  const [run] = planOrders(s, [move('BRAVO', 10, 5, 'run')]);
  const tilesPerSec = (mps) => mps / s.balance.map.tileMeters;
  assert.equal(walk.soldiers[0].etaSec, 10 / tilesPerSec(s.balance.movement.speedMps.walk));
  assert.ok(run.soldiers[0].etaSec < walk.soldiers[0].etaSec);
});

test('applied paths are exactly the previewed paths', () => {
  const s = makeState(grass(20, 20), squad);
  const orders = [move('ALPHA', 5, 3, 'run'), move('BRAVO', 15, 2, 'crawl')];
  const preview = planOrders(s, orders);
  const next = cloneState(s);
  applyOrders(next, orders, []);
  for (const plan of preview) {
    for (const p of plan.soldiers) {
      assert.deepEqual(next.soldiers[p.id].move.path, p.path);
      assert.equal(next.soldiers[p.id].stance, s.balance.movement.stanceForSpeed[plan.order.speed]);
    }
  }
});

test('waypoints force the route through a forest the pathfinder would avoid', () => {
  const rows = [
    '..........',
    '.TTTTTTTT.',
    '..........',
  ];
  const units = [{ side: 'BLUFOR', team: 'ALPHA', role: 'TL', pos: [0, 1] }];
  const s = makeState(rows, units);
  const direct = planOrders(s, [move('ALPHA', 9, 1)])[0].soldiers[0].path;
  assert.ok(!direct.some((p) => p.y === 1 && p.x > 0 && p.x < 9), 'without waypoints it goes around');
  const [plan] = planOrders(s, [{ ...move('ALPHA', 9, 1), via: [{ x: 5, y: 1 }] }]);
  const path = plan.soldiers[0].path;
  const at = path.findIndex((p) => p.x === 5 && p.y === 1);
  assert.ok(at >= 0 && at < path.length - 1, 'passes through the waypoint before the destination');
  assert.deepEqual(path[path.length - 1], { x: 9, y: 1 });
});

test('waypoints are validated', () => {
  const s = makeState([...grass(20, 19), '~'.repeat(20)], squad);
  assert.match(validateOrder(s, { ...move('ALPHA', 5, 5), via: [{ x: 5, y: 19 }] }).reason, /waypoint 1 is impassable/);
  assert.match(validateOrder(s, { ...move('ALPHA', 5, 5), via: [{ x: 1, y: 1 }, { x: 99, y: 1 }] }).reason, /waypoint 2 is off the map/);
  const tooMany = Array.from({ length: s.balance.movement.maxWaypoints + 1 }, (_, i) => ({ x: i, y: 1 }));
  assert.match(validateOrder(s, { ...move('ALPHA', 5, 5), via: tooMany }).reason, /too many waypoints/);
});

test('followers keep formation through waypoints and the sim follows the preview', () => {
  const s = makeState(grass(20, 20), squad);
  // Last leg runs north, so the wedge at the end faces the way the team starts.
  const orders = [{ ...move('ALPHA', 9, 3, 'run'), via: [{ x: 5, y: 10 }, { x: 9, y: 8 }] }];
  const [plan] = planOrders(s, orders);
  const [lead, ...rest] = plan.soldiers;
  assert.ok(lead.path.some((p) => p.x === 9 && p.y === 8));
  for (const p of rest) {
    const dx = s.soldiers[p.id].pos.x - s.soldiers[lead.id].pos.x;
    const dy = s.soldiers[p.id].pos.y - s.soldiers[lead.id].pos.y;
    assert.deepEqual(p.path, lead.path.map((q) => ({ x: q.x + dx, y: q.y + dy })));
  }
  const next = cloneState(s);
  applyOrders(next, orders, []);
  for (const p of plan.soldiers) assert.deepEqual(next.soldiers[p.id].move.path, p.path);
});

test('hold cancels a move in progress', () => {
  const s = cloneState(makeState(grass(20, 20), squad));
  applyOrders(s, [move('ALPHA', 5, 3)], []);
  applyOrders(s, [{ type: 'hold', side: 'BLUFOR', team: 'ALPHA' }], []);
  assert.ok(s.soldiers.filter((x) => x.team === 'ALPHA' && x.side === 'BLUFOR').every((x) => x.move === null));
});
