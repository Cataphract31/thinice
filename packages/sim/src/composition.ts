/**
 * Two experiments:
 *
 * 1. Does a strategy's edge survive being popular? In-game return cannot
 *    change, but bonanza payout is share-based, so a cohort's advantage should
 *    dilute as more players copy it.
 *
 * 2. What happens if bonanza tickets accrue flat per entry, like the
 *    revenue-share tickets, instead of scaling with risk exposure?
 */
import {
  BonanzaPool,
  DEFAULT_CONFIG,
  Round,
  drawFieldSize,
  mulberry32,
  type Entrant,
  type GameConfig,
  type Strategy,
} from "@zinc/engine";
import { neverExit, targetExit } from "./strategies.js";

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 150_000,
);

/**
 * The legacy demo's risk-weighted accrual, restated explicitly. DEFAULT_CONFIG
 * is now flat, so spreading a flat patch over it — as this file used to —
 * made "risk-weighted vs flat" run the same rule on both arms and print a
 * structurally zero spread.
 */
const RISK_TICKETS: Partial<GameConfig["bonanza"]> = {
  ticketBase: 1,
  ticketPerRisk: 30,
};

interface Cohort {
  name: string;
  strategy: Strategy;
  share: number;
}

interface Result {
  name: string;
  share: number;
  gameRtp: number;
  bonusRtp: number;
  totalRtp: number;
}

function simulate(cohorts: Cohort[], config: GameConfig): Result[] {
  const rng = mulberry32(20260807);
  const k = cohorts.length;

  // Build a population whose composition matches the requested shares.
  const POP = 700;
  const assign: number[] = [];
  cohorts.forEach((c, i) => {
    const n = Math.round(POP * c.share);
    for (let j = 0; j < n; j++) assign.push(i);
  });

  const staked = new Array<number>(k).fill(0);
  const returned = new Array<number>(k).fill(0);
  const tickets = new Array<number>(k).fill(0);
  let bonanzaFunded = 0;

  const bonanza = new BonanzaPool(config.bonanza);

  for (let r = 0; r < ROUNDS; r++) {
    const n = drawFieldSize(config, rng.next());
    const picked: number[] = [];
    const used = new Set<number>();
    while (picked.length < n) {
      const idx = Math.floor(rng.next() * assign.length);
      if (used.has(idx)) continue;
      used.add(idx);
      picked.push(idx);
    }

    const entrants: Entrant[] = picked.map((idx, i) => ({
      id: i,
      strategyId: String(assign[idx]!),
      strategy: cohorts[assign[idx]!]!.strategy,
    }));

    const res = new Round(config, rng, entrants).play();
    bonanzaFunded += res.toBonanza + res.wipeLeak;

    res.players.forEach((p, i) => {
      const c = assign[picked[i]!]!;
      staked[c]! += config.entry;
      returned[c]! += p.cashedOut;
      tickets[c]! += p.bonanzaTickets;
    });
    bonanza.roll(rng);
  }

  const totalTickets = tickets.reduce((a, b) => a + b, 0);
  return cohorts.map((c, i) => {
    const gameRtp = returned[i]! / staked[i]!;
    const bonusRtp = (bonanzaFunded * (tickets[i]! / totalTickets)) / staked[i]!;
    return {
      name: c.name,
      share: c.share,
      gameRtp,
      bonusRtp,
      totalRtp: gameRtp + bonusRtp + config.rake.revShare,
    };
  });
}

const pct = (x: number, d = 2): string => (x * 100).toFixed(d) + "%";
const pad = (s: string, w: number): string => s.padStart(w);
const padR = (s: string, w: number): string => s.padEnd(w);

console.log("");
console.log("=".repeat(92));
console.log(`  EXPERIMENT 1 — does the "never exit" edge survive becoming popular?`);
console.log(`  ${ROUNDS.toLocaleString()} rounds per mix · flat bonanza tickets (current default)`);
console.log("=".repeat(92));
console.log(
  "  " +
    padR("never-exit share of players", 30) +
    pad("never: bonanza", 16) +
    pad("total", 9) +
    pad("| cautious: bonanza", 21) +
    pad("total", 9),
);
console.log("  " + "-".repeat(90));

for (const share of [0.1, 0.25, 0.5, 0.75, 0.9, 0.98]) {
  const res = simulate(
    [
      { name: "never", strategy: neverExit, share },
      { name: "cautious", strategy: targetExit(1.2), share: 1 - share },
    ],
    DEFAULT_CONFIG,
  );
  const never = res[0]!;
  const cautious = res[1]!;
  console.log(
    "  " +
      padR(`${(share * 100).toFixed(0)}% never / ${((1 - share) * 100).toFixed(0)}% cautious`, 30) +
      pad(pct(never.bonusRtp), 16) +
      pad(pct(never.totalRtp), 9) +
      pad(pct(cautious.bonusRtp), 21) +
      pad(pct(cautious.totalRtp), 9),
  );
}

console.log("  " + "-".repeat(90));
console.log("  total = in-game 95% + bonanza + flat 2% rev-share");
console.log("");

console.log("=".repeat(92));
console.log(`  EXPERIMENT 2 — risk-weighted vs flat bonanza tickets`);
console.log("=".repeat(92));

const MIX: Cohort[] = [
  { name: "exit 1.2x", strategy: targetExit(1.2), share: 0.25 },
  { name: "exit 2x", strategy: targetExit(2), share: 0.25 },
  { name: "exit 5x", strategy: targetExit(5), share: 0.25 },
  { name: "never exit", strategy: neverExit, share: 0.25 },
];

for (const [label, cfg] of [
  [
    "risk-weighted (legacy demo)",
    { ...DEFAULT_CONFIG, bonanza: { ...DEFAULT_CONFIG.bonanza, ...RISK_TICKETS } },
  ],
  ["flat per entry (current)", DEFAULT_CONFIG],
] as [string, GameConfig][]) {
  console.log("");
  console.log(`  ${label}`);
  console.log(
    "  " + padR("cohort", 22) + pad("game", 10) + pad("bonanza", 10) + pad("rev-shr", 10) + pad("TOTAL", 10),
  );
  console.log("  " + "-".repeat(62));
  const res = simulate(MIX, cfg);
  for (const r of res) {
    console.log(
      "  " +
        padR(r.name, 22) +
        pad(pct(r.gameRtp), 10) +
        pad(pct(r.bonusRtp), 10) +
        pad(pct(0.02), 10) +
        pad(pct(r.totalRtp), 10),
    );
  }
  const spread =
    Math.max(...res.map((r) => r.totalRtp)) - Math.min(...res.map((r) => r.totalRtp));
  console.log("  " + "-".repeat(62));
  console.log(`  spread across strategies: ${(spread * 100).toFixed(3)} pts`);
}

console.log("");
console.log("=".repeat(92));
console.log("");
