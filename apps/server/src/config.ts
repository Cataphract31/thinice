import { solToLamports } from "../vendor/arcade/money/money.js";

/**
 * Reads a numeric setting, refusing to boot on a value that is not one.
 *
 * `Number("two players")` is NaN, and NaN reaches places where it does real
 * damage silently: a NaN `minEntrants` makes every `seats.size >= min` false,
 * so no round ever seals while players keep being debited into lobbies that
 * roll over forever. Failing loudly at boot is the only safe reading.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${name}="${raw}" is not a number in [${min}, ${max}]`);
  }
  return v;
}

/** Server settings, all overridable by environment variable. See .env.example. */
export const CONFIG = {
  port: num("PORT", 8787, 1, 65535),
  /** Where the SQLite file lives. One file, portable, backed up by copying. */
  dbPath: process.env.DB_PATH ?? "zinc.db",
  /**
   * A round needs this many DISTINCT wallets to seal; below it the lobby rolls
   * over. Distinct, not seats: with multi-plate entries one wallet can fill
   * several seats, and a "PvP round" whose every plate is one person is not a
   * game, it is one player paying rake to pass money between their own hands.
   */
  minEntrants: num("MIN_ENTRANTS", 2, 2, 400),
  /**
   * Plates one wallet may hold in a single round. The ceiling is a fairness
   * ceiling on the LOBBY, not the odds — EV per plate is identical no matter
   * who holds what, because the engine rolls and redistributes per plate and
   * has no concept of ownership at all — but the field is
   * capped, and without a per-wallet limit one whale can fill the lattice and
   * lock everyone else out of the round.
   */
  maxPlatesPerWallet: num("MAX_PLATES_PER_WALLET", 5, 1, 50),
  /**
   * Auto play lapses after this long away from the table, in minutes.
   *
   * Auto is an intent for a sitting, not a standing order. Left permanent, a
   * player who closed the tab with auto on is bought into a live round the
   * instant they reopen the site hours later — money staked before they have
   * even seen the screen, by a decision they made in a session that ended.
   * The window is deliberately wide enough that a refresh, a dropped
   * connection or a phone locking for a minute all keep the setting: those
   * are interruptions to a sitting, not the end of one. 0 disables lapsing.
   *
   * This does NOT touch auto's other job. Auto cash-out is still enforced
   * server side for a player whose connection dies mid-round — that is the
   * promise that auto keeps while you cannot act, and it is untouched here.
   */
  autoLapseMs: num("AUTO_LAPSE_MIN", 10, 0, 1440) * 60_000,
} as const;


/**
 * The character roster. Lives here because both the game (whitelisting what a
 * client may pick) and the database (dealing a random face to a NEW player)
 * need it, and game.ts already imports config — the reverse would be a cycle.
 */
export const CHARS = [
  "chad",
  "soyjak",
  "wojak",
  "ansem",
  "saylor",
  "pepe",
  "chud",
  "bogdanoff",
  "bobo",
  "mumu",
  "milady",
  "sbf",
];

export const LAMPORTS = 1_000_000_000;

/**
 * SOL TO LAMPORTS, THROUGH THE ARCADE'S OWN FUNCTION AND NOT A SECOND ONE.
 *
 * This was `Math.round(sol * LAMPORTS)`, and it was not wrong: measured over
 * 200,000 amounts from 0.001 to 200 SOL it agrees with the arcade's
 * `solToLamports` on every single one, including the `4.35` case the arcade's
 * own test calls out (`4.35 * 1e9` really is 4349999999.999999, and Math.round
 * really does rescue it). No round of Thin Ice was ever mispriced by it.
 *
 * It was still the wrong function to be running. money.js is the file the
 * arcade, the ledger, the verifier page and every other game on this box agree
 * about lamports through, and its header says why that matters: "the verifier
 * page and the server must compute the same number or a player is told their
 * own settlement was wrong." Two implementations that agree today are still
 * two implementations, and this is the one nobody would think to check when
 * the other changed. The copy is byte-identical and vendorcheck.ts says at
 * every boot whether it still is -- see tools/vendor-arcade.mjs.
 *
 * `Number()` at the boundary because this server counts money in `number` end
 * to end -- the database, the protocol and the engine all do -- and converting
 * that is a change to every file rather than to this one. The arithmetic
 * itself happens in BigInt, which is the half that decides anything.
 *
 * `.toFixed(9)` IS LOAD-BEARING AND IS NOT A ROUNDING PREFERENCE. It is the
 * difference between this working and this throwing on nearly every payout.
 *
 * `solToLamports` is written for an EXACT DECIMAL -- a figure somebody typed
 * into a withdrawal box -- and refuses more than nine decimal places, because
 * lamports are the atomic unit and a tenth decimal is a number the arcade
 * cannot honour. Right for its callers, wrong for ours: this is a POT game, so
 * what reaches here is a prize divided among entrants and a balance grown by a
 * multiplier, and those are binary floats. `1/3` prints as 0.3333333333333333
 * and `0.1 + 0.2` as 0.30000000000000004 -- seventeen decimals, refused
 * outright. Found by testing the change rather than by reading it: without
 * this line it would have thrown on the first settlement that was not a round
 * number, which in a pot game is nearly all of them.
 *
 * Nine decimals IS one lamport, so nothing that could have been paid is
 * discarded. It rounds to the nearest lamport exactly as `Math.round(sol *
 * LAMPORTS)` did -- verified identical across 200,000 amounts -- while the
 * conversion itself is now the arcade's.
 */
export function toLamports(sol: number): number {
  return Number(solToLamports(sol.toFixed(9)));
}

export function toSol(lamports: number): number {
  return lamports / LAMPORTS;
}
