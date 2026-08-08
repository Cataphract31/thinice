import {
  BonanzaPool,
  DEFAULT_CONFIG,
  RevShareLedger,
  Round,
  mulberry32,
  totalRake,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { STRATEGY_SET, type NamedStrategy } from "./strategies.js";

interface Args {
  rounds: number;
  seed: number;
  playersPerStrategy: number;
  minField: number;
  maxField: number;
  halfLifeDays: number | null;
  forfeitOnDeath: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split("=")[1];
  };
  const halfLife = get("halfLife");
  return {
    rounds: Number(get("rounds") ?? 200_000),
    seed: Number(get("seed") ?? 20260807),
    playersPerStrategy: Number(get("pool") ?? 120),
    // The live game runs any lobby from minEntrants up to field.max, and with
    // no bots filling seats a real lobby is usually far below field.min. So
    // the default sweep starts at the server's actual floor, not at the
    // nominal target size — certifying 18-34 while production runs 2-34 is
    // certifying a game nobody plays.
    minField: Number(get("minField") ?? 2),
    maxField: Number(get("maxField") ?? DEFAULT_CONFIG.field.max),
    halfLifeDays: halfLife === undefined ? null : Number(halfLife),
    forfeitOnDeath: argv.includes("--forfeit"),
  };
}

interface Stats {
  def: NamedStrategy;
  entries: number;
  staked: number;
  gameReturn: number;
  bonanzaWon: number;
  revShare: number;
  busts: number;
  lastStanding: number;
  sumMultiple: number;
  sumMultipleSq: number;
  maxMultiple: number;
  sumTicks: number;
  /** Cumulative bonanza tickets earned. Drives the low-variance RTP estimate. */
  ticketsEarned: number;
  /**
   * Per-round staked/returned totals, kept so standard errors can be clustered
   * by round. Entries inside one round share the same eliminations and payouts,
   * so treating them as independent understates the true error by a wide margin.
   */
  roundStaked: number[];
  roundReturned: number[];
}

function newStats(def: NamedStrategy): Stats {
  return {
    def,
    entries: 0,
    staked: 0,
    gameReturn: 0,
    bonanzaWon: 0,
    revShare: 0,
    busts: 0,
    lastStanding: 0,
    sumMultiple: 0,
    sumMultipleSq: 0,
    maxMultiple: 0,
    sumTicks: 0,
    ticketsEarned: 0,
    roundStaked: [],
    roundReturned: [],
  };
}

/**
 * Standard error of a ratio estimator with observations clustered by round,
 * via the usual linearisation: residual per cluster is (returned - R*staked),
 * and Var(R) = sum of squared residuals over squared total staked.
 */
