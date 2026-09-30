// Seeded RNG (mulberry32). The only source of randomness in the sim.
// The whole generator state is one uint32, so it can be stored in game
// state, snapshotted for replay, and restored exactly.

export function createRng(seed) {
  let state = seed >>> 0;

  function nextUint32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  return {
    // Float in [0, 1).
    next() {
      return nextUint32() / 4294967296;
    },
    // Integer in [0, n).
    int(n) {
      if (!Number.isInteger(n) || n <= 0) throw new RangeError(`int(n) needs a positive integer, got ${n}`);
      return Math.floor(this.next() * n);
    },
    // True with probability p.
    chance(p) {
      return this.next() < p;
    },
    getState() {
      return state;
    },
    setState(s) {
      state = s >>> 0;
    },
  };
}
