// Dice. All rolls go through the seeded RNG.

export function rollD6(rng) {
  return rng.int(6) + 1;
}

// Chance that one d6 rolls `need` or more (need clamped to 1..6).
export function chanceAtLeast(need) {
  const n = Math.min(6, Math.max(1, need));
  return (7 - n) / 6;
}
