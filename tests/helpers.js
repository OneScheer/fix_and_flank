import { readFileSync } from 'node:fs';
import { parseMap } from '../src/sim/map.js';
import { createState } from '../src/sim/state.js';

export function loadJson(relPath) {
  return JSON.parse(readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8'));
}

export const balance = loadJson('data/balance.json');

// Small legend for hand-drawn test maps (one character per hex, odd-r rows).
export const LEGEND = {
  '.': 'open', '=': 'road', ':': 'scrub', 'T': 'woods', '%': 'rubble', 'B': 'building', 'n': 'trench', '~': 'water',
};

export function makeMap(rows, units = []) {
  return parseMap({ width: rows[0].length, height: rows.length, legend: LEGEND, rows, units }, balance);
}

export function makeState(rows, units = [], seed = 1) {
  return createState({ balance, map: makeMap(rows, units), seed });
}

export function trainingState(seed = 1) {
  return createState({ balance, map: parseMap(loadJson('data/maps/training.json'), balance), seed });
}

export const open = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));
export const unit = (side, team, col, row, extra = {}) => ({ side, team, pos: [col, row], ...extra });
export const H = (col, row) => ({ col, row });
