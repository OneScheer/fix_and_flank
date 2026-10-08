// Placeholder enemy behavior until fire (milestone 4) and the AI (milestone 6):
// every OPFOR activation is a pass. Reads state, returns an action.

import { canActivate } from '../sim/state.js';

export function chooseAction(state, side) {
  const unit = state.units.find((u) => u.side === side && canActivate(state, u));
  return unit ? { type: 'pass', unit: unit.id } : null;
}