function clusteredStdErr(s: Stats): number {
  const ratio = s.gameReturn / s.staked;
  let ss = 0;
  for (let i = 0; i < s.roundStaked.length; i++) {
    const u = s.roundReturned[i]! - ratio * s.roundStaked[i]!;
    ss += u * u;
  }
  return Math.sqrt(ss) / s.staked;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    bonanza: { ...DEFAULT_CONFIG.bonanza, forfeitOnDeath: args.forfeitOnDeath },
    revShare: {
      ...DEFAULT_CONFIG.revShare,
      halfLifeDays: args.halfLifeDays ?? DEFAULT_CONFIG.revShare.halfLifeDays,
    },
  };

  const rng = mulberry32(args.seed);

  // A stable population, so tickets and revenue share accumulate across rounds
  // the way they would for real returning players.
  const population: { id: number; def: NamedStrategy }[] = [];
  STRATEGY_SET.forEach((def) => {
    for (let i = 0; i < args.playersPerStrategy; i++) {
      population.push({ id: population.length, def });
    }
  });

  // The sampler below draws without replacement, so a field larger than the
  // population would spin forever at 100% CPU. Fail loudly instead.
  if (args.maxField > population.length) {
    throw new Error(
      `maxField ${args.maxField} exceeds population ${population.length} — raise --pool or lower --maxField`,
    );
  }

  const stats = new Map<string, Stats>();
  STRATEGY_SET.forEach((d) => stats.set(d.id, newStats(d)));
  const strategyOfPlayer = new Map<number, string>();
  population.forEach((p) => strategyOfPlayer.set(p.id, p.def.id));

  const bonanza = new BonanzaPool(config.bonanza);
  const revShare = new RevShareLedger(config.revShare);

  let clockMs = 0;
  let totalHandle = 0;
  let houseRevenue = 0;
  let totalWipeLeak = 0;
  let wipeRounds = 0;
  let totalTicks = 0;
  let totalBonanzaFunded = 0;
  const fireGaps: number[] = [];
  const firePools: number[] = [];
  const tickCounts: number[] = [];

  const fieldSpan = args.maxField - args.minField;

  for (let r = 0; r < args.rounds; r++) {
    const fieldSize = args.minField + Math.floor(rng.next() * (fieldSpan + 1));

    // Sample a field without replacement via partial Fisher-Yates.
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
      strategyId: p.def.id,
      strategy: p.def.strategy,
    }));

    const round = new Round(config, rng, entrants);
    const res = round.play();

    totalHandle += res.grossHandle;
    houseRevenue += res.toHouse;
    totalWipeLeak += res.wipeLeak;
    totalTicks += res.ticks;
    tickCounts.push(res.ticks);
    if (res.ending === "wipe") wipeRounds++;

    totalBonanzaFunded += res.toBonanza + res.wipeLeak;
    bonanza.fund(res.toBonanza + res.wipeLeak);

    for (const s of stats.values()) {
      s.roundStaked.push(0);
      s.roundReturned.push(0);
    }

    for (const p of res.players) {
      const s = stats.get(p.strategyId)!;
      s.roundStaked[s.roundStaked.length - 1]! += config.entry;
      s.roundReturned[s.roundReturned.length - 1]! += p.cashedOut;
      s.entries++;
      s.staked += config.entry;
      s.gameReturn += p.cashedOut;
      s.sumTicks += p.ticksSurvived;
      const multiple = p.cashedOut / config.entry;
      s.sumMultiple += multiple;
      s.sumMultipleSq += multiple * multiple;
      if (multiple > s.maxMultiple) s.maxMultiple = multiple;
      if (p.outcome === "dead") s.busts++;
      if (p.lastStanding) s.lastStanding++;
      s.ticketsEarned += p.bonanzaTickets;
      bonanza.credit(p.id, p.bonanzaTickets);
      revShare.credit(p.id, clockMs);
    }

    revShare.distribute(res.toRevShare, clockMs);

    const fire = bonanza.roll(rng);
    if (fire) {
      const sid = strategyOfPlayer.get(fire.winnerId);
      if (sid) stats.get(sid)!.bonanzaWon += fire.amount;
      fireGaps.push(fire.roundsSinceLast);
      firePools.push(fire.amount);
    }

    clockMs += res.durationMs;
  }

  // Revenue share is owed-but-unclaimed; it still counts as returned value.
  for (const p of population) {
    stats.get(p.def.id)!.revShare += revShare.earningsOf(p.id);
  }

  report(config, args, stats, {
    clockMs,
    totalHandle,
    houseRevenue,
    totalWipeLeak,
    wipeRounds,
    totalTicks,
    totalBonanzaFunded,
    fireGaps,
    firePools,
    tickCounts,
    bonanzaPool: bonanza.pool,
    revShare,
  });
}

