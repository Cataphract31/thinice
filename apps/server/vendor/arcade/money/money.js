/**
 * Integer lamport math, for every game in the arcade.
 *
 * Money is BigInt lamports end to end. Floats are for multipliers and display
 * only -- a payout is never carried as a float, because 0.1 + 0.2 problems in
 * a settlement path are how an operator loses money slowly and invisibly.
 *
 * THIS FILE IS THE ONLY COPY, WHICH IT HAD NOT BEEN.
 * ------------------------------------------------
 * Barrows, Pyramid Plunder and Wilderness each carried their own, kept in step
 * by hand; two were byte-identical and the third differed only in its header
 * comment, which said so out loud: "a VERBATIM COPY ... a drift is a failing
 * test rather than a silent disagreement".
 *
 * That header also named the real obstacle, and it was not laziness. The served
 * tree drops the `games/` segment that exists on disk -- `/barrows/web/app.js`
 * is `games/barrows/web/app.js` -- so a relative path out of a game is off by
 * exactly one level and cannot be written to work in both places. There was no
 * way to spell this import, so it was copied instead.
 *
 * The spelling is `#arcade/money/money.js`: a Node subpath import (see the
 * repo's package.json `imports`) that the browser resolves through the import
 * map on each game's pages. One name, both runtimes, no build step. A
 * specifier like this THROWS in a browser with no map rather than silently
 * resolving to something else, so a page that forgets the map fails loudly on
 * first load instead of subtly later.
 *
 * Two tables agreeing about lamports is not a nice-to-have: the verifier page
 * and the server must compute the same number or a player is told their own
 * settlement was wrong.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Largest lamport value that still multiplies exactly in a double.
 * 2^53 - 1; beyond this, `Number(lamports) * multiplier` starts lying.
 */
export const MAX_SAFE_LAMPORTS = 9_007_199_254_740_991n;

/** @param {number|string} sol */
export function solToLamports(sol) {
  const [whole, frac = ''] = String(sol).split('.');
  if (!/^-?\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`not a SOL amount: ${sol}`);
  if (frac.length > 9) throw new Error(`SOL has at most 9 decimals: ${sol}`);
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0') || 0) * (whole.startsWith('-') ? -1n : 1n);
}

/** @param {bigint} lamports */
export function lamportsToSol(lamports) {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Apply a payout multiplier to a stake, exactly and reproducibly.
 *
 * Rounds half-up to the nearest lamport. Sub-lamport residue is unavoidable
 * (lamports are the atomic unit) but it is bounded at 0.5 lamport per
 * settlement, i.e. 5e-10 SOL -- eleven orders of magnitude below the 0.1% that
 * BARROWS.md 3.3 warns rounding can cost, and it does not accumulate because
 * the multiplier itself is never rounded.
 *
 * @param {bigint} stakeLamports
 * @param {number} multiplier full-precision, straight from the table
 * @returns {bigint}
 */
export function applyMultiplier(stakeLamports, multiplier) {
  if (stakeLamports < 0n) throw new Error('stake must not be negative');
  if (!Number.isFinite(multiplier) || multiplier < 0) throw new Error(`bad multiplier: ${multiplier}`);

  const product = Number(stakeLamports) * multiplier;
  if (!Number.isFinite(product) || product > Number(MAX_SAFE_LAMPORTS)) {
    throw new Error(`payout ${product} exceeds exact-integer range; stake is too large`);
  }
  return BigInt(Math.round(product));
}

/** @param {bigint} a @param {bigint} b */
export const maxBig = (a, b) => (a > b ? a : b);
export const minBig = (a, b) => (a < b ? a : b);
