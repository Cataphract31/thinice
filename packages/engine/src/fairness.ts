import type { GameConfig } from "./config.js";
import { rngFromSeedHex } from "./rng.js";
import { Round, type CashOutRecord, type Entrant, type RoundResult } from "./round.js";

/**
 * Provably-fair replay.
 *
 * A round is fully determined by (config, seed, entrant order, cash-out
 * schedule): the elimination stream consumes exactly one RNG draw per live
 * player per tick plus one for the spared-survivor pick, so replaying the
 * same seed against the same exit schedule reproduces every event and every
 * balance bit-for-bit.
 *
 * The one requirement this places on live play: player decision strategies
 * must NOT draw from the round's RNG (give bots their own stream), or the
 * draw count diverges and replay breaks. The engine's `DecisionContext.rng`
 * exists for simulations, where replays are not needed.
 *
 * The commit-reveal ceremony built on top of this:
 *   1. before a round seals, publish sha256(tag : roundId : seedHex : rulesHash)
 *   2. run the round
 *   3. reveal the seed; anyone recomputes the hash and replays the round
 *
 * The rules hash is in the commitment for the same reason the seed is: a round
 * replayed under different numbers than it was played under produces different
 * results, so a ceremony that binds only the seed proves nothing about the
 * game you actually played.
 */
export interface RoundRecord {
  /**
   * The round's seed, 128 bits of hex. See `rngFromSeedHex` for why a 32-bit
   * seed is not merely weaker but actively broken under commit-reveal.
   */
  seedHex?: string;
  /**
   * The exact rules the round ran under. Present so a replay uses the numbers
   * that were live at the time rather than whatever the verifier's build
   * happens to ship — otherwise every honest round played before a config
   * change fails verification, which is indistinguishable from cheating.
   */
  config?: GameConfig;
  /** Entrants in seal order. Order matters: it fixes RNG draw order. */
  entrantIds: number[];
  cashOuts: CashOutRecord[];
}

/**
 * A stable string form of the rules, so they can be hashed into a commitment
 * and compared across machines. Keys are sorted at every level: object key
 * order is an accident of construction and must not change the hash.
 */
export function canonicalConfig(config: GameConfig): string {
  const walk = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k])}`)
      .join(",");
    return `{${body}}`;
  };
  return walk(config);
}

export function replayRound(config: GameConfig, rec: RoundRecord): RoundResult {
  // In-tick exits replay as scripted strategy decisions; between-tick manual
  // exits replay as cashOut() calls after the same tick, so the event stream
  // is reproduced exactly, not just the final balances.
  const strategyExitAt = new Map<number, number>();
  const manualByTick = new Map<number, number[]>();
  for (const c of rec.cashOuts) {
    if (c.manual) {
      const list = manualByTick.get(c.tick) ?? [];
      list.push(c.id);
      manualByTick.set(c.tick, list);
    } else {
      strategyExitAt.set(c.id, c.tick);
    }
  }

  const entrants: Entrant[] = rec.entrantIds.map((id) => ({
    id,
    strategyId: "replay",
    strategy: (ctx) => {
      const t = strategyExitAt.get(id);
      return t !== undefined && ctx.tick >= t;
    },
  }));

  // The round's own rules win over the verifier's: see RoundRecord.config.
  const rules = rec.config ?? config;
  // A record with no seed cannot be replayed, and silently substituting seed 0
  // would produce a confident, entirely fictional round.
  if (rec.seedHex === undefined) {
    throw new Error("round record carries no seed: nothing to replay");
  }
  const rng = rngFromSeedHex(rec.seedHex);
  const round = new Round(rules, rng, entrants);
  for (const id of manualByTick.get(0) ?? []) round.cashOut(id);
  while (!round.finished) {
    round.step();
    for (const id of manualByTick.get(round.currentTick) ?? []) round.cashOut(id);
  }
  return round.result();
}

/**
 * Canonical digest of a round's outcome, for comparing a live round against
 * its replay. Balances are rounded to a lamport-scale grid so float noise
 * can never produce a spurious mismatch.
 */
export function outcomeDigest(res: RoundResult): string {
  const players = res.players
    .map((p) => `${p.id}:${p.outcome}:${Math.round(p.cashedOut * 1e9)}`)
    .join("|");
  const events = res.events
    .map((e) => `${e.tick}:${e.killed}:${e.cashedOut}:${Math.round(e.q * 1e9)}`)
    .join("|");
  return `${res.ticks};${players};${events}`;
}
