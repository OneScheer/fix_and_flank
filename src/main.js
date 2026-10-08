// Browser entry point. Loads data, builds the initial state, starts the UI.

import { parseMap } from './sim/map.js';
import { createState } from './sim/state.js';
import { startApp } from './ui/app.js';

const DEFAULT_MAP = 'training';
const DEFAULT_SEED = 1;

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const params = new URLSearchParams(location.search);
  const mapName = params.get('map') ?? DEFAULT_MAP;
  const seed = Number(params.get('seed') ?? DEFAULT_SEED);
  const [balance, mapJson] = await Promise.all([
    loadJson('data/balance.json'),
    loadJson(`data/maps/${encodeURIComponent(mapName)}.json`),
  ]);
  const state = createState({ balance, map: parseMap(mapJson, balance), seed });
  window.app = startApp(state); // exposed for debugging in the console
}

main().catch((err) => {
  console.error(err);
  document.getElementById('status').textContent = `Error: ${err.message}`;
});
