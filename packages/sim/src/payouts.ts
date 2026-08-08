/**
 * Payout shape. What multiples actually occur, how often, and how high the
 * ceiling really goes.
 *
 * This is a UI input as much as an economic one: the hero number's realistic
 * range decides how it should be designed. A game whose number tops out near
 * 3x needs a very different treatment from one that regularly prints 50x.
 *
 * Multiples here are quoted against the 0.1 entry actually paid, not the
 * post-rake starting balance, so 1.00x is genuine break-even.
 */
import { DEFAULT_CONFIG, Round, drawFieldSize, mulberry32, type Entrant } from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 200_000,
);
const config = DEFAULT_CONFIG;

const rng = mulberry32(20260807);

const cashMultiples: number[] = [];
const roundMax: number[] = [];
const lastStanding: number[] = [];
let totalPlayers = 0;
let totalCashed = 0;
const reached: Record<string, number> = {
  "1.0x": 0,
  "1.5x": 0,
  "2x": 0,
  "3x": 0,
  "5x": 0,
  "10x": 0,
  "20x": 0,
};
const thresholds: [string, number][] = [
  ["1.0x", 1],
  ["1.5x", 1.5],
  ["2x", 2],
  ["3x", 3],
  ["5x", 5],
  ["10x", 10],
  ["20x", 20],
];

for (let r = 0; r < ROUNDS; r++) {
  const n = drawFieldSize(config, rng.next());
  const entrants: Entrant[] = [];
  for (let i = 0; i < n; i++) {
    const def = STRATEGY_SET[i % STRATEGY_SET.length]!;
    entrants.push({ id: i, strategyId: def.id, strategy: def.strategy });
  }
  const round = new Round(config, rng, entrants);
  const res = round.play();

  let max = 0;
  let lastAlive: number | null = null;
  for (const p of res.players) {
    totalPlayers++;
    const m = p.cashedOut / config.entry;
    if (p.outcome === "cashed") {
      totalCashed++;
      cashMultiples.push(m);
      if (m > max) max = m;
    }
    // The engine's flag, not a survived-the-final-tick heuristic: a voluntary
    // cash-out on the last tick also has ticksSurvived === res.ticks, and the
    // old predicate let whichever came later in entrant order overwrite the
    // real last-stander — contaminating this table's median toward ordinary
    // final-tick banks.
    if (p.lastStanding) lastAlive = m;
  }
  roundMax.push(max);
  if (lastAlive !== null) lastStanding.push(lastAlive);
  for (const [k, t] of thresholds) if (max >= t) reached[k]!++;
}

function q(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

const sortedCash = [...cashMultiples].sort((a, b) => a - b);
const sortedMax = [...roundMax].sort((a, b) => a - b);
const sortedLast = [...lastStanding].sort((a, b) => a - b);

const pad = (s: string | number, w: number): string => String(s).padStart(w);
const padR = (s: string | number, w: number): string => String(s).padEnd(w);

console.log("");
console.log("=".repeat(84));
console.log(`  PAYOUT SHAPE — ${ROUNDS.toLocaleString()} rounds, mixed strategies`);
console.log(`  multiples quoted against the 0.1 entry paid (1.00x = break even)`);
console.log("=".repeat(84));
console.log("");
console.log(
  `  players who walked out alive: ${((totalCashed / totalPlayers) * 100).toFixed(1)}%` +
    `   (the rest were taken)`,
);
console.log("");
console.log("  CASH-OUT MULTIPLE, across every player who got out");
console.log(
  "    p10 " +
    q(sortedCash, 0.1).toFixed(2) +
    "x   p25 " +
    q(sortedCash, 0.25).toFixed(2) +
    "x   median " +
    q(sortedCash, 0.5).toFixed(2) +
    "x   p75 " +
    q(sortedCash, 0.75).toFixed(2) +
    "x   p90 " +
    q(sortedCash, 0.9).toFixed(2) +
    "x",
);
console.log(
  "    p99 " +
    q(sortedCash, 0.99).toFixed(2) +
    "x   p99.9 " +
    q(sortedCash, 0.999).toFixed(2) +
    "x   max " +
    sortedCash[sortedCash.length - 1]!.toFixed(1) +
    "x",
);
console.log("");
console.log("  BEST MULTIPLE SEEN IN A ROUND (the number a spectator would notice)");
console.log(
  "    median " +
    q(sortedMax, 0.5).toFixed(2) +
    "x   p75 " +
    q(sortedMax, 0.75).toFixed(2) +
    "x   p90 " +
    q(sortedMax, 0.9).toFixed(2) +
    "x   p99 " +
    q(sortedMax, 0.99).toFixed(2) +
    "x   max " +
    sortedMax[sortedMax.length - 1]!.toFixed(1) +
    "x",
);
console.log("");
console.log("  HOW OFTEN A ROUND REACHES...");
for (const [k] of thresholds) {
  const share = reached[k]! / ROUNDS;
  const bar = "█".repeat(Math.round(share * 40));
  console.log(
    "    " +
      padR(k, 7) +
      pad((share * 100).toFixed(2) + "%", 8) +
      "  " +
      pad(share > 0 ? "1 in " + Math.round(1 / share) : "never", 12) +
      "  " +
      bar,
  );
}
console.log("");
if (sortedLast.length) {
  console.log("  LAST PLAYER STANDING takes");
  console.log(
    "    median " +
      q(sortedLast, 0.5).toFixed(2) +
      "x   p90 " +
      q(sortedLast, 0.9).toFixed(2) +
      "x   p99 " +
      q(sortedLast, 0.99).toFixed(2) +
      "x   max " +
      sortedLast[sortedLast.length - 1]!.toFixed(1) +
      "x",
  );
}
console.log("");
console.log("=".repeat(84));
console.log("");
