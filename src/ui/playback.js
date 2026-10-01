// Turn playback from events. No DOM, so it can be tested in Node.
// frames[k] is every soldier's position at the start of tick k;
// frames[ticksPerTurn] is the end of the turn.

export function buildFrames(soldiersBefore, events, ticksPerTurn) {
  const current = new Map(soldiersBefore.map((s) => [s.id, { ...s.pos }]));
  const byTick = Array.from({ length: ticksPerTurn }, () => []);
  for (const e of events) if (e.type === 'moved') byTick[e.tick].push(e);
  const frames = [new Map(current)];
  for (let k = 0; k < ticksPerTurn; k++) {
    for (const e of byTick[k]) current.set(e.id, { ...e.to });
    frames.push(new Map(current));
  }
  return frames;
}

// Interpolated position at a fractional tick t in [0, ticksPerTurn].
export function positionAt(frames, id, t) {
  const last = frames.length - 1;
  const k = Math.max(0, Math.min(last, Math.floor(t)));
  const a = frames[k].get(id);
  if (k === last) return a;
  const b = frames[k + 1].get(id);
  const f = t - k;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// Events that have happened by fractional tick t.
export function eventsUpTo(events, t) {
  return events.filter((e) => e.tick < t);
}

// A side's contacts at fractional tick t: Map enemyId -> { level, pos }.
// Starts from the contacts before the turn and applies this side's
// spotted / lost / suspected / contact_expired events that have happened by t.
export function contactsAt(contactsBefore, events, side, t) {
  const known = new Map(Object.entries(contactsBefore ?? {}).map(([id, c]) => [Number(id), { level: c.level, pos: c.pos }]));
  for (const e of events) {
    if (e.side !== side || e.tick >= t) continue;
    if (e.type === 'spotted') known.set(e.id, { level: 'spotted', pos: e.pos });
    else if (e.type === 'lost' || e.type === 'suspected') known.set(e.id, { level: 'suspected', pos: e.pos });
    else if (e.type === 'contact_expired') known.delete(e.id);
  }
  return known;
}

// Soldier status and stance at fractional tick t: Map id -> { status, stance }.
export function soldiersAt(soldiersBefore, events, t) {
  const now = new Map(soldiersBefore.map((s) => [s.id, { status: s.status, stance: s.stance }]));
  for (const e of events) {
    if (e.tick >= t) continue;
    if (e.type === 'status') now.get(e.id).status = e.to;
    else if (e.type === 'stance') now.get(e.id).stance = e.to;
  }
  return now;
}
