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
 *   1. before a round seals, publish sha256(tag : roundId : secret : rulesHash)
 *   2. seal the lobby, draw the seal nonce, DERIVE the seed the round runs on
 *      from (secret, sealNonce, entrant order) — see `roundSeedPreimage`
 *   3. run the round
 *   4. reveal the secret and the nonce; anyone recomputes the commitment,
 *      rebuilds the seed from the recorded entrant list, and replays
 *
 * The rules hash is in the commitment for the same reason the seed is: a round
 * replayed under different numbers than it was played under produces different
 * results, so a ceremony that binds only the seed proves nothing about the
 * game you actually played.
 */
export interface RoundRecord {
  /**
   * The seed the round was actually played on, 128+ bits of hex. See
   * `rngFromSeedHex` for why a 32-bit seed is not merely weaker but actively
   * broken under commit-reveal.
   *
   * NOT the value that hashes to the commitment: that is the SECRET, revealed
   * alongside the round, and this is what `roundSeedPreimage` derives from it
   * once the entrant list is final. The two were one field until the entrant
   * set turned out to be unbound — see `sealNonce`.
   */
  seedHex?: string;
  /**
   * Entropy drawn at the moment the lobby sealed: after the entrant list was
   * final, before the first roll.
   *
   * WHY THE SEED IS NOT SIMPLY THE COMMITTED SECRET. Elimination consumes one
   * draw per live player in array order and the hazard curve reads live/total,
   * so who dies is a pure function of the seed, the entrant ORDER and the
   * entrant COUNT. A seed known for the whole lobby therefore hands whoever
   * holds it a free choice of winner: reorder two joins, add or drop one seat,
   * and the round reshuffles to order — while the replay still verifies
   * perfectly, because the record faithfully states the order that was used.
   * That needs no seed grinding at all; one honest seed is enough.
   *
   * Drawing this after the lobby seals REMOVES the choice rather than
   * detecting it: while the entrant set is being decided the seed does not
   * exist yet. Absent on rounds played before this ceremony, which replay from
   * `seedHex` directly.
   */
  sealNonce?: string;
  /**
   * Set on a round the server could not finish — a crash, or a throw inside
   * the tick loop. It carries a revealed seed and an entrant list so the
   * commitment can still be checked, but there is no completed round to replay
   * and no outcome to compare against. A verifier must say "nothing to replay"
   * rather than "mismatch": a round that published a commitment, ran, moved
   * real money and can then never be checked at all is the failure this field
   * exists to close.
   */
  interrupted?: boolean;
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
 * WHAT THE ROUND'S SEED IS A HASH OF, once the lobby has sealed.
 *
 * `sha256` of this string, and the round runs on the first 128 bits of it.
 * Three fields, and each closes something the commitment alone did not:
 *
 *   the SECRET, so the seed is still bound by a hash published before anybody
 *   was sealed in — the ceremony a player watches during the lobby is
 *   unchanged, and the client still pins it;
 *
 *   the SEAL NONCE, drawn after the entrant list was final, so nobody holds a
 *   seed while the set of entrants is still being decided;
 *
 *   the ENTRANT LIST IN DRAW ORDER, so the order the record claims is the
 *   order the round was played in. Change one id, add one, drop one, swap two,
 *   and the seed changes to something nobody chose: the replay then fails
 *   against the published outcome instead of confirming a reshuffle.
 *
 * IT LIVES IN THE ENGINE BECAUSE BOTH SIDES BUILD IT. The server hashes it
 * with node:crypto and the browser with crypto.subtle; two hand-copied
 * versions of this string would be one typo away from telling every honest
 * player their round did not verify.
 */
export function roundSeedPreimage(
  secretHex: string,
  sealNonce: string,
  entrantIds: number[],
): string {
  return `thinice-seed:${secretHex}:${sealNonce}:${entrantIds.join(",")}`;
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
  // Nor can a round that never finished. Replaying one runs it to a conclusion
  // it never reached and then compares that invention against an outcome the
  // server never published — a confident verdict about a round that does not
  // exist. The caller must report "nothing to replay" instead; see
  // RoundRecord.interrupted.
  if (rec.interrupted) {
    throw new Error("round was interrupted before it finished: nothing to replay");
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
