// Grenades: hand grenades and 40 mm from the grenadier.
//
// A team grenade order is carried out by one soldier. The GRN fires 40 mm if
// the target is in 40 mm range and he has a line of fire to it; otherwise the
// closest soldier who can reach it throws a hand grenade (no line of fire
// needed, it is lobbed). It lands after a flight time, scattered by up to
// floor(range / 50 m x scatterTilesPer50M) tiles in x and y.
//
// The blast hurts everyone near the impact, friend or foe: hit chance by
// distance, times the target's directional cover from the impact point (so a
// grenade landing behind a wall gets round it), and full-height walls between
// the impact and the soldier stop it. It also suppresses, falling off with
// distance.

import { coverFrom } from './cover.js';
import { inBounds, tileAt } from './map.js';
import { lineOfSight, rayTiles } from './los.js';

function rangeM(state, a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y) * state.balance.map.tileMeters;
}

export function grenadeKind(state, kind) {
  return state.weapons.grenades[kind];
}

export function flightSec(state, kind, distanceM) {
  const g = grenadeKind(state, kind);
  return g.flightSec ?? distanceM / g.speedMps;
}

export function scatterTiles(state, kind, distanceM) {
  return Math.floor((distanceM / 50) * grenadeKind(state, kind).scatterTilesPer50M);
}

// Can soldier s put a grenade of this kind on `at`? { ok, reason, rangeM }
export function canLaunch(state, s, kind, at) {
  const g = grenadeKind(state, kind);
  const r = rangeM(state, s.pos, at);
  if ((s.grenades?.[kind] ?? 0) <= 0) return { ok: false, reason: `no ${g.name}s left`, rangeM: r };
  if (r < g.minRangeM) return { ok: false, reason: `too close for ${g.name} (${Math.round(r)} m, min ${g.minRangeM} m)`, rangeM: r };
  if (r > g.maxRangeM) return { ok: false, reason: `out of ${g.name} range (${Math.round(r)} m, max ${g.maxRangeM} m)`, rangeM: r };
  if (g.needsLineOfFire) {
    const lof = lineOfSight(state.map, state.balance, s, { pos: at, stance: state.balance.orders.suppress.aimStance },
      { ignoreConcealment: true });
    if (!lof.clear) return { ok: false, reason: `no line of fire for ${g.name} (${lof.reason})`, rangeM: r };
  }
  return { ok: true, reason: null, rangeM: r };
}

// Who carries out a team grenade order on `at`, and how.
// members: soldiers able to act. Returns { ok, thrower, kind, rangeM, flightSec, scatterTiles, reason }.
export function planGrenade(state, members, at) {
  const grn = members.find((s) => s.role === 'GRN');
  let why = [];
  if (grn) {
    const c = canLaunch(state, grn, '40mm', at);
    if (c.ok) return launchPlan(state, grn, '40mm', c.rangeM);
    why.push(c.reason);
  }
  const throwers = members
    .map((s) => ({ s, c: canLaunch(state, s, 'hand', at) }))
    .sort((a, b) => a.c.rangeM - b.c.rangeM || a.s.id - b.s.id);
  const best = throwers.find((t) => t.c.ok);
  if (best) return launchPlan(state, best.s, 'hand', best.c.rangeM);
  if (throwers.length) why.push(throwers[0].c.reason);
  why = [...new Set(why)];
  return { ok: false, reason: why.join('; ') || 'no one can throw' };
}

function launchPlan(state, s, kind, r) {
  return {
    ok: true, thrower: s.id, kind, rangeM: r,
    flightSec: flightSec(state, kind, r),
    scatterTiles: scatterTiles(state, kind, r),
  };
}

// Launch: spend the grenade, roll scatter, queue the impact.
export function launchGrenade(state, s, kind, at, rng, now, events) {
  const r = rangeM(state, s.pos, at);
  const spread = scatterTiles(state, kind, r);
  let land = { ...at };
  if (spread > 0) {
    const dx = rng.int(2 * spread + 1) - spread;
    const dy = rng.int(2 * spread + 1) - spread;
    const p = { x: at.x + dx, y: at.y + dy };
    if (inBounds(state.map, p.x, p.y)) land = p;
  }
  s.grenades[kind] -= 1;
  const landsAtSec = now + flightSec(state, kind, r);
  state.grenades.push({ by: s.id, side: s.side, kind, aim: { ...at }, at: land, landsAtSec });
  events.push({ type: 'throw', id: s.id, kind, from: { ...s.pos }, aim: { ...at }, landsAtSec });
}

function shielded(state, from, to) {
  return rayTiles(from, to).some((step) => {
    const tiles = step.pair ?? [step.tile];
    return tiles.every((p) => tileAt(state.map, p.x, p.y).height === 2);
  });
}

// Hit chance on soldier e from a blast at `at`, with the factors.
export function blastChance(state, at, e) {
  const g = state.balance.grenade;
  const d = Math.hypot(e.pos.x - at.x, e.pos.y - at.y);
  const band = g.hitByDistanceTiles.find(([maxD]) => d <= maxD + 1e-9);
  if (!band) return { chance: 0, distance: d, cover: null, shielded: false };
  if (d > 0 && shielded(state, at, e.pos)) return { chance: 0, distance: d, cover: null, shielded: true };
  const cover = d > 0 ? coverFrom(state.map, state.balance, e, at) : { protection: 0, direction: null, tile: null };
  return { chance: band[1] * (1 - cover.protection), distance: d, cover, shielded: false };
}

// Impacts due by `now`. Pushes 'explosion' (and 'hit') events.
export function resolveGrenades(state, rng, now, events) {
  const g = state.balance.grenade;
  const s = state.balance.suppression;
  const due = state.grenades.filter((x) => x.landsAtSec <= now + 1e-9);
  state.grenades = state.grenades.filter((x) => x.landsAtSec > now + 1e-9);
  for (const gr of due) {
    const effects = [];
    for (const e of state.soldiers) {
      if (e.status === 'dead') continue;
      const b = blastChance(state, gr.at, e);
      let suppression = 0;
      if (b.distance <= g.suppressionRadiusTiles && !b.shielded) {
        suppression = g.suppression * (1 - b.distance / (g.suppressionRadiusTiles + 1));
        e.suppression = Math.min(s.max, e.suppression + suppression);
        e.underFireUntilSec = now + s.underFireSec;
      }
      let hit = false;
      if (b.chance > 0 && rng.chance(b.chance)) {
        hit = true;
        e.hp = Math.max(0, e.hp - g.damage);
        events.push({ type: 'hit', id: e.id, by: gr.by, damage: g.damage, hp: e.hp, cause: gr.kind });
      }
      if (suppression > 0 || b.chance > 0) {
        effects.push({ id: e.id, chance: b.chance, hit, suppression, distance: b.distance,
          cover: b.cover?.tile ? { what: b.cover.tile.what, protection: b.cover.protection } : null });
      }
    }
    events.push({ type: 'explosion', by: gr.by, kind: gr.kind, aim: gr.aim, pos: { ...gr.at }, effects });
  }
}
