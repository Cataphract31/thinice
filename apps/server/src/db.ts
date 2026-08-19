import { DatabaseSync } from "node:sqlite";
import { CHARS, CONFIG } from "./config.ts";

/**
 * Persistence.
 *
 * One SQLite file holds everything that has to survive a restart: balances,
 * lifetime stats, and the full audit trail of every round and every entry.
 * Money is stored in LAMPORTS as integers — floats accumulate error and a
 * casino ledger that drifts is a casino ledger that is wrong. The engine
 * works in SOL, so conversion happens only at the boundary.
 *
 * The round and entry tables are the reason this exists at all: they are what
 * makes "total wagered" a fact rather than a number the client remembers.
 */

export interface PlayerRow {
  wallet: string;
  charId: string;
  autoEnabled: number;
  autoTarget: number;
  autoPlates: number;
  roundsPlayed: number;
  roundsWon: number;
  wagered: number;
  returned: number;
  bestMultiple: number;
  createdAt: number;
  seenAt: number;
}

export class Database {
  private db: DatabaseSync;

  constructor(path = CONFIG.dbPath) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.dropLocalBalance();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        wallet         TEXT PRIMARY KEY,
        charId         TEXT    NOT NULL DEFAULT 'chad',
        autoEnabled    INTEGER NOT NULL DEFAULT 0,
        autoTarget     REAL    NOT NULL DEFAULT 2,
        autoPlates     INTEGER NOT NULL DEFAULT 1,
        roundsPlayed   INTEGER NOT NULL DEFAULT 0,
        roundsWon      INTEGER NOT NULL DEFAULT 0,
        wagered        INTEGER NOT NULL DEFAULT 0,
        returned       INTEGER NOT NULL DEFAULT 0,
        bestMultiple   REAL    NOT NULL DEFAULT 0,
        createdAt      INTEGER NOT NULL,
        seenAt         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rounds (
        id        INTEGER PRIMARY KEY,
        commit_   TEXT    NOT NULL,
        seedHex   TEXT    NOT NULL DEFAULT '',
        entrants  INTEGER NOT NULL DEFAULT 0,
        ticks     INTEGER NOT NULL DEFAULT 0,
        bestMult  REAL    NOT NULL DEFAULT 0,
        winner    TEXT,
        winnerCh  TEXT,
        pot       INTEGER NOT NULL DEFAULT 0,
        /* Everything needed to replay the round in a player's own browser:
           the seed, who was in it, and every voluntary exit. Without this the
           "provably fair" claim is a promise instead of a proof. */
        record    TEXT    NOT NULL DEFAULT '',
        digest    TEXT    NOT NULL DEFAULT '',
        startedAt INTEGER NOT NULL,
        endedAt   INTEGER
      );

      CREATE TABLE IF NOT EXISTS entries (
        roundId  INTEGER NOT NULL REFERENCES rounds(id),
        wallet   TEXT    NOT NULL,
        staked   INTEGER NOT NULL,
        returned INTEGER NOT NULL DEFAULT 0,
        multiple REAL    NOT NULL DEFAULT 0,
        ticks    INTEGER NOT NULL DEFAULT 0,
        outcome  TEXT    NOT NULL DEFAULT 'in',
        /* Which plate this player stood on, so their own result can be checked
           against the replay rather than merely asserted by the server. */
        seat     INTEGER NOT NULL DEFAULT 0,
        /* One ROW per PLATE: a wallet may hold several seats in one round. */
        PRIMARY KEY (roundId, wallet, seat)
      );

