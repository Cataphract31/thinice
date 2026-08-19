export interface Rng {
  next(): number;
}

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
  for (let i = 0; i < 12; i++) rng.next();
  return rng;
}

export function rngFromSeedHex(seedHex: string): Rng {
  if (!/^[0-9a-fA-F]{32,}$/.test(seedHex)) {
    throw new Error(`seed must be at least 128 bits of hex, got "${seedHex}"`);
  }
  const w = (i: number): number => parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return sfc32(w(0), w(1), w(2), w(3));
}


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

export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
