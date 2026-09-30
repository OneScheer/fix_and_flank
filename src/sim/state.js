// Game state shape. Filled out in Milestone 2 (map and movement).

export function ticksPerTurn(balance) {
  const { durationSec, tickSec } = balance.turn;
  const ticks = durationSec / tickSec;
  if (!Number.isInteger(ticks)) {
    throw new Error(`turn.durationSec (${durationSec}) must be a whole multiple of turn.tickSec (${tickSec})`);
  }
  return ticks;
}

export function createState({ balance, seed }) {
  return {
    turn: 0,
    tick: 0,
    seed: seed >>> 0,
    ticksPerTurn: ticksPerTurn(balance),
  };
}