      CREATE INDEX IF NOT EXISTS entries_wallet ON entries(wallet, roundId DESC);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      /* Wallet session tokens, minted on a successful signature and replayed
         on later connects so Phantom is not asked to sign every socket. A
         bearer credential with exactly the trust level of a guest id, which
         is already a bearer credential for its balance: play-money grade.
         Revisit before real money. */
      CREATE TABLE IF NOT EXISTS wallet_tokens (
        wallet TEXT PRIMARY KEY,
        token  TEXT NOT NULL,
        at     INTEGER NOT NULL
      );
    `);

  }

  /**
   * Finds a player, creating them at ZERO if new.
   *
   * There is no starting credit. A wallet funds itself by depositing, and
   * until it does it owns nothing -- which is the only balance an arcade
   * holding real custody can honestly hand to somebody who has paid nothing.
   * Read-only for existing rows: this runs on every broadcast for every
   * session, and stamping seenAt here was a disk write 20 times a second per
   * player. Presence is stamped by `touch`, at connect and join.
   */
  /*
   * THE BALANCE COLUMN GOES, AND IT HAS TO GO RATHER THAN JUST STOP BEING USED.
   *
   * Money lives in the arcade's double-entry ledger now (see arcade.ts). A
   * `players.balance` column left sitting in the file would be a second answer
   * to "what does this wallet own" -- stale from the moment the first stake
   * moves, and readable by anyone who writes the obvious query. Two sources of
   * truth is the exact disease being cured here, and a disused one is worse
   * than an active one because nothing keeps it honest.
   *
   * Existing databases are playtest data with no real money behind them, so
   * whatever the column says is simply dropped rather than reconciled.
   */
  private dropLocalBalance(): void {
    const cols = this.db.prepare("PRAGMA table_info(players)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "balance")) return;
    this.db.exec("ALTER TABLE players DROP COLUMN balance");
  }

  /**
   * A row for somebody who is only watching, and who therefore gets no row.
   *
   * Spectators are not persisted. They cannot stake -- the ledger has no
   * account for a `guest:` id and refuses -- so a `players` row for one would
   * accumulate forever, carry stats that can never change, and sit in every
   * query about who plays this game. The screen needs a face and a set of
   * zeroes; that is all this is.
   */
  static spectatorRow(wallet: string): PlayerRow {
    return {
      wallet,
      charId: CHARS[Math.floor(Math.random() * CHARS.length)]!,
      autoEnabled: 0,
      autoTarget: 2,
      autoPlates: 1,
      roundsPlayed: 0,
      roundsWon: 0,
      wagered: 0,
      returned: 0,
      bestMultiple: 0,
      createdAt: Date.now(),
      seenAt: Date.now(),
    };
  }

  player(wallet: string): PlayerRow {
    const found = this.db
      .prepare("SELECT * FROM players WHERE wallet = ?")
      .get(wallet) as unknown as PlayerRow | undefined;
    if (found) return found;
    const now = Date.now();
    // Deal a random face rather than taking the column default: the demo has
    // always randomised, but every wallet the SERVER met spawned as chad, so
    // a real lobby was a wall of identical faces until people found the
    // picker. Presentation-only randomness — nothing money-bearing near it.
    const charId = CHARS[Math.floor(Math.random() * CHARS.length)]!;
    this.db
      .prepare(
        `INSERT INTO players (wallet, charId, createdAt, seenAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(wallet, charId, now, now);
    return this.db
      .prepare("SELECT * FROM players WHERE wallet = ?")
      .get(wallet) as unknown as PlayerRow;
  }

  /** Stamps when the player was last here. Cheap, called on connect and join. */
  touch(wallet: string): void {
    this.db
      .prepare("UPDATE players SET seenAt = ? WHERE wallet = ?")
      .run(Date.now(), wallet);
  }

  setChar(wallet: string, charId: string): void {
    this.db.prepare("UPDATE players SET charId = ? WHERE wallet = ?").run(charId, wallet);
  }

  setAuto(wallet: string, enabled: boolean, target: number, plates: number): void {
    this.db
      .prepare(
        "UPDATE players SET autoEnabled = ?, autoTarget = ?, autoPlates = ? WHERE wallet = ?",
      )
      .run(enabled ? 1 : 0, target, plates, wallet);
  }

