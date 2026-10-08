import { readFileSync } from 'node:fs';
import { parseMap } from '../src/sim/map.js';
import { commitOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { canActivate, createState } from '../src/sim/state.js';

export function loadJson(relPath) {
  return JSON.parse(readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8'));
}

export const balance = loadJson('data/balance.json');

// Small legend for hand-drawn test maps (one character per hex, odd-r rows).
export const LEGEND = {
  '.': 'open', '=': 'road', ':': 'scrub', 'T': 'woods', '%': 'rubble', 'B': 'building', 'n': 'trench', '~': 'water',
};

export function makeMap(rows, units = [], hexsides = []) {
  return parseMap({ width: rows[0].length, height: rows.length, legend: LEGEND, rows, units, hexsides }, balance);
}

export function makeState(rows, units = [], seed = 1, hexsides = []) {
  return createState({ balance, map: makeMap(rows, units, hexsides), seed });
}

export function trainingState(seed = 1) {
  return createState({ balance, map: parseMap(loadJson('data/maps/training.json'), balance), seed });
}

export const open = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));
export const unit = (side, team, col, row, extra = {}) => ({ side, team, pos: [col, row], ...extra });
export const H = (col, row) => ({ col, row });

// Commit empty orders (everyone holds) until the named phase comes up.
export function toPhase(state, name) {
  let s = state;
  for (let i = 0; i < 20; i++) {
    if (s.balance.turn.phases[s.phase].name === name && s.units.some((u) => canActivate(s, u))) return s;
    s = commitOrders(s, [], createRng(s.rngState)).state;
  }
  throw new Error(`no ${name} phase reached`);
}
