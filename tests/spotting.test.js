import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurn } from '../src/sim/step.js';
import { spotChance } from '../src/sim/spotting.js';
import { lineOfSight } from '../src/sim/los.js';
import { balance, grass, holdFire, makeState as makeArmed, trainingState as trainingArmed } from './helpers.js';

// Spotting on its own: nobody fires (firing reveals shooters, tested in combat tests).
const makeState = (...a) => holdFire(makeArmed(...a));
const trainingState = (...a) => holdFire(trainingArmed(...a));

const unit = (side, team, role, x, y, stance) => ({ side, team, role, pos: [x, y], ...(stance ? { stance } : {}) });
const move = (side, team, x, y, speed = 'walk') => ({ type: 'move', side, team, dest: { x, y }, speed });

test('new states start with empty contact lists for each side', () => {
  const s = makeState(grass(5, 5), [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 4, 4)]);
  assert.deepEqual(s.contacts, { BLUFOR: {}, OPFOR: {} });
});

test('an enemy within auto-spot range with line of sight is spotted on the first tick', () => {
  const s = makeState(grass(10, 1), [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 2, 0)]);
  const { state, events } = resolveTurn(s, []);
  assert.equal(state.contacts.BLUFOR[1].level, 'spotted');
  assert.equal(state.contacts.OPFOR[0].level, 'spotted', 'the same rules apply to OPFOR');
  const first = events.find((e) => e.type === 'spotted' && e.side === 'BLUFOR');
  assert.equal(first.tick, 0);
  assert.equal(first.by, 0);
});

test('no line of sight, no contact, however long you wait', () => {
  const rows = ['.....#.....'];
  let s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 10, 0)]);
  for (let i = 0; i < 10; i++) s = resolveTurn(s, []).state;
  assert.deepEqual(s.contacts.BLUFOR, {});
});

test('an enemy in plain view on open ground is spotted within a turn or two', () => {
  const s = makeState(grass(30, 1), [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 20, 0, 'stand')]);
  let spotted = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const r = resolveTurn({ ...s, rngState: seed }, []);
    if (r.state.contacts.BLUFOR[1]?.level === 'spotted') spotted++;
  }
  assert.ok(spotted >= 45, `spotted in ${spotted}/50 runs`);
});

// Observer at (0,1). A wall at (11,1) hides (13,1) from it.
const WALL_ROWS = [
  '..............',
  '...........#..',
  '..............',
];

test('spotted contacts track the enemy while in view, then become suspected at the last known position', () => {
  const s = makeState(WALL_ROWS, [unit('BLUFOR', 'ALPHA', 'TL', 0, 1), unit('OPFOR', 'ALPHA', 'TL', 2, 1)]);
  let r = resolveTurn(s, []);
  assert.equal(r.state.contacts.BLUFOR[1].level, 'spotted');
  r = resolveTurn(r.state, [move('OPFOR', 'ALPHA', 13, 1, 'run')]);
  const c = r.state.contacts.BLUFOR[1];
  assert.equal(c.level, 'suspected');
  const lost = r.events.find((e) => e.type === 'lost' && e.side === 'BLUFOR');
  assert.ok(lost, 'lost event');
  assert.deepEqual(c.pos, lost.pos);
  assert.notDeepEqual(c.pos, r.state.soldiers[1].pos, 'last known position, not the true one');
  const lastMove = r.events.filter((e) => e.type === 'moved' && e.id === 1 && e.tick < lost.tick).pop();
  assert.deepEqual(c.pos, lastMove.to, 'where it was when last seen');
});

test('suspected contacts are forgotten after contactMemorySec', () => {
  const s = makeState(WALL_ROWS, [unit('BLUFOR', 'ALPHA', 'TL', 0, 1), unit('OPFOR', 'ALPHA', 'TL', 2, 1)]);
  let r = resolveTurn(s, [move('OPFOR', 'ALPHA', 13, 1, 'run')]);
  assert.equal(r.state.contacts.BLUFOR[1].level, 'suspected');
  const turnsToForget = Math.ceil(balance.spotting.contactMemorySec / balance.turn.durationSec);
  let state = r.state;
  let expired = null;
  for (let i = 0; i <= turnsToForget && !expired; i++) {
    r = resolveTurn(state, []);
    state = r.state;
    expired = r.events.find((e) => e.type === 'contact_expired');
  }
  assert.ok(expired, 'contact expired');
  assert.equal(state.contacts.BLUFOR[1], undefined);
});