  /**
   * Crash recovery, run once at startup before any round opens.
   *
   * A round that never reached `closeRound` — the process died mid-round or
   * mid-lobby — is rolled back in full: every entry in it is returned to its
   * stake and its stats reversed, as if the round had never been played.
   *
   * "In full" is the part that took a second pass to get right. Refunding only
   * the entries still marked 'in' looks correct and is not: by then the round
   * may already have settled deaths and cash-outs, and a dead player's stake
   * has been redistributed into the surviving balances. Refund only the
   * survivors' stakes and that redistributed money is simply gone — the house
   * quietly keeps it. So cash-outs are clawed back and deaths are made whole,
   * which is the only reading under which the ledger still balances.
   *
   * The round row keeps its NULL endedAt: it is the audit trail of the crash,
   * and history queries already exclude it.
   */
  /**
   * Crash recovery, run once at startup before any round opens.
   *
   * A round that never reached `closeRound` is rolled back: every unsettled
   * entry is marked refunded and its stats un-counted, as if it never played.
   *
   * WHAT CHANGED WHEN THE MONEY LEFT THIS FILE, because the old behaviour was
   * stranger than it looked. This used to refund the stake AND CLAW BACK any
   * payout already made in the orphaned round -- cash-outs reversed, deaths
   * made whole -- on the grounds that refunding only the survivors would let
   * the house quietly keep the redistributed money. That was the only reading
   * under which a single-sided balance column still added up.
   *
   * It does not apply now and would be wrong if it did. A seat that settled
   * settled: its hold was closed against an idempotent ref and the player was
   * paid, and this game has no power to debit anybody to take it back. What is
   * left open is exactly what is still owed, and `ledger.sweep()` returns it.
   * A player who cashed out before the crash keeps what they were paid, which
   * is what anybody would expect and what the old code went out of its way to
   * undo.
   *
   * The round row keeps its NULL endedAt: it is the audit trail of the crash,
   * and history queries already exclude it.
   *
   * @returns the entries rolled back, for the caller to log
   */
  refundOpenEntries(): number {
    const orphans = this.db
      .prepare(
        `SELECT e.roundId, e.wallet, e.staked, e.returned, e.outcome, e.seat
           FROM entries e JOIN rounds r ON r.id = e.roundId
          WHERE r.endedAt IS NULL AND e.outcome <> 'refunded'`,
      )
      .all() as {
      roundId: number;
      wallet: string;
      staked: number;
      returned: number;
      outcome: string;
      seat: number;
    }[];
    if (orphans.length === 0) return 0;
    this.db.exec("BEGIN");
    try {
      for (const o of orphans) {
        const wonBack = o.outcome === "cashed" && o.returned >= o.staked ? 1 : 0;
        this.db
          .prepare(
            `UPDATE players
                SET wagered = wagered - ?,
                    returned = returned - ?,
                    roundsPlayed = roundsPlayed - 1,
                    roundsWon = roundsWon - ?
              WHERE wallet = ?`,
          )
          .run(o.staked, o.returned, wonBack, o.wallet);
        // Per seat, not per wallet: a multi-plate wallet has one row per
        // plate in the orphaned round and each is its own refund.
        this.db
          .prepare(
            `UPDATE entries SET outcome = 'refunded', returned = staked, multiple = 1
              WHERE roundId = ? AND wallet = ? AND seat = ?`,
          )
          .run(o.roundId, o.wallet, o.seat);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return orphans.length;
  }

  /**
   * What a settled seat was owed, for retrying a settlement the ledger missed.
   *
   * Read back from the entry row rather than remembered in the process, so a
   * retry uses the number that was actually recorded for that seat and not one
   * that has been sitting in memory since before the failure.
   */
  owedFor(roundId: number, seat: number): number | null {
    const r = this.db
      .prepare("SELECT returned, outcome FROM entries WHERE roundId = ? AND seat = ?")
      .get(roundId, seat) as { returned: number; outcome: string } | undefined;
    if (!r || r.outcome === "in") return null;
    return r.returned;
  }

  openRound(id: number, commit: string, startedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO rounds (id, commit_, startedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET commit_ = excluded.commit_`,
      )
      .run(id, commit, startedAt);
  }

  /**
   * Takes the stake and records the entry in one commit. Returns false, having
   * changed nothing, if the balance will not cover it.
   *
   * The two halves used to be separate statements. The startup refund sweep
   * can only return stakes it can find in the entries table, so a crash landing
   * between the debit and the insert left money debited with no record of it —
   * silently gone, which is the one thing this ledger may never do.
   */
  /**
   * Record a bought plate. THE MONEY IS ALREADY HELD when this runs.
   *
   * This used to debit `players.balance` in the same transaction and return
   * false when the wallet could not cover it -- the one check standing between
   * the game and a player entering rounds they had not paid for. That check now
   * happens where the money is: `ledger.hold` refuses atomically inside the
   * arcade's own transaction, and the caller does not reach here unless it
   * succeeded. Returning a boolean would now be a lie, because there is nothing
   * left in this method that can fail on affordability.
   */
  takeEntry(roundId: number, wallet: string, stakedLamports: number, seat: number): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`INSERT INTO entries (roundId, wallet, staked, seat) VALUES (?, ?, ?, ?)`)
        .run(roundId, wallet, stakedLamports, seat);
      this.db
        .prepare(
          "UPDATE players SET roundsPlayed = roundsPlayed + 1, wagered = wagered + ? WHERE wallet = ?",
        )
        .run(stakedLamports, wallet);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Reverses a lobby entry that never played: stake back, stats un-counted,
   * row deleted — as if the plate was never bought. Only valid BEFORE the
   * round seals; a sealed round settles through settleEntry or the crash
   * refund, never through here.
   */
  refundLobbyEntry(roundId: number, wallet: string, seat: number): boolean {
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare("SELECT staked FROM entries WHERE roundId = ? AND wallet = ? AND seat = ?")
        .get(roundId, wallet, seat) as { staked: number } | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `UPDATE players
              SET wagered = wagered - ?, roundsPlayed = roundsPlayed - 1
            WHERE wallet = ?`,
        )
        .run(row.staked, wallet);
      this.db
        .prepare("DELETE FROM entries WHERE roundId = ? AND wallet = ? AND seat = ?")
        .run(roundId, wallet, seat);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  settleEntry(
    roundId: number,
    wallet: string,
    seat: number,
    returnedLamports: number,
    multiple: number,
    ticks: number,
    outcome: string,
    won: boolean,
  ): void {
    // ONE transaction: the entry row and the stats move together or not at all.
    //
    // The balance credit that used to ride in here is gone -- the money is in
    // the arcade ledger and is settled against this seat's hold, by a ref that
    // makes paying twice impossible. The old comment here recorded a real bug:
    // crediting outside this transaction let a crash leave the entry reading
    // 'in', so the startup sweep re-credited the stake ON TOP of the payout and
    // then stamped the row 'refunded', hiding minted money from every later
    // reconciliation. An idempotent ref is a stronger fix than a transaction
    // was, because it survives the process dying between the two systems.
    //
    // THE REF PROTECTS THE MONEY. IT DOES NOT PROTECT THE STATS.
    //
    // The `players` update below accumulates -- `returned + ?`, `roundsWon + ?`
    // -- so a seat booked twice pays once and counts twice, which no later
    // reconciliation would catch because the ledger and the entry row would
    // both read correctly while the lifetime totals quietly ran ahead. Nothing
    // calls this twice today: `GameServer.settled` is checked on every path
    // into it. But that guard is a Set in memory, cleared every round, and it
    // is the only thing standing between a second call and inflated stats --
    // a weaker promise than the durable ref the money gets, for no reason
    // other than that nobody wrote the other half.
    //
    // So the guard is written where it survives a restart: the row moves out
    // of 'in' exactly once, and the stats ride on that transition rather than
    // on the caller having remembered.
    this.db.exec("BEGIN");
    try {
      // Keyed on the seat: with multi-plate entries a wallet has several rows
      // in one round, and settling "the wallet's row" would settle one plate's
      // money onto whichever row SQLite found first.
      const moved = this.db
        .prepare(
          `UPDATE entries SET returned = ?, multiple = ?, ticks = ?, outcome = ?
           WHERE roundId = ? AND wallet = ? AND seat = ? AND outcome = 'in'`,
        )
        .run(returnedLamports, multiple, ticks, outcome, roundId, wallet, seat);
      // Already settled, already refunded, or no such seat. Either way this
      // call has nothing left to book, and booking it would be the bug.
      if (Number(moved.changes) === 0) {
        this.db.exec("ROLLBACK");
        return;
      }
      this.db
        .prepare(
          `UPDATE players
              SET returned = returned + ?,
                  bestMultiple = MAX(bestMultiple, ?),
                  roundsWon = roundsWon + ?
            WHERE wallet = ?`,
        )
        .run(returnedLamports, multiple, won ? 1 : 0, wallet);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Closes a round in one commit: the seed, the outcome, and the replay record.
   *
   * One statement, one transaction — a round is either final and verifiable or
   * it never ended, and the startup sweep refunds anything left in between.
   */
  closeRound(
    id: number,
    seedHex: string,
    entrants: number,
    ticks: number,
    bestMult: number,
    winner: string | null,
    winnerCh: string | null,
    potLamports: number,
    record: string,
    digest: string,
  ): void {
    this.db
      .prepare(
        `UPDATE rounds SET seedHex = ?, entrants = ?, ticks = ?, bestMult = ?,
                           winner = ?, winnerCh = ?, pot = ?, record = ?,
                           digest = ?, endedAt = ?
         WHERE id = ?`,
      )
      .run(
        seedHex,
        entrants,
        ticks,
        bestMult,
        winner,
        winnerCh,
        potLamports,
        record,
        digest,
        Date.now(),
        id,
      );
  }

  lastRoundId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM rounds").get() as { id: number | null };
    return r.id ?? 0;
  }

  /** All-time wins per character, for the team tally. */
  teamWins(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT winnerCh, COUNT(*) AS n FROM rounds WHERE winnerCh IS NOT NULL GROUP BY winnerCh")
      .all() as { winnerCh: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.winnerCh] = r.n;
    return out;
  }

  /**
   * A player's own recent rounds, newest first — one row per ROUND, with the
   * wallet's plates aggregated. `seats` is comma-joined so the client can
   * check every one of its plates against the replay, and `multiple` is the
   * blended total-out over total-in, which is what the player actually made.
   */
  historyFor(wallet: string, limit = 40): {
    roundId: number;
    entrants: number;
    ticks: number;
    bestMult: number;
    commit: string;
    seedHex: string;
    returned: number;
    staked: number;
    plates: number;
    anyBanked: number;
    winnerCh: string | null;
    winner: string | null;
    record: string;
    digest: string;
    seats: string;
  }[] {
    return this.db
      .prepare(
        /* "commit" is a reserved word; unquoted it is a syntax error. */
        `SELECT r.id AS roundId, r.entrants, r.ticks, r.bestMult, r.commit_ AS "commit",
                r.seedHex, r.winnerCh, r.winner, r.record, r.digest,
                SUM(e.returned) AS returned, SUM(e.staked) AS staked,
                COUNT(*) AS plates,
                MAX(CASE WHEN e.returned > 0 THEN 1 ELSE 0 END) AS anyBanked,
                GROUP_CONCAT(e.seat) AS seats
           FROM rounds r
           JOIN entries e ON e.roundId = r.id
          WHERE e.wallet = ? AND r.endedAt IS NOT NULL
          GROUP BY r.id
          ORDER BY r.id DESC LIMIT ?`,
      )
      .all(wallet, limit) as never;
  }

  /** Mints/rotates the wallet's session token. */
  setAuthToken(wallet: string, token: string): void {
    this.db
      .prepare(
        "INSERT INTO wallet_tokens (wallet, token, at) VALUES (?, ?, ?) " +
          "ON CONFLICT(wallet) DO UPDATE SET token = excluded.token, at = excluded.at",
      )
      .run(wallet, token, Date.now());
  }

  authTokenOf(wallet: string): string | null {
    const r = this.db
      .prepare("SELECT token FROM wallet_tokens WHERE wallet = ?")
      .get(wallet) as { token: string } | undefined;
    return r?.token ?? null;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
