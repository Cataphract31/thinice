/**
 * Config sweep. Runs the same population against several hazard/ticket
 * configurations and reports pacing plus the economic invariants side by side,
 * so tuning is a measurement rather than a guess.
 */
import {
  BonanzaPool,
  DEFAULT_CONFIG,
  Round,
  drawFieldSize,
  mulberry32,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

interface Variant {
  label: string;
  config: GameConfig;
}

function variant(label: string, patch: Partial<GameConfig["hazard"]>, ticketPatch?: Partial<GameConfig["bonanza"]>): Variant {
  return {
    label,
    config: {
      ...DEFAULT_CONFIG,
      hazard: { ...DEFAULT_CONFIG.hazard, ...patch },
      bonanza: { ...DEFAULT_CONFIG.bonanza, ...ticketPatch },
    },
  };
}

/*
 * All variants are perturbations of the CURRENT default (cubic creep, 3.7e-7).
 * The previous table carried creep values from the creepPower-2 era — four
 * orders of magnitude hot under a cubic ramp — which pinned every row at the
 * qMax ceiling by ~tick 7 and made the entire comparison degenerate: nine
 * identical rows certifying that no knob mattered.
 */
const VARIANTS: Variant[] = [
  variant("current default", {}),
  variant("no grace", { graceTicks: 0 }),
  variant("creep 1.5e-7 (slower close)", { creep: 1.5e-7 }),
  variant("creep 8e-7 (faster close)", { creep: 8e-7 }),
  variant("old pow2 tuning (2.2e-5 b.44)", { creepPower: 2, creep: 2.2e-5, creepBlend: 0.44 }),
  // Steeper crowding: keeps the 'fewer people = safer' signal strong, which is
  // the mechanic the theme is built on.
  variant("alpha 3.0", { alpha: 3.0 }),
  variant("alpha 1.7", { alpha: 1.7 }),
  variant("q0 9%", { q0: 0.09 }),
  variant("no thin-field relief", { thinField: 0 }),
];

const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 120_000);
const SEED = 20260807;

interface Row {
  label: string;
  medianTicks: number;
  p90Ticks: number;
  p99Ticks: number;
  medianSecs: number;
  gameRtp: number;
  gameSpread: number;
  bonSpread: number;
  wipes: number;
  spares: number;
  avgSurvivorsAtEnd: number;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function runVariant(v: Variant): Row {
  const rng = mulberry32(SEED);
  const config = v.config;

  const population: { id: number; defIdx: number }[] = [];
  STRATEGY_SET.forEach((_, defIdx) => {
    for (let i = 0; i < 60; i++) population.push({ id: population.length, defIdx });
  });

  const staked = new Array<number>(STRATEGY_SET.length).fill(0);
  const returned = new Array<number>(STRATEGY_SET.length).fill(0);
  const tickets = new Array<number>(STRATEGY_SET.length).fill(0);
  const tickCounts: number[] = [];
  let wipes = 0;
  let totalBonanzaFunded = 0;
  let cashedAtEnd = 0;

  const bonanza = new BonanzaPool(config.bonanza);

  for (let r = 0; r < ROUNDS; r++) {
    const fieldSize = drawFieldSize(config, rng.next());
    const picked: typeof population = [];
    const used = new Set<number>();
    while (picked.length < fieldSize) {
      const idx = Math.floor(rng.next() * population.length);
      if (used.has(idx)) continue;
      used.add(idx);
      picked.push(population[idx]!);
    }

    const entrants: Entrant[] = picked.map((p) => ({
      id: p.id,
      strategyId: STRATEGY_SET[p.defIdx]!.id,
      strategy: STRATEGY_SET[p.defIdx]!.strategy,
    }));

    const res = new Round(config, rng, entrants).play();
    tickCounts.push(res.ticks);
    if (res.ending === "wipe") wipes++;
    totalBonanzaFunded += res.toBonanza + res.wipeLeak;
    bonanza.fund(res.toBonanza + res.wipeLeak);

    res.players.forEach((p, i) => {
      const d = picked[i]!.defIdx;
      staked[d]! += config.entry;
      returned[d]! += p.cashedOut;
      tickets[d]! += p.bonanzaTickets;
      if (p.outcome === "cashed") cashedAtEnd++;
    });
    bonanza.roll(rng);
  }

  const sorted = [...tickCounts].sort((a, b) => a - b);
  const rtps = staked.map((s, i) => returned[i]! / s);
  const totalTickets = tickets.reduce((a, b) => a + b, 0);
  const totalStaked = staked.reduce((a, b) => a + b, 0);
  const bonRtps = tickets.map(
    (t, i) => (totalBonanzaFunded * (t / totalTickets)) / staked[i]!,
  );

  return {
    label: v.label,
    medianTicks: quantile(sorted, 0.5),
    p90Ticks: quantile(sorted, 0.9),
    p99Ticks: quantile(sorted, 0.99),
    medianSecs:
      (quantile(sorted, 0.5) * config.timing.tickMs +
        config.timing.lobbyMs +
        config.timing.resultMs) /
      1000,
    gameRtp: returned.reduce((a, b) => a + b, 0) / totalStaked,
    gameSpread: Math.max(...rtps) - Math.min(...rtps),
    bonSpread: Math.max(...bonRtps) - Math.min(...bonRtps),
    wipes,
    spares: 0,
    avgSurvivorsAtEnd: cashedAtEnd / ROUNDS,
  };
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);
const padR = (s: string | number, w: number): string => String(s).padEnd(w);

console.log("");
console.log("=".repeat(104));
console.log(`  HAZARD / PACING SWEEP — ${ROUNDS.toLocaleString()} rounds per variant`);
console.log("=".repeat(104));
console.log(
  "  " +
    padR("variant", 40) +
    pad("med", 6) +
    pad("p90", 6) +
    pad("p99", 6) +
    pad("round", 8) +
    pad("gameRTP", 9) +
    pad("gSprd", 8) +
    pad("bonSprd", 9) +
    pad("wipes", 7) +
    pad("cashers", 9),
);
console.log("  " + "-".repeat(102));

for (const v of VARIANTS) {
  const row = runVariant(v);
  console.log(
    "  " +
      padR(row.label, 40) +
      pad(row.medianTicks, 6) +
      pad(row.p90Ticks, 6) +
      pad(row.p99Ticks, 6) +
      pad(row.medianSecs.toFixed(0) + "s", 8) +
      pad((row.gameRtp * 100).toFixed(2) + "%", 9) +
      pad((row.gameSpread * 100).toFixed(2), 8) +
      pad((row.bonSpread * 100).toFixed(2), 9) +
      pad(row.wipes, 7) +
      pad(row.avgSurvivorsAtEnd.toFixed(1), 9),
  );
}

console.log("  " + "-".repeat(102));
console.log(
  "  med/p90/p99 = round length in ticks · round = median wall-clock incl. lobby+result",
);
console.log(
  "  gSprd = in-game RTP spread across strategies (should be ~0) · bonSprd = bonanza RTP spread (the real lever)",
);
console.log("  cashers = players per round who walked out alive");
console.log("=".repeat(104));
console.log("");