test('more observers do not stack spotting chances', () => {
  const one = makeState(grass(40, 9), [unit('BLUFOR', 'ALPHA', 'TL', 0, 4), unit('OPFOR', 'ALPHA', 'TL', 39, 4, 'prone')]);
  const many = makeState(grass(40, 9), [
    ...[0, 1, 2, 3, 5, 6, 7, 8].map((y) => unit('BLUFOR', 'ALPHA', 'RFL', 0, y)),
    unit('OPFOR', 'ALPHA', 'TL', 39, 4, 'prone'),
  ]);
  let a = 0;
  let b = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (resolveTurn({ ...one, rngState: seed }, []).state.contacts.BLUFOR[1]) a++;
    if (resolveTurn({ ...many, rngState: seed }, []).state.contacts.BLUFOR[8]) b++;
  }
  assert.ok(Math.abs(a - b) <= 25, `one observer ${a}/200, eight observers ${b}/200`);
});

test('spot chance falls with range, low stance, concealment and partial cover; rises when moving', () => {
  const rows = [
    '....................................................',
    '....................................................',
  ];
  const s = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 10, 0, 'stand')]);
  const obs = s.soldiers[0];
  const chance = (target, moving = false) => {
    const los = lineOfSight(s.map, s.balance, obs, target);
    return spotChance(s, obs, target, los, moving).perSec;
  };
  const near = chance({ pos: { x: 10, y: 0 }, stance: 'stand' });
  const far = chance({ pos: { x: 50, y: 0 }, stance: 'stand' });
  const prone = chance({ pos: { x: 10, y: 0 }, stance: 'prone' });
  const moving = chance({ pos: { x: 10, y: 0 }, stance: 'crouch' }, true);
  const still = chance({ pos: { x: 10, y: 0 }, stance: 'crouch' }, false);
  assert.ok(far < near);
  assert.ok(prone < near);
  assert.ok(moving > still);

  const forest = makeState(['..........T'], [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 10, 0, 'stand')]);
  const fo = forest.soldiers[0];
  const ft = forest.soldiers[1];
  const inTrees = spotChance(forest, fo, ft, lineOfSight(forest.map, forest.balance, fo, ft), false);
  assert.ok(inTrees.perSec < near);
  assert.equal(inTrees.factors.targetConcealment, balance.spotting.targetConcealmentFactor.full);

  const wall = makeState(['.........-.'], [unit('BLUFOR', 'ALPHA', 'TL', 0, 0), unit('OPFOR', 'ALPHA', 'TL', 10, 0, 'crouch')]);
  const wo = wall.soldiers[0];
  const wt = wall.soldiers[1];
  const behindWall = spotChance(wall, wo, wt, lineOfSight(wall.map, wall.balance, wo, wt), false);
  assert.equal(behindWall.factors.partialExposure, balance.spotting.partialExposureFactor);
});

test('a dug-in, still, low enemy is spotted less often than one walking in the open', () => {
  const rows = grass(40, 3);
  rows[1] = '.'.repeat(33) + '-' + '.'.repeat(6);
  const open = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 0, 1), unit('OPFOR', 'ALPHA', 'TL', 34, 0, 'stand')]);
  const dug = makeState(rows, [unit('BLUFOR', 'ALPHA', 'TL', 0, 1), unit('OPFOR', 'ALPHA', 'TL', 34, 1, 'crouch')]);
  let openSpotted = 0;
  let dugSpotted = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (resolveTurn({ ...open, rngState: seed }, [move('OPFOR', 'ALPHA', 34, 2)]).state.contacts.BLUFOR[1]) openSpotted++;
    if (resolveTurn({ ...dug, rngState: seed }, []).state.contacts.BLUFOR[1]) dugSpotted++;
  }
  assert.ok(dugSpotted < openSpotted / 2, `dug in ${dugSpotted}/200 vs open ${openSpotted}/200`);
});

test('contacts are deterministic for the same seed and orders', () => {
  const play = (seed) => {
    let state = trainingState(seed);
    const plan = [[move('BLUFOR', 'ALPHA', 37, 40, 'run')], [move('BLUFOR', 'BRAVO', 62, 40, 'walk')], []];
    const events = [];
    for (const orders of plan) {
      const r = resolveTurn(state, orders);
      state = r.state;
      events.push(...r.events.filter((e) => e.type !== 'moved'));
    }
    return { contacts: state.contacts, events };
  };
  assert.deepEqual(play(9), play(9));
});

test('on the training map, the dug-in OPFOR is rarely spotted in the first turn', () => {
  // Four crouched soldiers behind a low wall about 100 m away, not firing.
  const runs = 500;
  let spotted = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const r = resolveTurn(trainingState(seed), []);
    if (Object.keys(r.state.contacts.BLUFOR).length > 0) spotted++;
  }
  assert.ok(spotted / runs < 0.25, `spotted in ${spotted}/${runs} runs`);
});
