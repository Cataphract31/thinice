import {
  DEFAULT_CONFIG,
  Round,
  mulberry32,
  type Entrant,
  type Rng,
} from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

/**
 * MULTI-BET STUDY — what happens when one wallet holds k plates in one round?
 *
 * The question behind the feature: does buying several plates in the same
 * round change EV or RTP, and how does its risk profile compare against the
 * only alternative the player actually has — spreading the same k entries
 * across k successive rounds?
 *
 * The structural answer is known before simulating: the engine has no concept
 * of ownership. Deaths roll independently per PLATE, redistribution is
 * pro-rata per PLATE, and each plate's balance is a martingale, so a plate's
 * expected return is 95% of entry no matter who else its owner has standing.
 * k plates = k × the same EV. This study exists to (a) verify that number
 * holds in the presence of multi-plate wallets, for both the wallet and the
 * bystanders, and (b) measure the thing that DOES change: the shape of the
 * risk, because plates in one round are correlated (they rise together on
 * every redistribution, and when one of yours dies your own survivors
 * recover a share of it).
 */

const BLOCKS = 12_000;
const SEED = 20260808;
const KS = [1, 2, 5, 10];

interface Style {
  name: string;
  /** All the wallet's plates exit the first tick the shared multiple hits t. */
  target: number | null; // null = ride to the end
}

const STYLES: Style[] = [
  { name: "cash all at 2.0x", target: 2 },
  { name: "ride to the end", target: null },
];

interface CellResult {
  evPerEntry: number;
  stdevPerEntry: number;
  aheadPct: number;
  wipedPct: number;
  breadthPct: number; // at least one plate banked something
  bystanderEv: number;
}

function backgroundEntrants(rng: Rng, n: number): Entrant[] {
  const out: Entrant[] = [];
  for (let i = 0; i < n; i++) {
    const def = STRATEGY_SET[Math.floor(rng.next() * STRATEGY_SET.length)]!;
    out.push({ id: i, strategyId: def.id, strategy: def.strategy });
  }
  return out;
}

function subjectStrategy(style: Style): Entrant["strategy"] {
  if (style.target === null) return () => false;
  const t = style.target;
  return (ctx) => ctx.multiple >= t;
}

/** k plates in ONE round, alongside a fresh background field. */
function runSame(style: Style, k: number, rng: Rng): CellResult {
  const cfg = DEFAULT_CONFIG;
  let sum = 0;
  let sum2 = 0;
  let ahead = 0;
  let wiped = 0;
  let breadth = 0;
  let bgReturn = 0;
  let bgStaked = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const nBg = 8 + Math.floor(rng.next() * 17);
    const entrants = backgroundEntrants(rng, nBg);
    for (let i = 0; i < k; i++) {
      entrants.push({ id: 1000 + i, strategyId: "subject", strategy: subjectStrategy(style) });
    }
    const res = new Round(cfg, rng, entrants).play();
    let total = 0;
    let banked = 0;
    for (const p of res.players) {
      if (p.id >= 1000) {
        total += p.cashedOut;
        if (p.cashedOut > 0) banked++;
      } else {
        bgReturn += p.cashedOut;
        bgStaked += cfg.entry;
      }
    }
    const m = total / (k * cfg.entry);
    sum += m;
    sum2 += m * m;
    if (m >= 1) ahead++;
    if (total === 0) wiped++;
    if (banked > 0) breadth++;
  }
  const mean = sum / BLOCKS;
  return {
    evPerEntry: mean,
    stdevPerEntry: Math.sqrt(Math.max(0, sum2 / BLOCKS - mean * mean)),
    aheadPct: (ahead / BLOCKS) * 100,
    wipedPct: (wiped / BLOCKS) * 100,
    breadthPct: (breadth / BLOCKS) * 100,
    bystanderEv: bgStaked > 0 ? bgReturn / bgStaked : 0,
  };
}

