/**
 * Reads a numeric setting, refusing to boot on a value that is not one.
 *
 * `Number("two players")` is NaN, and NaN reaches places where it does real
 * damage silently: a NaN `minEntrants` makes every `seats.size >= min` false,
 * so no round ever seals while players keep being debited into lobbies that
 * roll over forever. A NaN starting balance is written into the ledger as
 * every new player's balance. Failing loudly at boot is the only safe reading.
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
   * BANKING=off runs the server as pure play money: no house keypair is ever
   * created, no RPC is touched, and clients are never offered the bank —
   * real multiplayer on the real ledger, with balances that are only points.
   * This is the open-launch mode; the chain comes later or not at all.
   */
  banking: (process.env.BANKING ?? "on").toLowerCase() !== "off",
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

export function toLamports(sol: number): number {
  return Math.round(sol * LAMPORTS);
}

export function toSol(lamports: number): number {
  return lamports / LAMPORTS;
}