interface Globals {
  clockMs: number;
  totalHandle: number;
  houseRevenue: number;
  totalWipeLeak: number;
  wipeRounds: number;
  totalTicks: number;
  totalBonanzaFunded: number;
  fireGaps: number[];
  firePools: number[];
  tickCounts: number[];
  bonanzaPool: number;
  revShare: RevShareLedger;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const pct = (x: number, d = 2): string => `${(x * 100).toFixed(d)}%`;
const pad = (s: string | number, w: number): string => String(s).padStart(w);
const padR = (s: string | number, w: number): string => String(s).padEnd(w);
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

function report(
  config: GameConfig,
  args: Args,
  stats: Map<string, Stats>,
  g: Globals,
): void {
  const days = g.clockMs / 86_400_000;
  const rake = totalRake(config);

  console.log("");
  console.log("=".repeat(96));
  console.log("  CRITICAL MASS — ECONOMIC SIMULATION");
  console.log("=".repeat(96));
  console.log(
    `  rounds ${args.rounds.toLocaleString()}   seed ${args.seed}   field ${args.minField}-${args.maxField}` +
      `   population ${args.playersPerStrategy * stats.size}`,
  );
  console.log(
    `  entry ${config.entry} SOL   rake ${pct(rake)} = ${pct(config.rake.bonanza)} bonanza + ` +
      `${pct(config.rake.house)} house + ${pct(config.rake.revShare)} rev-share`,
  );
  console.log(
    `  rev-share half-life ${config.revShare.halfLifeDays || "none"} d   ` +
      `bonanza tickets forfeit on death: ${config.bonanza.forfeitOnDeath}`,
  );
  console.log(
    `  simulated span ${days.toFixed(1)} days   handle ${g.totalHandle.toFixed(1)} SOL   ` +
      `avg ${(g.totalTicks / args.rounds).toFixed(1)} ticks/round`,
  );
  console.log("");

  const ordered = [...stats.values()].sort((a, b) => a.def.id.localeCompare(b.def.id));
  const totStaked = ordered.reduce((a, s) => a + s.staked, 0);
  const totGame = ordered.reduce((a, s) => a + s.gameReturn, 0);
  const totRev = ordered.reduce((a, s) => a + s.revShare, 0);
  const totTickets = ordered.reduce((a, s) => a + s.ticketsEarned, 0);

  // The jackpot fires too rarely for realised wins to converge, so bonanza RTP
  // is estimated from each cohort's share of tickets, which is what actually
  // determines the draw. Realised wins are shown alongside as a sanity check.
  const expectedBonanza = (s: Stats): number =>
    (g.totalBonanzaFunded * (s.ticketsEarned / totTickets)) / s.staked;

  console.log("  RTP BY STRATEGY  (game = in-round returns, then the two player-money streams)");
  console.log("  " + "-".repeat(94));
  console.log(
    "  " +
      padR("strategy", 30) +
      pad("game", 9) +
      pad("bonanza", 9) +
      pad("rev-shr", 9) +
      pad("±2se", 8) +
      pad("TOTAL", 9) +
      pad("bust%", 8) +
      pad("stdev", 7) +
      pad("max×", 8) +
      pad("last-std", 9),
  );
  console.log("  " + "-".repeat(94));

  const stderrOf = clusteredStdErr;

  for (const s of ordered) {
    const game = s.gameReturn / s.staked;
    const bon = expectedBonanza(s);
    const rev = s.revShare / s.staked;
    const avg = s.sumMultiple / s.entries;
    const variance = Math.max(0, s.sumMultipleSq / s.entries - avg * avg);
    console.log(
      "  " +
        padR(s.def.label, 30) +
        pad(pct(game), 9) +
        pad(pct(bon), 9) +
        pad(pct(rev), 9) +
        pad(`±${(2 * stderrOf(s) * 100).toFixed(2)}`, 8) +
        pad(pct(game + bon + rev), 9) +
        pad(pct(s.busts / s.entries, 1), 8) +
        pad(Math.sqrt(variance).toFixed(2), 7) +
        pad(s.maxMultiple.toFixed(1), 8) +
        // Was accumulated and never printed: how often this strategy is the
        // one left standing on the ice.
        pad(pct(s.lastStanding / s.entries, 1), 9),
    );
  }
  console.log("  " + "-".repeat(94));
  console.log(
    "  " +
      padR("ALL PLAYERS", 30) +
      pad(pct(totGame / totStaked), 9) +
      pad(pct(g.totalBonanzaFunded / totStaked), 9) +
      pad(pct(totRev / totStaked), 9) +
      pad(pct((totGame + g.totalBonanzaFunded + totRev) / totStaked), 9),
  );
  console.log("");

  const gameRtps = ordered.map((s) => s.gameReturn / s.staked);
  const spread = Math.max(...gameRtps) - Math.min(...gameRtps);
  console.log("  MARTINGALE CHECK  (theory: in-game RTP is identical for every strategy)");
  console.log(
    `    in-game RTP spread across strategies: ${(spread * 100).toFixed(3)} pts`,
  );
  // If the martingale holds, every deviation from 95% is sampling noise, so
  // these z-scores should look like standard normals rather than a trend.
  const worst = ordered
    .map((s) => ({
      id: s.def.id,
      z: (s.gameReturn / s.staked - (1 - rake)) / stderrOf(s),
    }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  console.log(
    `    largest deviations from ${pct(1 - rake)}, in standard errors: ` +
      worst
        .slice(0, 3)
        .map((w) => `${w.id} ${w.z >= 0 ? "+" : ""}${w.z.toFixed(1)}σ`)
        .join("   "),
  );
  console.log(
    `    theoretical in-game RTP:              ${pct(1 - rake)}   ` +
      `observed mean: ${pct(totGame / totStaked)}`,
  );
  console.log(
    `    total wipes: ${g.wipeRounds.toLocaleString()} of ${args.rounds.toLocaleString()} rounds ` +
      `(${pct(g.wipeRounds / args.rounds, 3)})   leaked ${g.totalWipeLeak.toFixed(2)} SOL ` +
      `= ${pct(g.totalWipeLeak / g.totalHandle, 3)} of handle`,
  );
  console.log("");

  const sortedTicks = [...g.tickCounts].sort((a, b) => a - b);
  console.log("  PACING  (round length in ticks; one tick = " + config.timing.tickMs + "ms)");
  console.log(
    `    median ${quantile(sortedTicks, 0.5)}   p75 ${quantile(sortedTicks, 0.75)}   ` +
      `p90 ${quantile(sortedTicks, 0.9)}   p99 ${quantile(sortedTicks, 0.99)}   ` +
      `max ${sortedTicks[sortedTicks.length - 1]}`,
  );
  const secs = (t: number): string => ((t * config.timing.tickMs) / 1000).toFixed(0);
  console.log(
    `    live phase: median ${secs(quantile(sortedTicks, 0.5))}s   ` +
      `p90 ${secs(quantile(sortedTicks, 0.9))}s   p99 ${secs(quantile(sortedTicks, 0.99))}s`,
  );
  console.log("");

  console.log("  BONANZA");
  console.log(
    `    fires: ${g.fireGaps.length}   mean gap ${mean(g.fireGaps).toFixed(0)} rounds   ` +
      `median gap ${median(g.fireGaps).toFixed(0)}`,
  );
  if (g.firePools.length) {
    const sorted = [...g.firePools].sort((a, b) => a - b);
    console.log(
      `    pool at fire: mean ${mean(g.firePools).toFixed(1)} SOL   ` +
        `median ${median(g.firePools).toFixed(1)}   ` +
        `min ${sorted[0]!.toFixed(1)}   max ${sorted[sorted.length - 1]!.toFixed(1)} SOL`,
    );
    console.log(
      `    as a multiple of one entry: median ${(median(g.firePools) / config.entry).toFixed(0)}×`,
    );
  }
  console.log(`    pool still building at cutoff: ${g.bonanzaPool.toFixed(1)} SOL`);
  console.log("");

  console.log("  HOUSE & REVENUE SHARE");
  console.log(
    `    house revenue: ${g.houseRevenue.toFixed(2)} SOL = ${pct(g.houseRevenue / g.totalHandle)} of handle`,
  );
  console.log(
    `    rev-share distributed: ${g.revShare.distributed.toFixed(2)} SOL   ` +
      `unallocated: ${g.revShare.unallocated.toFixed(4)} SOL`,
  );
  const totalWeight = g.revShare.totalWeight(g.clockMs);
  // Steady state = entry rate × tickets per entry × the decay time constant.
  // The tickets-per-entry factor was missing, so this line under-predicted by
  // exactly the ticket denomination (200×) and read like a ledger leak.
  console.log(
    `    live ticket weight at cutoff: ${totalWeight.toFixed(1)} ` +
      `(steady state predicts ${(
        (args.rounds / Math.max(days, 1e-9)) *
        ((args.minField + args.maxField) / 2) *
        config.revShare.ticketsPerEntry *
        (config.revShare.halfLifeDays > 0
          ? config.revShare.halfLifeDays / Math.LN2
          : days)
      ).toFixed(1)})`,
  );
  console.log("");
  console.log("=".repeat(96));
  console.log("");
}

main();
