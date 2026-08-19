export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const MAX_SAFE_LAMPORTS = 9_007_199_254_740_991n;

export function solToLamports(sol) {
  const [whole, frac = ''] = String(sol).split('.');
  if (!/^-?\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`not a SOL amount: ${sol}`);
  if (frac.length > 9) throw new Error(`SOL has at most 9 decimals: ${sol}`);
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0') || 0) * (whole.startsWith('-') ? -1n : 1n);
}

export function lamportsToSol(lamports) {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function applyMultiplier(stakeLamports, multiplier) {
  if (stakeLamports < 0n) throw new Error('stake must not be negative');
  if (!Number.isFinite(multiplier) || multiplier < 0) throw new Error(`bad multiplier: ${multiplier}`);

  const product = Number(stakeLamports) * multiplier;
  if (!Number.isFinite(product) || product > Number(MAX_SAFE_LAMPORTS)) {
    throw new Error(`payout ${product} exceeds exact-integer range; stake is too large`);
  }
  return BigInt(Math.round(product));
}

export const maxBig = (a, b) => (a > b ? a : b);
export const minBig = (a, b) => (a < b ? a : b);
