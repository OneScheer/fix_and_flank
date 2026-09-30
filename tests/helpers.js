import { readFileSync } from 'node:fs';
import { parseMap } from '../src/sim/map.js';
import { createState } from '../src/sim/state.js';

export function loadJson(relPath) {
  return JSON.parse(readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8'));
}

export const balance = loadJson('data/balance.json');

// Small legend for hand-drawn test maps.
export const LEGEND = {
  '.': { terrain: 'grass' },
  '=': { terrain: 'road' },
  'T': { terrain: 'forest', cover: 'light', concealment: 'full' },
  '~': { terrain: 'water' },
  '#': { terrain: 'open', height: 2, cover: 'hard', concealment: 'full' },
  '-': { terrain: 'grass', height: 1, cover: 'hard' },
  'D': { terrain: 'open', feature: 'door' },
  'W': { terrain: 'open', height: 1, cover: 'hard', concealment: 'partial', feature: 'window' },
};

export function makeMap(rows, units = []) {
  return parseMap({ width: rows[0].length, height: rows.length, legend: LEGEND, rows, units });
}

export function makeState(rows, units = [], seed = 1) {
  return createState({ balance, map: makeMap(rows, units), seed });
}

export function trainingState(seed = 1) {
  return createState({ balance, map: parseMap(loadJson('data/maps/training.json')), seed });
}

export const grass = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));
