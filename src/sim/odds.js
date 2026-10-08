// Exact odds for the preview. The same numbers the sim rolls against.

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
