import {
  BonanzaPool,
  DEFAULT_CONFIG,
  RevShareLedger,
  Round,
  mulberry32,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { STRATEGY_SET } from "./strategies.js";

/**
 * What happens to the player experience if the bonanza is removed and its two
 * rake points are folded into the rakeback stream instead?
 *
 * The in-game 95% is untouched by that move — the jackpot and the stream are
 * both player money carved off the same rake — so the question is purely about
 * the SHAPE of the returned 4%: one ~thousand-entry lottery ticket versus a
 * steady drip. This measures both shapes under identical rounds.
 */

interface Scenario {
  name: string;
  bonanzaPct: number;
  revSharePct: number;
}

const SCENARIOS: Scenario[] = [
  { name: "current: 2% bonanza + 2% rakeback", bonanzaPct: 0.02, revSharePct: 0.02 },
  { name: "no bonanza: 0% + 4% rakeback", bonanzaPct: 0.0, revSharePct: 0.04 },
  { name: "halfway: 1% bonanza + 3% rakeback", bonanzaPct: 0.01, revSharePct: 0.03 },
];

const ROUNDS = 120_000;
const SEED = 20260808;
const POOL_PER_STRAT = 120;

function run(sc: Scenario): void {
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    rake: { bonanza: sc.bonanzaPct, house: 0.02, revShare: sc.revSharePct },
  };
  const rng = mulberry32(SEED);

  const population: { id: number; def: (typeof STRATEGY_SET)[number] }[] = [];
  STRATEGY_SET.forEach((def) => {
    for (let i = 0; i < POOL_PER_STRAT; i++) population.push({ id: population.length, def });
  });

  const bonanza = new BonanzaPool(config.bonanza);
  const revShare = new RevShareLedger(config.revShare);

  let clockMs = 0;
  let handle = 0;
  let entries = 0;
  let gameReturn = 0;
  let bonanzaFunded = 0;
  let aheadInGame = 0;
  let sumM = 0;
  let sumM2 = 0;
  const firePools: number[] = [];
  const fireGaps: number[] = [];

  const span = config.field.max - config.field.min;
  for (let r = 0; r < ROUNDS; r++) {
    const n = config.field.min + Math.floor(rng.next() * (span + 1));
    const picked: typeof population = [];
    const used = new Set<number>();
    while (picked.length < n) {
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

    handle += res.grossHandle;
    bonanzaFunded += res.toBonanza + res.wipeLeak;
    bonanza.fund(res.toBonanza + res.wipeLeak);
    for (const p of res.players) {
      entries++;
      gameReturn += p.cashedOut;
      const m = p.cashedOut / config.entry;
      if (m >= 1) aheadInGame++;
      sumM += m;
      sumM2 += m * m;
      bonanza.credit(p.id, p.bonanzaTickets);
      revShare.credit(p.id, clockMs);
    }
    revShare.distribute(res.toRevShare, clockMs);
    const fire = bonanza.roll(rng);
    if (fire) {
      firePools.push(fire.amount);
      fireGaps.push(fire.roundsSinceLast);
    }
    clockMs += res.durationMs;
  }

  const entry = config.entry;
  const days = clockMs / 86_400_000;
  const meanM = sumM / entries;
  const varGame = sumM2 / entries - meanM * meanM;

  // Jackpot variance per entry, from what the sim actually produced. One entry
  // holds `t` of `T` circulating tickets when a pool of X fires with per-round
  // probability p. Aggregated over the whole run this reduces to:
  //   Var ≈ E[bonanza return per entry] × (mean pool / entry)
  // because the pool is enormous relative to the per-entry stake and the win
  // probability is correspondingly tiny — classic lottery variance p·X² with
  // p·X held fixed at the funded rake point(s).
  const bonanzaRtp = entries ? bonanzaFunded / (entries * entry) : 0;
  const meanPool = firePools.length
    ? firePools.reduce((a, b) => a + b, 0) / firePools.length
    : 0;
  const varBonanza = bonanzaRtp * (meanPool / entry);

  const revRtp = sc.revSharePct / 0.06 > 0 ? sc.revSharePct : 0; // funded = rake pt, by construction
  // Rakeback is near-deterministic for a steady player (a share of every
  // round's handle), so its variance contribution is ~0.

  const sortedPools = [...firePools].sort((a, b) => a - b);
  const med = (a: number[]): number => (a.length ? a[Math.floor(a.length / 2)]! : 0);

  console.log(`\n  ${sc.name}`);
  console.log("  " + "-".repeat(78));
  console.log(
    `    RTP: ${((gameReturn / (entries * entry)) * 100).toFixed(2)}% in-game` +
      ` + ${(bonanzaRtp * 100).toFixed(2)}% bonanza + ${(revRtp * 100).toFixed(2)}% rakeback` +
      ` = ${((gameReturn / (entries * entry) + bonanzaRtp + revRtp) * 100).toFixed(2)}%`,
  );
  console.log(
    `    variance per entry (multiple²): in-game ${varGame.toFixed(2)}` +
      ` + jackpot ${varBonanza.toFixed(2)} = ${(varGame + varBonanza).toFixed(2)}` +
      `   (stdev ${(Math.sqrt(varGame + varBonanza)).toFixed(2)}×)`,
  );
  console.log(
    `    finish a round ahead (in-game): ${((aheadInGame / entries) * 100).toFixed(1)}%`,
  );
  if (firePools.length) {
    console.log(
      `    jackpot: ${firePools.length} fires in ${days.toFixed(0)} sim-days` +
        `   median gap ${med(fireGaps)} rounds` +
        `   median pool ${med(sortedPools).toFixed(1)} ◎ (${(med(sortedPools) / entry).toFixed(0)}× entry)`,
    );
  } else {
    console.log(`    jackpot: none (removed)`);
  }
  console.log(
    `    rakeback stream: ${revShare.distributed.toFixed(1)} ◎ distributed over ${days.toFixed(0)} sim-days` +
      `   (${((revShare.distributed / Math.max(1e-9, days))).toFixed(2)} ◎/day across all holders)`,
  );

  // The passive-income view: a regular playing 50 entries/day at steady state
  // holds a weight share ≈ their share of recent handle. Their daily rakeback
  // is share × revSharePct × daily handle — report it per 50-entry regular.
  const dailyHandle = handle / Math.max(1e-9, days);
  const dailyEntries = entries / Math.max(1e-9, days);
  const regularShare = 50 / dailyEntries;
  console.log(
    `    a 50-entry/day regular at steady state: ` +
      `${(regularShare * sc.revSharePct * dailyHandle).toFixed(3)} ◎/day rakeback` +
      ` (${((regularShare * sc.revSharePct * dailyHandle) / (50 * entry) * 100).toFixed(2)}% of their daily stake)` +
      `, tail if they quit ≈ ${(regularShare * sc.revSharePct * dailyHandle * (config.revShare.halfLifeDays / Math.LN2)).toFixed(2)} ◎`,
  );
}

console.log("=".repeat(84));
console.log("  BONANZA REMOVAL STUDY — same rounds, same 95% in-game, different 4% shape");
console.log("=".repeat(84));
for (const sc of SCENARIOS) run(sc);
console.log("");
