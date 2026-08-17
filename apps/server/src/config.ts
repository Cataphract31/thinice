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
   * FREE MONEY, AND THERE IS NONE. Every wallet used to be granted a demo
   * credit the first time it was seen. That is gone: a balance you did not
   * deposit spends exactly like one you did, so an arcade about to hold real
   * custody cannot mint one at the door. A new wallet starts at nothing.
   *
   * Fixed at 0 rather than defaulted to it, because the box HAD
   * STARTING_BALANCE=5 in its environment -- a default would have been
   * silently overridden by the very deployment it was meant to protect. See
   * the refusal below.
   */
  startingBalanceSol: 0,
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
   * Up to this many PRACTICE bots keep the play-money room alive. 0 — the
   * default — means bots do not exist. Where enabled, they play CONTINUOUSLY
   * (humans present or not, so a visitor always walks into a live game) as
   * full participants: same rake, same pot, same odds per entry. The README's
   * "no hidden bots" promise is enforced by two structural
   * rules: every practice bot is labelled `bot·name` on every
   * surface, and the server REFUSES TO BOOT with bots and banking both on —
   * a bot may never share a table with real money.
   */
  /*
   * No small ceiling. The roster generates names and temperaments, the hazard
   * curve reads crowding as a FRACTION so it is scale-free, and the lattice
   * renderer was built for a thousand cells. What actually bounds this is the
   * box: state is serialised per client five times a second, so cost grows as
   * clients x plates. Measure before raising it on a machine that matters.
   */
  /*
   * PRACTICE BOTS, AND THERE ARE NONE. They minted play money for themselves
   * when broke -- adjustBalance(+1 SOL) -- which is a money printer wearing a
   * costume, and it may not exist within reach of a real ledger.
   *
   * Fixed at 0 for the same reason as the starting balance: the box HAD
   * BOTS=10, so anything short of a hard zero would have kept them running.
   * The bot code below this line is now unreachable by construction and is
   * scheduled for deletion; leaving it wired to a setting was not an option.
   */
  bots: 0,
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

/*
 * THE PLAY-MONEY SETTINGS ARE REFUSED, NOT IGNORED.
 *
 * Both of these were set on the live box. Had they merely been defaulted to
 * zero, that deployment would have carried on minting exactly as before and
 * nothing would have said so -- the failure of a silent default is that it
 * looks identical to success. So an environment still asking for either one
 * stops the server with the reason, and whoever is deploying finds out at
 * boot rather than by reconciling custody against a number nobody paid in.
 */
if (process.env.BOTS && process.env.BOTS !== "0") {
  throw new Error(
    `BOTS=${process.env.BOTS}: practice bots were removed. They minted their own ` +
      "play money, which may not exist near a real ledger. Unset BOTS.",
  );
}

if (process.env.STARTING_BALANCE && process.env.STARTING_BALANCE !== "0") {
  throw new Error(
    `STARTING_BALANCE=${process.env.STARTING_BALANCE}: free starting credit was removed. ` +
      "A wallet funds itself by depositing. Unset STARTING_BALANCE.",
  );
}

// Bots supply at most CONFIG.bots distinct wallets toward the seal minimum.
// A minimum the bots cannot reach alone makes the around-the-clock room
// silently wait for humans forever — worth a loud line at boot, because the
// failure mode at runtime is just a lobby that never seals, with no log.
if (CONFIG.bots > 0 && CONFIG.minEntrants > CONFIG.bots) {
  console.warn(
    `MIN_ENTRANTS=${CONFIG.minEntrants} exceeds BOTS=${CONFIG.bots}: ` +
      "the room cannot seal without humans present.",
  );
}

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
