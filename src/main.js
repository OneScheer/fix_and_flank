// Entry point. Builds a demo scene showing team counters, hitpoints,
// suppression badges and fire markers until missions exist.
import { createSoldier, createState, fireMarkers, teamSummary } from './sim/state.js';
import { drawScene } from './render/scene.js';
import { renderRoster } from './ui/roster.js';

const TILE = 16;

function demoState(balance) {
  const teams = [
    { id: 'ALPHA', name: 'ALPHA', letter: 'A' },
    { id: 'BRAVO', name: 'BRAVO', letter: 'B' },
  ];
  const s = (id, team, role, x, y, extra = {}) =>
    createSoldier({ id, team, role, pos: { x, y }, balance, ...extra });
  const soldiers = [
    // ALPHA: base of fire, taking return fire.
    s('a1', 'ALPHA', 'TL', 9, 9, { suppression: 45 }),
    s('a2', 'ALPHA', 'AR', 10, 8, { suppression: 50 }),
    s('a3', 'ALPHA', 'GR', 11, 10, { suppression: 30 }),
    s('a4', 'ALPHA', 'RFL', 10, 11, { suppression: 42 }),
    // BRAVO: caught in the open, one wounded, one down.
    s('b1', 'BRAVO', 'TL', 20, 24, { suppression: 75 }),
    s('b2', 'BRAVO', 'AR', 21, 25, { suppression: 80, hp: balance.soldier.hpMax - 1 }),
    s('b3', 'BRAVO', 'GR', 22, 24, { suppression: 60 }),
    s('b4', 'BRAVO', 'RFL', 21, 23, { hp: 0 }),
  ];
  const events = [
    { type: 'fired', team: 'ALPHA', shooter: 'a2', from: { x: 10, y: 9 }, target: { x: 46, y: 12 } },
    { type: 'fired', team: 'ALPHA', shooter: 'a1', from: { x: 9, y: 9 }, target: { x: 46, y: 12 } },
  ];
  return createState({ map: { width: 56, height: 34 }, teams, soldiers, events });
}

async function main() {
  const balance = await (await fetch('data/balance.json')).json();
  const state = demoState(balance);
  const summaries = state.teams.map((t) => teamSummary(state, t.id, balance));

  const canvas = document.getElementById('map');
  const w = state.map.width * TILE;
  const h = state.map.height * TILE;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  drawScene(ctx, { map: state.map, summaries, fireMarkers: fireMarkers(state.events), tile: TILE });
  renderRoster(document.getElementById('roster'), summaries);
}

main();
