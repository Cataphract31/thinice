/**
 * Invariant tests for the core claim: in-game RTP must equal (1 - rake) for
 * every cash-out strategy, because balance is a martingale.
 *
 * Each strategy is run against a homogeneous population so there is no
 * cross-strategy interaction to confound the result, with standard errors
 * clustered by round.
 */
import {
  DEFAULT_CONFIG,
  Round,
  drawFieldSize,
  mulberry32,
  totalRake,
  type Entrant,
  type GameConfig,
  type Strategy,
} from "@zinc/engine";
import { neverExit, targetExit, tickExit } from "./strategies.js";

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 400_000,
);

interface Case {
  label: string;
  /** Strategies mixed into every field, in equal proportion. */
  mix: { name: string; strategy: Strategy }[];
  config?: Partial<GameConfig["hazard"]>;
  /**
   * A contrast case that demonstrates a violation on purpose. Reported, but
   * not counted as a failure — otherwise the suite can never exit clean.
   */
  expectViolation?: boolean;
}

const C = (name: string, strategy: Strategy) => ({ name, strategy });

const CASES: Case[] = [
  // Homogeneous fields. These are degenerate by construction — one cohort
  // receives the entire pot every round — so they verify conservation, not
  // per-strategy fairness.
  { label: "all exit 1.2x", mix: [C("1.2x", targetExit(1.2))] },
  { label: "all never exit", mix: [C("never", neverExit)] },

  // Mixed fields are the real test: here a strategy can genuinely take value
  // from another, so any martingale violation shows up as a non-zero z.
  {
    label: "mix: 1.2x vs never",
    mix: [C("1.2x", targetExit(1.2)), C("never", neverExit)],
  },
  {
    label: "mix: 1.2x vs 5x",
    mix: [C("1.2x", targetExit(1.2)), C("5x", targetExit(5))],
  },
  {
    label: "mix: 3-tick vs never",
    mix: [C("3tick", tickExit(3)), C("never", neverExit)],
  },
  {
    label: "mix: 1.2x / 2x / never",
    mix: [C("1.2x", targetExit(1.2)), C("2x", targetExit(2)), C("never", neverExit)],
  },
  {
    label: "mix: 1.2x vs never, no grace",
    mix: [C("1.2x", targetExit(1.2)), C("never", neverExit)],
    config: { graceTicks: 0 },
  },
  // The old demo's behaviour, for contrast: the wipe leak should land almost
  // entirely on whoever stayed longest. This case is EXPECTED to violate.
  {
    label: "mix: 1.2x vs never, NO survivor rule",
    mix: [C("1.2x", targetExit(1.2)), C("never", neverExit)],
    config: { guaranteeSurvivor: false },
    expectViolation: true,
  },
];

interface Measure {
  name: string;
  rtp: number;
  se: number;
}

function run(c: Case): { measures: Measure[]; conserved: number } {
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    hazard: { ...DEFAULT_CONFIG.hazard, ...c.config },
  };
  const rng = mulberry32(20260807);
  const k = c.mix.length;

  const staked = new Array<number>(k).fill(0);
  const returned = new Array<number>(k).fill(0);
  const roundStaked: number[][] = c.mix.map(() => []);
  const roundReturned: number[][] = c.mix.map(() => []);
  let potTotal = 0;
  let paidTotal = 0;

  for (let r = 0; r < ROUNDS; r++) {
    const n = drawFieldSize(config, rng.next());
    const entrants: Entrant[] = [];
    for (let i = 0; i < n; i++) {
      const m = i % k;
      entrants.push({ id: i, strategyId: String(m), strategy: c.mix[m]!.strategy });
    }
    const res = new Round(config, rng, entrants).play();

    const rs = new Array<number>(k).fill(0);
    const rr = new Array<number>(k).fill(0);
    res.players.forEach((p, i) => {
      const m = i % k;
      rs[m]! += config.entry;
      rr[m]! += p.cashedOut;
      paidTotal += p.cashedOut;
    });
    for (let m = 0; m < k; m++) {
      staked[m]! += rs[m]!;
      returned[m]! += rr[m]!;
      roundStaked[m]!.push(rs[m]!);
      roundReturned[m]!.push(rr[m]!);
    }
    potTotal += res.pot;
    paidTotal += res.wipeLeak;
  }

  const measures: Measure[] = c.mix.map((m, i) => {
    const rtp = returned[i]! / staked[i]!;
    let ss = 0;
    const rsArr = roundStaked[i]!;
    const rrArr = roundReturned[i]!;
    for (let j = 0; j < rsArr.length; j++) {
      const u = rrArr[j]! - rtp * rsArr[j]!;
      ss += u * u;
    }
    return { name: m.name, rtp, se: Math.sqrt(ss) / staked[i]! };
  });

  return { measures, conserved: paidTotal / potTotal };
}

