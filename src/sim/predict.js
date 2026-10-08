// Predictions for the order preview. Pure, no DOM, and built only from sim
// code, so what the preview says is what the sim will do:
//   - first actions: the orders are applied to a copy of the state and the
//     sim's own decideActions() says what every soldier does first
//   - ammo: how long the current rate of fire lasts, in sim ticks
//   - route exposure: tiles of a route in line of sight of known contacts
//   - grenade: who launches what, when it lands, scatter, who is in danger
//   - assault: close assault odds from where the team will end up
// Only what the ordering side knows is used (its contacts, its soldiers).

import { assaultChance, decideActions, weaponOf } from './combat.js';
import { tileAt } from './map.js';
import { lineOfSight } from './los.js';
import { applyOrders, planOrders } from './orders.js';
import { cloneState } from './state.js';

// Apply `orders` to a copy of the state and ask the sim what each soldier of
// `side` does first. Cooldowns are cleared: this is the first burst.
// Returns { state (the copy), plans, actions: Map soldierId -> action|null, noFire: Map id -> reason }.
export function firstActions(state, side, orders) {
  const copy = cloneState(state);
  applyOrders(copy, orders, []);
  for (const s of copy.soldiers) s.fireCooldown = 0;
  const events = [];
  const acts = decideActions(copy, new Map(), events);
  const actions = new Map();
  for (const s of copy.soldiers) if (s.side === side) actions.set(s.id, null);
  for (const a of acts) if (a.s.side === side) actions.set(a.s.id, a);
  const noFire = new Map(events.filter((e) => e.type === 'no_fire').map((e) => [e.id, e.reason]));
  return { state: copy, plans: planOrders(state, orders), actions, noFire };
}

// Ticks between bursts for soldier s firing in `mode`, as the sim counts them
// (cooldown set after a burst, ticked down before the next decision).
export function ticksPerBurst(state, s, mode) {
  const w = weaponOf(state, s);
  const rate = mode === 'suppress' ? state.balance.orders.suppress.rateFactor : 1;
  return Math.max(1, Math.ceil((w.burstIntervalSec * rate) / state.tickSec - 1e-9));
}

// Seconds from the first burst (fired at the end of the first tick) until the
// last round, firing without pause. { bursts, lastBurstSec, roundsPerSec }.
export function ammoForecast(state, s, mode) {
  const w = weaponOf(state, s);
  const bursts = Math.ceil(s.ammo / w.roundsPerBurst);
  const per = ticksPerBurst(state, s, mode);
  return {
    bursts,
    lastBurstSec: ((bursts - 1) * per + 1) * state.tickSec,
    roundsPerSec: w.roundsPerBurst / (per * state.tickSec),
  };
}

// Suppression a soldier would put on the aim point per second while firing.
export function suppressionPerSec(state, s, mode) {
  return ammoForecast(state, s, mode).roundsPerSec * weaponOf(state, s).suppressionPerRound;
}

// Positions of contacts the side knows, with the stance it can see
// (spotted) or assumes (suspected: crouched).
export function knownEnemies(state, side) {
  const out = [];
  for (const [id, c] of Object.entries(state.contacts[side] ?? {})) {
    const e = state.soldiers[Number(id)];
    if (e.status === 'down' || e.status === 'dead') continue;
    out.push({ id: Number(id), level: c.level, pos: c.pos, stance: c.level === 'spotted' ? e.stance : state.balance.orders.suppress.aimStance });
  }
  return out;
}

// Tiles of a route where a known contact has clear, unobstructed sight of a
// soldier in `stance` standing on open ground (no concealment on the tile,
// not partly hidden). Returns { tiles, meters, first: index | null }.
export function routeExposure(state, side, path, stance) {
  const enemies = knownEnemies(state, side);
  let tiles = 0;
  let first = null;
  path.forEach((p, i) => {
    if (tileAt(state.map, p.x, p.y).concealment !== 'none') return;
    const seen = enemies.some((e) => {
      const los = lineOfSight(state.map, state.balance, { pos: e.pos, stance: e.stance }, { pos: p, stance });
      return los.clear && !los.partial;
    });
    if (seen) {
      tiles++;
      if (first === null) first = i;
    }
  });
  return { tiles, meters: tiles * state.balance.map.tileMeters, first };
}

// When a grenade thrown on the first tick explodes, in seconds into the turn
// (end of the tick in which it lands).
export function grenadeLandingSec(state, flight) {
  const t = state.tickSec;
  return Math.ceil((t + flight) / t - 1e-9) * t;
}

// Own soldiers who could be caught by a grenade aimed at `at` (danger radius
// plus the possible scatter).
export function friendliesInDanger(state, side, at, scatterTiles) {
  const r = state.balance.grenade.dangerRadiusM / state.balance.map.tileMeters + scatterTiles;
  return state.soldiers.filter((s) => s.side === side && s.status !== 'dead'
    && Math.hypot(s.pos.x - at.x, s.pos.y - at.y) <= r + 1e-9);
}

// Close assault odds for the team leader from where the move plan puts him,
// against a known contact. Status is only used if the contact is spotted.
export function assaultForecast(state, side, plan, targetId) {
  const contact = targetId !== null && targetId !== undefined ? state.contacts[side]?.[targetId] : null;
  if (!contact) return null;
  const target = state.soldiers[targetId];
  const lead = plan.soldiers.find((p) => p.path) ?? null;
  if (!lead) return null;
  // The sim attacks from the first point of the route within reach.
  const reach = state.balance.orders.assault.rangeTiles;
  const start = state.soldiers[lead.id].pos;
  const from = [start, ...lead.path].find((p) => Math.hypot(p.x - contact.pos.x, p.y - contact.pos.y) <= reach + 1e-9)
    ?? lead.path[lead.path.length - 1] ?? start;
  const attacker = { ...state.soldiers[lead.id], pos: from, stance: state.balance.movement.stanceForSpeed[state.balance.orders.assault.speed] };
  const seen = contact.level === 'spotted';
  const t = { ...target, pos: contact.pos, status: seen ? target.status : 'active' };
  return { ...assaultChance(state, attacker, t), statusKnown: seen, targetStatus: seen ? target.status : null };
}
