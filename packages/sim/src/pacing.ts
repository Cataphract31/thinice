/**
 * Pacing diagnostic — the two complaints, measured.
 *
 * 1. "On a crowded round I hear a spam of deaths and the risk number does not
 *    drop." That is the creep term having taken over: once the hazard is
 *    mostly clock, headcount stops moving it. Measured here as RESPONSE — the
 *    percentage the hazard falls when a quarter of the live field dies at a
 *    representative mid-round tick. It should be large.
 *
 * 2. "Three-player rounds are over by tick 10 and feel rushed." A round ends
 *    at one survivor, so a thin field needs almost no deaths. Measured here as
 *    median ticks per field size. It should not collapse as the field shrinks.
 *
 * Neither knob touches return: RTP is set by the rake and by redistribution,
 * and is independent of the hazard schedule. invariants.ts is the proof.
 */
import {
  DEFAULT_CONFIG,
  Round,
  hazardAt,
  mulberry32,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 40_000,
);

/** What shipped before this pass. */
const OLD: GameConfig = {
  ...DEFAULT_CONFIG,
  hazard: {
    ...DEFAULT_CONFIG.hazard,
    creep: 2.2e-5,
    creepPower: 2,
    creepBlend: 0.44,
    thinField: 0,
  },
};

const FIELDS = [3, 5, 8, 12, 18, 26, 34];

/** The engine's own curve, in this file's historical argument order. */
function q(cfg: GameConfig, total: number, live: number, tick: number): number {
  return hazardAt(cfg.hazard, tick, live, total);
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

interface Row {
  field: number;
  median: number;
  p10: number;
  p90: number;
  secs: number;
  /** Median share of the hazard that is crowding rather than clock, over all ticks. */
  crowdShare: number;
  /** Realised drop in the displayed hazard on the tick after a mass shatter. */
  response: number;
}

function measure(cfg: GameConfig, field: number): Row {
  const rng = mulberry32(20260807);
  const ticks: number[] = [];
  const crowdShares: number[] = [];
  // Realised response: on every tick that took out a fifth or more of the live
  // field, how far did the number the player is staring at actually fall by
  // the next tick? This is the complaint, measured directly.
  const responses: number[] = [];

  for (let r = 0; r < ROUNDS; r++) {
    const entrants: Entrant[] = [];
    for (let i = 0; i < field; i++) {
      const def = STRATEGY_SET[i % STRATEGY_SET.length]!;
      entrants.push({ id: i, strategyId: def.id, strategy: def.strategy });
    }
    const res = new Round(cfg, rng, entrants).play();
    ticks.push(res.ticks);
    for (const e of res.events) {
      const h = cfg.hazard;
      const heat = e.liveBefore / field;
      const thin =
        h.thinField > 0
          ? Math.min(1, Math.pow(e.liveBefore / h.thinField, h.thinPower))
          : 1;
      const crowd = h.q0 * Math.pow(heat, h.alpha) * thin;
      const creep =
        h.creep * Math.pow(e.tick, h.creepPower) * (h.creepBlend + (1 - h.creepBlend) * heat);
      crowdShares.push(crowd + creep > 0 ? crowd / (crowd + creep) : 0);

      const after = e.liveBefore - e.killed - e.cashedOut;
      if (e.killed >= 2 && e.killed / e.liveBefore >= 0.2 && after >= 2) {
        const before = q(cfg, field, e.liveBefore, e.tick);
        const next = q(cfg, field, after, e.tick + 1);
        if (before > 0) responses.push((before - next) / before);
      }
    }
  }

  const sorted = [...ticks].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);

  return {
    field,
    median: med,
    p10: quantile(sorted, 0.1),
    p90: quantile(sorted, 0.9),
    secs:
      (med * cfg.timing.tickMs + cfg.timing.lobbyMs + cfg.timing.resultMs) / 1000,
    crowdShare:
      quantile([...crowdShares].sort((a, b) => a - b), 0.5),
    response: responses.length
      ? quantile([...responses].sort((a, b) => a - b), 0.5)
      : 0,
  };
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);

function table(label: string, cfg: GameConfig): void {
  console.log("");
  console.log(`  ${label}`);
  console.log(
    "  " +
      pad("field", 7) +
      pad("p10", 6) +
      pad("median", 8) +
      pad("p90", 6) +
      pad("round", 8) +
      pad("crowd%", 9) +
      pad("response", 10),
  );
  console.log("  " + "-".repeat(54));
  for (const f of FIELDS) {
    const row = measure(cfg, f);
    console.log(
      "  " +
        pad(row.field, 7) +
        pad(row.p10, 6) +
        pad(row.median, 8) +
        pad(row.p90, 6) +
        pad(row.secs.toFixed(0) + "s", 8) +
        pad((row.crowdShare * 100).toFixed(0) + "%", 9) +
        pad("-" + (row.response * 100).toFixed(0) + "%", 10),
    );
  }
}

console.log("");
console.log("=".repeat(70));
console.log("  PACING — round length by field size, and hazard responsiveness");
console.log(`  ${ROUNDS.toLocaleString()} rounds per field size`);
console.log("=".repeat(70));

table("BEFORE  (creep 2.2e-5 pow2 blend .44, no thin-field relief)", OLD);
table("AFTER   (creep 3.7e-7 pow3 blend .22, thin-field 9)", DEFAULT_CONFIG);

for (const [f, p] of [
  [12, 0.9],
  [14, 1.0],
] as const) {
  table(`  thin-field ${f} / power ${p}`, {
    ...DEFAULT_CONFIG,
    hazard: { ...DEFAULT_CONFIG.hazard, thinField: f, thinPower: p },
  });
}

// The arc the player actually stares at: median displayed hazard over time.
function arc(label: string, cfg: GameConfig, field: number): void {
  const rng = mulberry32(4242);
  const at = new Map<number, number[]>();
  for (let r = 0; r < 6000; r++) {
    const entrants: Entrant[] = [];
    for (let i = 0; i < field; i++) {
      const def = STRATEGY_SET[i % STRATEGY_SET.length]!;
      entrants.push({ id: i, strategyId: def.id, strategy: def.strategy });
    }
    for (const e of new Round(cfg, rng, entrants).play().events) {
      if (!at.has(e.tick)) at.set(e.tick, []);
      at.get(e.tick)!.push(e.q);
    }
  }
  const cells = [3, 6, 10, 15, 20, 30, 40, 55, 70].map((t) => {
    const v = at.get(t);
    if (!v || v.length < 40) return pad("—", 8);
    return pad((quantile(v.sort((a, b) => a - b), 0.5) * 100).toFixed(2), 8);
  });
  console.log("  " + String(label).padEnd(10) + cells.join(""));
}

console.log("");
console.log(`  DISPLAYED HAZARD %, median, by tick — field of 26`);
console.log(
  "  " +
    "".padEnd(10) +
    [3, 6, 10, 15, 20, 30, 40, 55, 70].map((t) => pad("t" + t, 8)).join(""),
);
console.log("  " + "-".repeat(82));
arc("before", OLD, 26);
arc("after", DEFAULT_CONFIG, 26);

console.log("");
console.log("  crowd%    = median share of hazard coming from headcount, not the clock");
console.log("  response  = hazard drop when a quarter of the live field shatters at once");
console.log("=".repeat(70));
console.log("");
