import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSoldier, createState, fireMarkers, healthStatus, suppressionLevel, teamSummary } from '../src/sim/state.js';

const balance = JSON.parse(readFileSync(new URL('../data/balance.json', import.meta.url)));
const { suppressed, pinned } = balance.suppression;
const max = balance.soldier.hpMax;

function team(id, members) {
  return members.map((m, i) =>
    createSoldier({ id: `${id}${i}`, team: id, role: m.role ?? 'RFL', pos: m.pos ?? { x: i, y: 0 }, balance, ...m }),
  );
}

test('suppression level follows balance thresholds, pinned is worse', () => {
  assert.equal(suppressionLevel(0, balance), 'none');
  assert.equal(suppressionLevel(suppressed - 1, balance), 'none');
  assert.equal(suppressionLevel(suppressed, balance), 'suppressed');
  assert.equal(suppressionLevel(pinned - 1, balance), 'suppressed');
  assert.equal(suppressionLevel(pinned, balance), 'pinned');
  assert.equal(suppressionLevel(100, balance), 'pinned');
});

test('soldiers start at full hitpoints from balance', () => {
  const [s] = team('A', [{}]);
  assert.equal(s.hp, max);
  assert.equal(s.hpMax, max);
  assert.equal(healthStatus(s), 'active');
  assert.equal(healthStatus({ ...s, hp: max - 1 }), 'wounded');
  assert.equal(healthStatus({ ...s, hp: 0 }), 'down');
});

test('team summary totals hitpoints and counts casualties', () => {
  const soldiers = team('BRAVO', [{ role: 'TL' }, { role: 'AR', hp: max - 1 }, { role: 'GR' }, { role: 'RFL', hp: 0 }]);
  const state = createState({ map: { width: 10, height: 10 }, teams: [{ id: 'BRAVO', name: 'BRAVO', letter: 'B' }], soldiers });
  const t = teamSummary(state, 'BRAVO', balance);
  assert.equal(t.hp, 3 * max - 1);
  assert.equal(t.hpMax, 4 * max);
  assert.equal(t.wounded, 1);
  assert.equal(t.down, 1);
  assert.deepEqual(t.roster.map((r) => r.health), ['active', 'wounded', 'active', 'down']);
});

test('team marker shows the worst suppression among soldiers still fighting', () => {
  const teams = [{ id: 'A', name: 'ALPHA', letter: 'A' }];
  const mk = (members) => teamSummary(createState({ map: {}, teams, soldiers: team('A', members) }), 'A', balance);
  assert.equal(mk([{ suppression: 10 }, { suppression: 20 }]).suppressionLevel, 'none');
  assert.equal(mk([{ suppression: 10 }, { suppression: suppressed }]).suppressionLevel, 'suppressed');
  assert.equal(mk([{ suppression: suppressed }, { suppression: pinned }]).suppressionLevel, 'pinned');
  // A downed soldier's suppression does not pin the team.
  assert.equal(mk([{ suppression: 0 }, { suppression: pinned, hp: 0 }]).suppressionLevel, 'none');
});

test('counter position is the centre of living soldiers', () => {
  const teams = [{ id: 'A', name: 'ALPHA', letter: 'A' }];
  const soldiers = team('A', [{ pos: { x: 0, y: 0 } }, { pos: { x: 4, y: 2 } }, { pos: { x: 100, y: 100 }, hp: 0 }]);
  assert.deepEqual(teamSummary(createState({ map: {}, teams, soldiers }), 'A', balance).pos, { x: 2, y: 1 });
});

test('fire markers: one per team and target tile, other events ignored', () => {
  const events = [
    { type: 'fired', team: 'A', from: { x: 0, y: 0 }, target: { x: 5, y: 5 } },
    { type: 'fired', team: 'A', from: { x: 1, y: 0 }, target: { x: 5, y: 5 } },
    { type: 'fired', team: 'B', from: { x: 2, y: 0 }, target: { x: 5, y: 5 } },
    { type: 'moved', team: 'A' },
  ];
  const m = fireMarkers(events);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((f) => f.team), ['A', 'B']);
});