const target = 1 - totalRake(DEFAULT_CONFIG);
const padR = (s: string, w: number): string => s.padEnd(w);
const pad = (s: string, w: number): string => s.padStart(w);

console.log("");
console.log("=".repeat(86));
console.log(`  MARTINGALE INVARIANT TEST — ${ROUNDS.toLocaleString()} rounds per case`);
console.log(`  claim: in-game RTP == ${(target * 100).toFixed(2)}% for every strategy`);
console.log("=".repeat(86));
console.log(
  "  " +
    padR("case", 34) +
    padR("cohort", 9) +
    pad("RTP", 10) +
    pad("±2se", 9) +
    pad("z", 9) +
    pad("conserv", 10) +
    pad("", 7),
);
console.log("  " + "-".repeat(84));

let failures = 0;
for (const c of CASES) {
  const { measures, conserved } = run(c);
  // Asserted, not merely printed. This is the suite's headline claim — every
  // lamport in the pot reaches a player or the jackpot — and it was being
  // computed, formatted, captioned "must be 100.000%", and then never checked,
  // so a regression that leaked the pot still exited 0 under "ALL INVARIANTS
  // HOLD". The tolerance is float dust across millions of rounds, nothing more.
  if (Math.abs(conserved - 1) > 1e-9) {
    failures++;
    console.log(
      `  ${padR(c.label, 34)}${padR("POT", 9)}${pad("conservation broken", 28)}` +
        `${pad((conserved * 100).toFixed(6) + "%", 12)}`,
    );
  }
  const rows = measures.map((m) => {
    const diff = m.rtp - target;
    // A homogeneous cohort receives the whole pot deterministically, so its
    // standard error collapses to zero; fall back to an absolute tolerance.
    const z = m.se > 1e-9 ? diff / m.se : 0;
    return { m, z, holds: Math.abs(diff) < 1e-6 || Math.abs(z) < 3 };
  });

  // A real case passes when every cohort holds. A contrast case passes when at
  // least one cohort leaks — asserted at the case level, because the whole
  // point of that case is that the strategies are paid *differently*, so some
  // of its cohorts hold at the in-game RTP and are supposed to. Previously the contrast
  // case was hardcoded to pass, which meant that if the leak it demonstrates
  // ever stopped reproducing the suite would print "?!" and still exit 0.
  const caseOk = c.expectViolation ? rows.some((r) => !r.holds) : rows.every((r) => r.holds);
  if (!caseOk) failures++;

  rows.forEach(({ m, z, holds }, i) => {
    console.log(
      "  " +
        padR(i === 0 ? c.label : "", 34) +
        padR(m.name, 9) +
        pad((m.rtp * 100).toFixed(3) + "%", 10) +
        pad("±" + (2 * m.se * 100).toFixed(3), 9) +
        pad(m.se > 1e-9 ? (z >= 0 ? "+" : "") + z.toFixed(2) + "σ" : "exact", 9) +
        pad(i === 0 ? (conserved * 100).toFixed(3) + "%" : "", 10) +
        pad(c.expectViolation ? (holds ? "fair" : "leaks") : holds ? "ok" : "FAIL", 7),
    );
  });
}

console.log("  " + "-".repeat(84));
console.log(
  "  conserv = share of the pot that reached players or the jackpot; must be 100.000%",
);
console.log(failures === 0 ? "  ALL INVARIANTS HOLD" : `  ${failures} INVARIANT(S) VIOLATED`);
console.log("=".repeat(86));
console.log("");
process.exit(failures === 0 ? 0 : 1);
