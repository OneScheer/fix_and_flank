// Milestone 7 balance run: the scripted plans of a mission against the AI.
// Usage: npm run balance [-- runs [first seed] [map]]   (default 200 1 trenchline)

import { readFileSync } from 'node:fs';
import { chooseOrders } from '../src/ai/basic.js';
import { fixAndFlank, frontalAssault, playOut } from '../src/ai/drills.js';
import { parseMap } from '../src/sim/map.js';
import { commitOrders } from '../src/sim/orders.js';
import { createRng } from '../src/sim/rng.js';
import { createState } from '../src/sim/state.js';

const load = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const [runs = 200, first = 1, name = 'trenchline'] = process.argv.slice(2);
const balance = load('data/balance.json');
const json = load(`data/maps/${name}.json`);
const map = parseMap(json, balance);

for (const [label, make, want] of [['frontal assault', frontalAssault, '< 25%'], ['fix and flank', fixAndFlank, '> 70%']]) {
  let wins = 0;
  let turns = 0;
  const why = {};
  for (let seed = Number(first); seed < Number(first) + Number(runs); seed++) {
    const end = playOut(createState({ balance, map, seed }), make(json.drills), chooseOrders, commitOrders, createRng);
    const r = end.result ?? { winner: null, why: 'did not end' };
    why[`${r.winner}: ${r.why}`] = (why[`${r.winner}: ${r.why}`] ?? 0) + 1;
    if (r.winner === 'BLUFOR') {
      wins++;
      turns += end.turn;
    }
  }
  console.log(`${label}: BLUFOR wins ${(100 * wins / runs).toFixed(1)}% (target ${want})${wins ? `, on turn ${(turns / wins).toFixed(1)} on average` : ''}`);
  for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
}
