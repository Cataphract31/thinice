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
  /** Devnet demo credit granted to a wallet the first time it is seen. */
  startingBalanceSol: num("STARTING_BALANCE", 5, 0, 1000),
  /** A round needs this many entrants to seal; below it the lobby rolls over. */
  minEntrants: num("MIN_ENTRANTS", 2, 2, 400),
} as const;

export const LAMPORTS = 1_000_000_000;

export function toLamports(sol: number): number {
  return Math.round(sol * LAMPORTS);
}

export function toSol(lamports: number): number {
  return lamports / LAMPORTS;
}
