/**
 * Deterministic randomness. Every draw the game makes flows through this
 * interface so that a round can be replayed byte-identically by the server,
 * the client, and the simulator from the same seed.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

/**
 * Live-round randomness: 128 bits of state, seeded from 128 bits of entropy.
 *
 * `mulberry32` must never drive a real round, and the reason is worth stating
 * plainly because it is not obvious. Its entire state is 32 bits, and the
 * commit-reveal ceremony publishes sha256 of the seed BEFORE the round runs.
 * A 32-bit seed makes that published hash an oracle: enumerate all 4.3 billion
 * candidates against it — seconds of GPU time, well inside a lobby — and you
 * have the seed, and therefore every elimination before a single plate cracks.
 * The commitment intended to prove fairness becomes the thing that breaks it.
 * A 32-bit stream is also identifiable from a handful of observed draws, so
 * even publishing nothing would not save it.
 *
 * sfc32 closes both: 2^128 candidates cannot be enumerated, and the state
 * cannot be recovered from observed output. It uses only int32 operations,
 * whose results ECMAScript specifies exactly, so a replay in any browser on
 * any platform reproduces the round bit for bit.
 */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;
  const rng: Rng = {
    next(): number {
      const t = (((s0 + s1) | 0) + s3) | 0;
      s3 = (s3 + 1) | 0;
      s0 = s1 ^ (s1 >>> 9);
      s1 = (s2 + (s2 << 3)) | 0;
      s2 = (s2 << 21) | (s2 >>> 11);
      s2 = (s2 + t) | 0;
      return (t >>> 0) / 4294967296;
    },
  };
  // Diffuse the seed before anyone reads it: without this the first few draws
  // still correlate with the raw seed bytes.
  for (let i = 0; i < 12; i++) rng.next();
  return rng;
}

/**
 * Builds the live round RNG from a hex seed. Anything shorter than 32 hex
 * characters is refused rather than silently zero-padded, because a short seed
 * is exactly the brute-forceable case this function exists to prevent.
 */
export function rngFromSeedHex(seedHex: string): Rng {
  if (!/^[0-9a-fA-F]{32,}$/.test(seedHex)) {
    throw new Error(`seed must be at least 128 bits of hex, got "${seedHex}"`);
  }
  const w = (i: number): number => parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return sfc32(w(0), w(1), w(2), w(3));
}

/**
 * A second, independent stream from the same committed seed.
 *
 * The jackpot draw must not come off the round's own stream — that stream's
 * draw count is what replay verification depends on — but it also must not
 * come from an uncommitted source, or the single largest payout in the game
 * is the one thing nobody can check. Tagging the seed words gives a stream
 * that is disjoint from the round's, unpredictable without the seed, and
 * recomputable by any player once the seed is revealed.
 *
 * Purely integer arithmetic and no hashing, so the browser can reproduce it
 * synchronously and exactly.
 */
export function deriveRng(seedHex: string, tag: string): Rng {
  if (!/^[0-9a-fA-F]{32,}$/.test(seedHex)) {
    throw new Error(`seed must be at least 128 bits of hex, got "${seedHex}"`);
  }
  const t = seedFromString(tag);
  const w = (i: number): number => parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return sfc32(
    (w(0) ^ t) >>> 0,
    (w(1) ^ Math.imul(t, 0x9e3779b1)) >>> 0,
    (w(2) ^ Math.imul(t, 0x85ebca6b)) >>> 0,
    (w(3) ^ Math.imul(t, 0xc2b2ae35)) >>> 0,
  );
}

/** Fast non-cryptographic PRNG. Used for bulk simulation, never for live rounds. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Derives a stable 32-bit seed from a string, for naming simulation runs. */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
