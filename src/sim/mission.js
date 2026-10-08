// Mission end. A map may carry a mission:
//   "mission": { "attacker": "BLUFOR", "defender": "OPFOR", "turns": 12, "brief": "..." }
// and an "objective" hex. The attacker wins by holding the objective with a
// fireteam at the end of a turn, or by eliminating every defending fireteam.
// The defender wins by eliminating every attacking fireteam, or when the
// last turn ends without the attacker holding the objective. A map without
// a mission never ends.

import { same } from './hex.js';
import { isActive } from './state.js';

const teams = (state, side) => state.units.filter((u) => u.side === side && u.kind === 'team' && isActive(u));

// After any action: a side with no fireteams left has lost. { winner, why } or null.
export function eliminationResult(state) {
  const m = state.map.mission;
  if (!m) return null;
  if (!teams(state, m.defender).length) return { winner: m.attacker, why: `all ${m.defender} fireteams eliminated` };
  if (!teams(state, m.attacker).length) return { winner: m.defender, why: `all ${m.attacker} fireteams eliminated` };
  return null;
}

// At the end of a turn: the objective, then the turn limit.
export function turnEndResult(state) {
  const m = state.map.mission;
  if (!m) return null;
  const obj = state.map.objective && { col: state.map.objective[0], row: state.map.objective[1] };
  const holder = obj && teams(state, m.attacker).find((u) => same(u.pos, obj));
  if (holder) return { winner: m.attacker, why: `${m.attacker} ${holder.team} holds the objective` };
  if (state.turn >= m.turns) return { winner: m.defender, why: `${m.attacker} did not take the objective in ${m.turns} turns` };
  return null;
}

// Record the result: the game is over, nobody acts any more.
export function endGame(state, result, events) {
  state.result = result;
  state.activeSide = null;
  events.push({ type: 'game_over', turn: state.turn, ...result });
}
