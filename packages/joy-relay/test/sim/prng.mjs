// Seeded randomness (sfc32). Every choice the simulation makes comes from
// here, so a seed reproduces a run: the same actions in the same order with
// the same outcomes. Nothing else in the sim may call Math.random.
export function createRng(seed) {
  let a = seed >>> 0, b = (seed * 0x9e3779b9) >>> 0, c = 0x6d2b79f5, d = 0xb5297a4d;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return {
    /** [0, 1) */
    float: next,
    /** integer in [0, n) */
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    /** weighted pick over [{ weight, ...}] */
    weighted(items) {
      let total = 0;
      for (const it of items) total += it.weight;
      let r = next() * total;
      for (const it of items) { r -= it.weight; if (r < 0) return it; }
      return items[items.length - 1];
    },
  };
}