/** The same k entries, one plate in each of k successive rounds. */
function runSpread(style: Style, k: number, rng: Rng): CellResult {
  const cfg = DEFAULT_CONFIG;
  let sum = 0;
  let sum2 = 0;
  let ahead = 0;
  let wiped = 0;
  let breadth = 0;
  let bgReturn = 0;
  let bgStaked = 0;
  for (let b = 0; b < BLOCKS; b++) {
    let total = 0;
    let banked = 0;
    for (let r = 0; r < k; r++) {
      const nBg = 8 + Math.floor(rng.next() * 17);
      const entrants = backgroundEntrants(rng, nBg);
      entrants.push({ id: 1000, strategyId: "subject", strategy: subjectStrategy(style) });
      const res = new Round(cfg, rng, entrants).play();
      for (const p of res.players) {
        if (p.id === 1000) {
          total += p.cashedOut;
          if (p.cashedOut > 0) banked++;
        } else {
          bgReturn += p.cashedOut;
          bgStaked += cfg.entry;
        }
      }
    }
    const m = total / (k * cfg.entry);
    sum += m;
    sum2 += m * m;
    if (m >= 1) ahead++;
    if (total === 0) wiped++;
    if (banked > 0) breadth++;
  }
  const mean = sum / BLOCKS;
  return {
    evPerEntry: mean,
    stdevPerEntry: Math.sqrt(Math.max(0, sum2 / BLOCKS - mean * mean)),
    aheadPct: (ahead / BLOCKS) * 100,
    wipedPct: (wiped / BLOCKS) * 100,
    breadthPct: (breadth / BLOCKS) * 100,
    bystanderEv: bgStaked > 0 ? bgReturn / bgStaked : 0,
  };
}

console.log("=".repeat(96));
console.log("  MULTI-BET STUDY — k plates in one round vs the same k entries across k rounds");
console.log(`  ${BLOCKS.toLocaleString()} blocks per cell, background field 8-24, entry ${DEFAULT_CONFIG.entry} SOL, rake ${(DEFAULT_CONFIG.rake.bonanza + DEFAULT_CONFIG.rake.house + DEFAULT_CONFIG.rake.revShare) * 100}%`);
console.log("=".repeat(96));

for (const style of STYLES) {
  console.log(`\n  ${style.name}`);
  console.log(
    "  " +
      "k".padEnd(4) +
      "mode".padEnd(12) +
      "EV/entry".padEnd(11) +
      "stdev".padEnd(9) +
      "ahead%".padEnd(9) +
      "lost-all%".padEnd(11) +
      "banked>=1%".padEnd(12) +
      "bystanders",
  );
  console.log("  " + "-".repeat(88));
  for (const k of KS) {
    const rngA = mulberry32((SEED ^ (k * 7919) ^ (style.target === null ? 0x55aa : 0)) >>> 0);
    const rngB = mulberry32((SEED ^ (k * 104729) ^ (style.target === null ? 0x55aa : 0) ^ 0xbeef) >>> 0);
    const same = runSame(style, k, rngA);
    const spread = runSpread(style, k, rngB);
    for (const [mode, c] of [
      ["same round", same],
      ["k rounds", spread],
    ] as const) {
      console.log(
        "  " +
          String(k).padEnd(4) +
          mode.padEnd(12) +
          c.evPerEntry.toFixed(4).padEnd(11) +
          c.stdevPerEntry.toFixed(3).padEnd(9) +
          c.aheadPct.toFixed(1).padEnd(9) +
          c.wipedPct.toFixed(2).padEnd(11) +
          c.breadthPct.toFixed(1).padEnd(12) +
          c.bystanderEv.toFixed(4),
      );
    }
  }
}
console.log(
  "\n  EV/entry must read ~0.9500 in every row (the 95% in-game RTP), including for the\n" +
    "  bystanders sharing a lattice with a multi-plate wallet — ownership does not exist\n" +
    "  in the engine, so it cannot price anything.\n",
);
