// Browser entry point. Wires data, sim, render, and UI together.

import { createState } from './sim/state.js';
import { fitCanvas, drawEmpty } from './render/canvas.js';

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const balance = await loadJson('data/balance.json');
  const state = createState({ balance, seed: 1 });

  const canvas = document.getElementById('board');
  const status = document.getElementById('status');

  function redraw() {
    const { ctx, width, height } = fitCanvas(canvas);
    drawEmpty(ctx, width, height, 'No map loaded');
  }

  window.addEventListener('resize', redraw);
  redraw();
  status.textContent = `Turn ${state.turn}. ${state.ticksPerTurn} ticks per turn. Seed ${state.seed}.`;
}

main().catch((err) => {
  console.error(err);
  document.getElementById('status').textContent = `Error: ${err.message}`;
});
