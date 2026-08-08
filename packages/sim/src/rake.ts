/**
 * Rake split comparison: 7% (3 bonanza / 2 house / 2 rakeback) versus
 * 6% (2 / 2 / 2).
 *
 * The question is not what the headline RTP is — that is arithmetic, and both
 * land on 98%. The question is what the *player experience* of that 98% is.
 * A percent of handle moved out of the jackpot and back into the game is a
 * percent moved from an extremely rare, enormous payout into the ordinary
 * round-by-round return that nearly every player actually experiences.
 *
 * So this measures the distribution, not the mean: median return, chance of
 * finishing a round ahead, and what the jackpot looks like under each split.
 */
import {
  DEFAULT_CONFIG,
  Round,
  drawFieldSize,
  mulberry32,
  totalRake,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 200_000,
);

const SEVEN: GameConfig = {
  ...DEFAULT_CONFIG,
  rake: { bonanza: 0.03, house: 0.02, revShare: 0.02 },
};
const SIX: GameConfig = {
  ...DEFAULT_CONFIG,
  rake: { bonanza: 0.02, house: 0.02, revShare: 0.02 },
};

interface Stats {
  /** Mean return per 1.0 staked, from in-game play only. */
  inGame: number;
  median: number;
  p25: number;
  p90: number;
  /** Share of entries that finished the round with more than they paid in. */
  pProfit: number;
  /** Standard deviation of the per-entry return. */
  sd: number;
  /** Mean handle per round, in units of entry. */
  perRound: number;
}

function measure(cfg: GameConfig): Stats {
  const rng = mulberry32(90210);
  const returns: number[] = [];
  let entries = 0;

  for (let r = 0; r < ROUNDS; r++) {
    const n = drawFieldSize(cfg, rng.next());
    const entrants: Entrant[] = [];
    for (let i = 0; i < n; i++) {
      const def = STRATEGY_SET[i % STRATEGY_SET.length]!;
      entrants.push({ id: i, strategyId: def.id, strategy: def.strategy });
    }
    const res = new Round(cfg, rng, entrants).play();
    entries += n;
    for (const p of res.players) returns.push(p.cashedOut / cfg.entry);
  }

  const sorted = [...returns].sort((a, b) => a - b);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const varr =
    returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length;
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

  return {
    inGame: mean,
    median: q(0.5),
    p25: q(0.25),
    p90: q(0.9),
    pProfit: returns.filter((x) => x > 1).length / returns.length,
    sd: Math.sqrt(varr),
    perRound: entries / ROUNDS,
  };
}

/**
 * The jackpot side. It is a pure accumulator — funded before it ever pays, so
 * it cannot go insolvent at any accrual rate. The only thing the rate changes
 * is how big it is when it fires and how long it takes to get there.
 */
function jackpot(cfg: GameConfig, perRound: number): {
  perRoundSol: number;
  expectedAtFire: number;
  hoursBetween: number;
  roundsPerDay: number;
} {
  const handle = perRound * cfg.entry;
  const accrual = handle * cfg.rake.bonanza;
  const roundSecs =
    (cfg.timing.lobbyMs + 71 * cfg.timing.tickMs + cfg.timing.resultMs) / 1000;
  const roundsPerDay = 86400 / roundSecs;
  const meanRounds = 1 / cfg.bonanza.fireProb;
  return {
    perRoundSol: accrual,
    expectedAtFire: accrual * meanRounds,
    hoursBetween: (meanRounds * roundSecs) / 3600,
    roundsPerDay,
  };
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);
const padR = (s: string | number, w: number): string => String(s).padEnd(w);
const pct = (x: number): string => (x * 100).toFixed(3) + "%";

console.log("");
console.log("=".repeat(78));
console.log("  RAKE SPLIT — 7% (3/2/2) vs 6% (2/2/2)");
console.log(`  ${ROUNDS.toLocaleString()} rounds each`);
console.log("=".repeat(78));

const rows: [string, GameConfig][] = [
  ["7%  (3 bonanza / 2 house / 2 rakeback)", SEVEN],
  ["6%  (2 bonanza / 2 house / 2 rakeback)", SIX],
];

