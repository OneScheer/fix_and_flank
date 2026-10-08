// Game state shape and read-only queries on it. Pure logic, no DOM.

export const ROLES = {
  TL: { name: 'Team leader', weapon: 'Rifle' },
  AR: { name: 'Automatic rifleman', weapon: 'Light machine gun' },
  GR: { name: 'Grenadier', weapon: 'Rifle + 40mm' },
  RFL: { name: 'Rifleman', weapon: 'Rifle' },
};

export function createSoldier({ id, team, role, pos, balance, hp, suppression = 0, stance = 'crouch' }) {
  const hpMax = balance.soldier.hpMax;
  return {
    id,
    team,
    role,
    pos: { x: pos.x, y: pos.y },
    stance,
    suppression,
    hpMax,
    hp: hp ?? hpMax,
  };
}

export function createState({ map, soldiers, teams, events = [] }) {
  return { turn: 0, map, teams, soldiers, events };
}

// Suppression state from the thresholds in balance.json.
// 'none' < 'suppressed' < 'pinned' (pinned is the worse condition).
export const SUPPRESSION_LEVELS = ['none', 'suppressed', 'pinned'];

export function suppressionLevel(suppression, balance) {
  const s = balance.suppression;
  if (suppression >= s.pinned) return 'pinned';
  if (suppression >= s.suppressed) return 'suppressed';
  return 'none';
}

export function healthStatus(soldier) {
  if (soldier.hp <= 0) return 'down';
  if (soldier.hp < soldier.hpMax) return 'wounded';
  return 'active';
}

// What a team counter shows: per-soldier hitpoints, casualty counts, and
// the worst suppression level among soldiers still in the fight.
export function teamSummary(state, teamId, balance) {
  const team = state.teams.find((t) => t.id === teamId);
  const members = state.soldiers.filter((s) => s.team === teamId);
  let hp = 0;
  let hpMax = 0;
  let wounded = 0;
  let down = 0;
  let worst = 0;
  let sx = 0;
  let sy = 0;
  let alive = 0;
  const roster = members.map((s) => {
    const health = healthStatus(s);
    const level = health === 'down' ? 'none' : suppressionLevel(s.suppression, balance);
    hp += Math.max(0, s.hp);
    hpMax += s.hpMax;
    if (health === 'wounded') wounded++;
    if (health === 'down') down++;
    if (health !== 'down') {
      worst = Math.max(worst, SUPPRESSION_LEVELS.indexOf(level));
      sx += s.pos.x;
      sy += s.pos.y;
      alive++;
    }
    return {
      id: s.id,
      role: s.role,
      hp: Math.max(0, s.hp),
      hpMax: s.hpMax,
      health,
      suppression: s.suppression,
      suppressionLevel: level,
    };
  });
  return {
    id: teamId,
    letter: team.letter,
    name: team.name,
    roster,
    hp,
    hpMax,
    wounded,
    down,
    suppressionLevel: SUPPRESSION_LEVELS[worst],
    // Counter sits on the centre of the soldiers still alive.
    pos: alive ? { x: sx / alive, y: sy / alive } : null,
  };
}

// Fire markers for the last turn: one per team and target tile, built from
// 'fired' events ({ type, team, from, target }).
export function fireMarkers(events) {
  const seen = new Map();
  for (const e of events) {
    if (e.type !== 'fired') continue;
    const key = `${e.team}:${e.target.x},${e.target.y}`;
    if (!seen.has(key)) seen.set(key, { team: e.team, from: e.from, target: e.target });
  }
  return [...seen.values()];
}
