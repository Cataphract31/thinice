/**
 * Premise diagnostic.
 *
 * The game's core claim is that risk comes from crowding: fewer people in the
 * shaft means more air. The creep term exists only to stop a round stalling,
 * but if it grows too fast it takes over and the round starts resolving on a
 * timer instead of on headcount, which quietly guts the premise.
 *
 * This measures how much of the danger players actually face is crowding
 * versus clock, so pacing can be tuned without hollowing out the mechanic.
 */
import {
  DEFAULT_CONFIG,
  Round,
  drawFieldSize,
  hazardAt,
  mulberry32,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 60_000,
);

interface Variant {
  label: string;
  patch: Partial<GameConfig["hazard"]>;
}

const VARIANTS: Variant[] = [
  // The shipped configuration, always first, so every historical comparison
  // below is read against what the engine actually runs today.
  { label: "CURRENT DEFAULT", patch: {} },
  // Each historical row carries its FULL historical hazard patch. Patching
  // only `creep` left these inheriting today's cubic ramp and 0.22 blend, so
  // creep hit the qMax ceiling around tick 8 and every "historical" row was
  // actually the same degenerate pinned-at-cap timer — comparisons against a
  // curve that never existed. sweep.ts had already been fixed for this.
  { label: "original demo (c.0007 p1 b.44)", patch: { creep: 0.0007, creepPower: 1, creepBlend: 0.44 } },
  { label: "your tweak (c.0008 p1 b.44)", patch: { creep: 0.0008, creepPower: 1, creepBlend: 0.44 } },
  { label: "my change (c.0012 p1 b.44)", patch: { creep: 0.0012, creepPower: 1, creepBlend: 0.44 } },
  { label: "c.0008 p1 + qMin 4% (floor test)", patch: { creep: 0.0008, creepPower: 1, creepBlend: 0.44, qMin: 0.04 } },
  // Curved creep: negligible while the shaft is busy, sharp once it empties.
  { label: "pow2.0  c 1.3e-5", patch: { creep: 1.3e-5, creepPower: 2 } },
  { label: "pow2.0  c 1.7e-5", patch: { creep: 1.7e-5, creepPower: 2 } },
  { label: "pow2.0  c 2.2e-5", patch: { creep: 2.2e-5, creepPower: 2 } },
  { label: "pow2.0  c 2.8e-5", patch: { creep: 2.8e-5, creepPower: 2 } },
  { label: "pow2.2  c 1.1e-5", patch: { creep: 1.1e-5, creepPower: 2.2 } },
  { label: "pow2.2  c 1.5e-5", patch: { creep: 1.5e-5, creepPower: 2.2 } },
];

interface Row {
  label: string;
  median: number;
  p90: number;
  roundSecs: number;
  /** Share of eliminations that happened while crowding still set the hazard. */
  crowdKillShare: number;
  /** Share of eliminations where the qMin floor was what set the hazard. */
  floorKillShare: number;
  /** Median tick at which creep overtakes crowding. */
  crossover: number;
  /** How much hazard falls when one player leaves, mid-round. Higher = premise intact. */
  elasticity: number;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function analyse(v: Variant): Row {
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    hazard: { ...DEFAULT_CONFIG.hazard, ...v.patch },
  };
  const h = config.hazard;
  const rng = mulberry32(20260807);

  const ticks: number[] = [];
  const crossovers: number[] = [];
  let crowdKills = 0;
  let creepKills = 0;
  let floorKills = 0;

  for (let r = 0; r < ROUNDS; r++) {
    const n = drawFieldSize(config, rng.next());
    const entrants: Entrant[] = [];
    for (let i = 0; i < n; i++) {
      const def = STRATEGY_SET[i % STRATEGY_SET.length]!;
      entrants.push({ id: i, strategyId: def.id, strategy: def.strategy });
    }
    const res = new Round(config, rng, entrants).play();
    ticks.push(res.ticks);

    let crossed = 0;
    for (const e of res.events) {
      const heat = e.liveBefore / n;
      // The crowding term must include thin-field relief — this copy used to
      // omit it, overstating crowding for every sub-thinField headcount and
      // certifying kill-share numbers for a curve the engine does not run.
      const thin =
        h.thinField > 0
          ? Math.min(1, Math.pow(e.liveBefore / h.thinField, h.thinPower))
          : 1;
      const crowd = h.q0 * Math.pow(heat, h.alpha) * thin;
      const creep =
        h.creep * Math.pow(e.tick, h.creepPower) * (h.creepBlend + (1 - h.creepBlend) * heat);
      const raw = crowd + creep;

      if (!crossed && creep > crowd) crossed = e.tick;

      if (e.killed > 0) {
        if (raw < h.qMin) floorKills += e.killed;
        else if (crowd >= creep) crowdKills += e.killed;
        else creepKills += e.killed;
      }
    }
    crossovers.push(crossed || res.ticks);
  }

  // Elasticity: with half the field gone at a representative mid-round tick,
  // how much does hazard drop if one more player walks out?
  const N = 26;
  const midTick = Math.round(quantile([...ticks].sort((a, b) => a - b), 0.5) / 2);
  // The engine's own curve — not a third hand-copy of it.
  const q13 = hazardAt(h, midTick, 13, N);
  const q12 = hazardAt(h, midTick, 12, N);
  const elasticity = q13 > 0 ? (q13 - q12) / q13 : 0;

  const sorted = [...ticks].sort((a, b) => a - b);
  const totalKills = crowdKills + creepKills + floorKills;
  return {
    label: v.label,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    roundSecs:
      (quantile(sorted, 0.5) * config.timing.tickMs +
        config.timing.lobbyMs +
        config.timing.resultMs) /
      1000,
    crowdKillShare: totalKills ? crowdKills / totalKills : 0,
    floorKillShare: totalKills ? floorKills / totalKills : 0,
    crossover: quantile([...crossovers].sort((a, b) => a - b), 0.5),
    elasticity,
  };
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);
const padR = (s: string | number, w: number): string => String(s).padEnd(w);

console.log("");
console.log("=".repeat(100));
console.log(`  PREMISE DIAGNOSTIC — is risk driven by headcount, or by the clock?`);
console.log(`  ${ROUNDS.toLocaleString()} rounds per variant`);
console.log("=".repeat(100));
console.log(
  "  " +
    padR("variant", 32) +
    pad("med", 6) +
    pad("p90", 6) +
    pad("round", 8) +
    pad("crowd%", 9) +
    pad("floor%", 8) +
    pad("cross", 8) +
    pad("elastic", 9),
);
console.log("  " + "-".repeat(98));

for (const v of VARIANTS) {
  const row = analyse(v);
  console.log(
    "  " +
      padR(row.label, 32) +
      pad(row.median, 6) +
      pad(row.p90, 6) +
      pad(row.roundSecs.toFixed(0) + "s", 8) +
      pad((row.crowdKillShare * 100).toFixed(1) + "%", 9) +
      pad((row.floorKillShare * 100).toFixed(1) + "%", 8) +
      pad("t" + row.crossover, 8) +
      pad((row.elasticity * 100).toFixed(1) + "%", 9),
  );
}

console.log("  " + "-".repeat(98));
console.log("  crowd%   = eliminations that happened while crowding set the hazard (higher = premise intact)");
console.log("  floor%   = eliminations driven by the qMin floor rather than either term");
console.log("  cross    = median tick where creep overtakes crowding");
console.log("  elastic  = hazard drop from one more player leaving, mid-round (higher = leaving matters)");
console.log("=".repeat(100));
console.log("");