console.log("");
console.log("  WHERE THE MONEY GOES");
console.log(
  "  " +
    padR("split", 40) +
    pad("in-game", 10) +
    pad("bonanza", 10) +
    pad("rakeback", 10) +
    pad("total", 9) +
    pad("edge", 8),
);
console.log("  " + "-".repeat(86));
for (const [label, cfg] of rows) {
  const inGame = 1 - totalRake(cfg);
  console.log(
    "  " +
      padR(label, 40) +
      pad(pct(inGame), 10) +
      pad(pct(cfg.rake.bonanza), 10) +
      pad(pct(cfg.rake.revShare), 10) +
      pad(pct(inGame + cfg.rake.bonanza + cfg.rake.revShare), 9) +
      pad(pct(cfg.rake.house), 8),
  );
}

console.log("");
console.log("  WHAT A PLAYER ACTUALLY EXPERIENCES  (per 1.00 staked, in-game only)");
console.log(
  "  " +
    padR("split", 40) +
    pad("mean", 9) +
    pad("median", 9) +
    pad("p25", 8) +
    pad("p90", 8) +
    pad("P(win)", 9) +
    pad("sd", 8),
);
console.log("  " + "-".repeat(91));
const stats = new Map<string, Stats>();
for (const [label, cfg] of rows) {
  const s = measure(cfg);
  stats.set(label, s);
  console.log(
    "  " +
      padR(label, 40) +
      pad(s.inGame.toFixed(4), 9) +
      pad(s.median.toFixed(4), 9) +
      pad(s.p25.toFixed(3), 8) +
      pad(s.p90.toFixed(3), 8) +
      pad((s.pProfit * 100).toFixed(2) + "%", 9) +
      pad(s.sd.toFixed(3), 8),
  );
}

console.log("");
console.log("  THE JACKPOT  (entry 0.1 ◎, ~26 players, continuous play)");
console.log(
  "  " +
    padR("split", 40) +
    pad("◎/round", 10) +
    pad("mean pool", 12) +
    pad("fires every", 13),
);
console.log("  " + "-".repeat(76));
for (const [label, cfg] of rows) {
  const j = jackpot(cfg, stats.get(label)!.perRound);
  console.log(
    "  " +
      padR(label, 40) +
      pad(j.perRoundSol.toFixed(4), 10) +
      pad(j.expectedAtFire.toFixed(1) + " ◎", 12) +
      pad(j.hoursBetween.toFixed(1) + " h", 13),
  );
}

// How rare is the jackpot from one player's point of view? Their chance of
// being the winner in any round is 1/field, so this is the honest answer to
// "will I ever see this".
const field = 26;
for (const [label, cfg] of rows) {
  const j = jackpot(cfg, stats.get(label)!.perRound);
  const perEntry = cfg.bonanza.fireProb / field;
  console.log(
    `  ${padR(label, 40)}one entry wins it 1 in ${Math.round(1 / perEntry).toLocaleString()}` +
      `  (${(perEntry * j.expectedAtFire * (1 / cfg.entry)).toFixed(4)} EV per 1.00 staked)`,
  );
}

/*
 * Variance decomposition — the whole point of the change.
 *
 * A jackpot's contribution to variance is p·X², and X is enormous, so it
 * dwarfs everything the game itself does. Moving a point of handle out of it
 * does not shave the tail, it halves it.
 */
console.log("");
console.log("  VARIANCE PER 1.00 STAKED  (where the swing actually comes from)");
console.log(
  "  " + padR("split", 40) + pad("in-game", 11) + pad("jackpot", 11) + pad("total", 11),
);
console.log("  " + "-".repeat(73));
for (const [label, cfg] of rows) {
  const s = stats.get(label)!;
  const j = jackpot(cfg, s.perRound);
  const pWin = cfg.bonanza.fireProb / field;
  const payoff = j.expectedAtFire / cfg.entry; // in units of one stake
  const vGame = s.sd * s.sd;
  const vJack = pWin * payoff * payoff - Math.pow(pWin * payoff, 2);
  console.log(
    "  " +
      padR(label, 40) +
      pad(vGame.toFixed(2), 11) +
      pad(vJack.toFixed(2), 11) +
      pad((vGame + vJack).toFixed(2), 11),
  );
}

console.log("=".repeat(78));
console.log("");
