// Exact odds for the preview. The same numbers the sim rolls against.

import { assaultOutcome } from './assault.js';
import { chanceAtLeast } from './dice.js';

// P(k successes) for k = 0..n, each with chance p.
export function binomial(n, p) {
  const out = [];
  let c = 1; // n choose k
  for (let k = 0; k <= n; k++) {
    out.push(c * p ** k * (1 - p) ** (n - k));
    c = (c * (n - k)) / (k + 1);
  }
  return out;
}

// Odds of a shot of `dice` dice hitting on `tn`, against cover `casualtyOn`,
// on a unit with `soldiers` men that is pinned by `pinAt` hits.
// { hitDie, anyHit, pin, expectedHits, anyCasualty, expectedCasualties }
export function fireOdds({ dice, tn, casualtyOn, pinAt, soldiers }) {
  const p = chanceAtLeast(tn);
  const q = chanceAtLeast(casualtyOn);
  const hits = binomial(dice, p);
  const kills = binomial(dice, p * q); // a die that hits and then kills
  return {
    hitDie: p,
    anyHit: 1 - hits[0],
    pin: hits.slice(pinAt).reduce((a, b) => a + b, 0),
    expectedHits: dice * p,
    anyCasualty: 1 - kills[0],
    expectedCasualties: kills.reduce((a, pk, k) => a + pk * Math.min(k, soldiers), 0),
  };
}

// Exact odds of an assault (see assault.js): both sides' dice are
// independent, so every pair of hit counts is enumerated.
// { take, repulsed, attackerDestroyed, expectedAttackerLosses, expectedDefenderLosses }
export function assaultOdds(sol) {
  const a = binomial(sol.attackDice, chanceAtLeast(sol.attackTn));
  const d = binomial(sol.defendDice, chanceAtLeast(sol.defendTn));
  const out = { take: 0, repulsed: 0, attackerDestroyed: 0, expectedAttackerLosses: 0, expectedDefenderLosses: 0 };
  a.forEach((pa, ka) => d.forEach((pd, kd) => {
    const p = pa * pd;
    const defenderLeft = Math.max(0, sol.defenderMen - ka);
    const attackerLeft = Math.max(0, sol.attackerMen - kd);
    const r = assaultOutcome(attackerLeft, defenderLeft);
    if (r === 'taken') out.take += p;
    if (r === 'repulsed') out.repulsed += p;
    if (r === 'attacker destroyed' || r === 'both destroyed') out.attackerDestroyed += p;
    out.expectedAttackerLosses += p * (sol.attackerMen - attackerLeft);
    out.expectedDefenderLosses += p * (sol.defenderMen - defenderLeft);
  }));
  return out;
}
