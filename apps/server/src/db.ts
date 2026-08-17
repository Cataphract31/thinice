import { DatabaseSync } from "node:sqlite";
import { CHARS, CONFIG, toLamports } from "./config.ts";

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
  balance: number;
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
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        wallet         TEXT PRIMARY KEY,
        balance        INTEGER NOT NULL DEFAULT 0,
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

      /* On-chain movements. The PRIMARY KEY on the signature is the entire
         double-credit defence for deposits: a transaction can be presented a
         thousand times and only the first insert credits anything. */
      CREATE TABLE IF NOT EXISTS transfers (
        sig       TEXT PRIMARY KEY,
        wallet    TEXT NOT NULL,
        direction TEXT NOT NULL,
        lamports  INTEGER NOT NULL,
        /* 'ok' rows are settled history; 'pending'/'unknown' mark a withdrawal
           whose on-chain fate was not yet proven when the process last saw it. */
        status    TEXT NOT NULL DEFAULT 'ok',
        at        INTEGER NOT NULL
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
        `INSERT INTO players (wallet, balance, charId, createdAt, seenAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(wallet, 0, charId, now, now);
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

  balanceOf(wallet: string): number {
    const r = this.db.prepare("SELECT balance FROM players WHERE wallet = ?").get(wallet) as
      | { balance: number }
      | undefined;
    return r?.balance ?? 0;
  }

  /**
   * Moves money. Returns false without touching anything if the player cannot
   * cover a debit, which is the one check standing between this and a player
   * entering rounds they have not paid for.
   */
  adjustBalance(wallet: string, deltaLamports: number): boolean {
    if (deltaLamports < 0) {
      const changed = this.db
        .prepare("UPDATE players SET balance = balance + ? WHERE wallet = ? AND balance >= ?")
        .run(deltaLamports, wallet, -deltaLamports);
      return changed.changes > 0;
    }
    this.db
      .prepare("UPDATE players SET balance = balance + ? WHERE wallet = ?")
      .run(deltaLamports, wallet);
    return true;
  }

  /**
   * Debits a withdrawal, refusing to touch UNSETTLED money.
   *
   * The PROFIT portion of a cash-out whose round has not closed is reversible:
   * it is exactly what the crash sweep claws back, so letting it leave
   * on-chain and then reversing it would drive the balance negative on an
   * ordinary restart. The stake portion needs no hold — the sweep returns the
   * stake either way. The balance check and the hold live in ONE statement,
   * because a separate check-then-debit would reopen the race it exists to
   * close (the round crashing between the check and the debit). Returns false
   * untouched when the settled balance cannot cover it.
   */
  debitForWithdrawal(wallet: string, lamports: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE players SET balance = balance - ?
          WHERE wallet = ?
            AND balance - ? >= COALESCE(
              (SELECT SUM(MAX(e.returned - e.staked, 0))
                 FROM entries e JOIN rounds r ON r.id = e.roundId
                WHERE e.wallet = players.wallet AND r.endedAt IS NULL), 0)`,
      )
      .run(lamports, wallet, lamports);
    return changed.changes > 0;
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
        // Net move that leaves the player exactly where they started: give
        // back the stake, take back anything already paid out for this round.
        const delta = o.staked - o.returned;
        const wonBack = o.outcome === "cashed" && o.returned >= o.staked ? 1 : 0;
        this.db
          .prepare(
            `UPDATE players
                SET balance = balance + ?,
                    wagered = wagered - ?,
                    returned = returned - ?,
                    roundsPlayed = roundsPlayed - 1,
                    roundsWon = roundsWon - ?
              WHERE wallet = ?`,
          )
          .run(delta, o.staked, o.returned, wonBack, o.wallet);
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
  takeEntry(roundId: number, wallet: string, stakedLamports: number, seat: number): boolean {
    this.db.exec("BEGIN");
    try {
      const debited = this.db
        .prepare("UPDATE players SET balance = balance + ? WHERE wallet = ? AND balance >= ?")
        .run(-stakedLamports, wallet, stakedLamports);
      if (debited.changes === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(`INSERT INTO entries (roundId, wallet, staked, seat) VALUES (?, ?, ?, ?)`)
        .run(roundId, wallet, stakedLamports, seat);
      this.db
        .prepare(
          "UPDATE players SET roundsPlayed = roundsPlayed + 1, wagered = wagered + ? WHERE wallet = ?",
        )
        .run(stakedLamports, wallet);
      this.db.exec("COMMIT");
      return true;
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
              SET balance = balance + ?, wagered = wagered - ?, roundsPlayed = roundsPlayed - 1
            WHERE wallet = ?`,
        )
        .run(row.staked, row.staked, wallet);
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
    // ONE transaction: the balance credit, the entry row, and the stats move
    // together or not at all. The credit used to be a separate autocommit in
    // the caller — a crash between the two left the entry reading 'in', so
    // the startup sweep re-credited the full stake ON TOP of the payout and
    // then stamped the row 'refunded', hiding the minted money from every
    // later reconciliation. The mirror-image path (takeEntry) was always
    // wrapped; this one simply was not.
    this.db.exec("BEGIN");
    try {
      if (returnedLamports > 0) {
        this.db
          .prepare("UPDATE players SET balance = balance + ? WHERE wallet = ?")
          .run(returnedLamports, wallet);
      }
      // Keyed on the seat: with multi-plate entries a wallet has several rows
      // in one round, and settling "the wallet's row" would settle one plate's
      // money onto whichever row SQLite found first.
      this.db
        .prepare(
          `UPDATE entries SET returned = ?, multiple = ?, ticks = ?, outcome = ?
           WHERE roundId = ? AND wallet = ? AND seat = ?`,
        )
        .run(returnedLamports, multiple, ticks, outcome, roundId, wallet, seat);
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

  /**
   * Records a deposit and credits it in one transaction. Returns false if the
   * signature was already claimed — by this wallet or any other — in which
   * case nothing moves.
   */
  creditDeposit(sig: string, wallet: string, lamports: number): boolean {
    this.db.exec("BEGIN");
    try {
      const ins = this.db
        .prepare(
          "INSERT OR IGNORE INTO transfers (sig, wallet, direction, lamports, at) VALUES (?, ?, 'deposit', ?, ?)",
        )
        .run(sig, wallet, lamports, Date.now());
      if (ins.changes === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare("UPDATE players SET balance = balance + ? WHERE wallet = ?")
        .run(lamports, wallet);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Books a withdrawal INTENT before the transaction is broadcast. Written
   * first so that whatever happens next — landed, failed, or unknowable —
   * there is always a row tying the signature to the debit. A failure that
   * left no record was how a landed-but-unconfirmed transfer could be
   * blind-refunded into a double payout.
   */
  recordWithdrawalIntent(sig: string, wallet: string, lamports: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO transfers (sig, wallet, direction, lamports, at, status) VALUES (?, ?, 'withdraw', ?, ?, 'pending')",
      )
      .run(sig, wallet, lamports, Date.now());
  }

  setTransferStatus(sig: string, status: "ok" | "failed" | "unknown"): void {
    this.db.prepare("UPDATE transfers SET status = ? WHERE sig = ?").run(status, sig);
  }

  /**
   * Reverses a withdrawal PROVEN not to have landed: the re-credit and the
   * status stamp commit together, so a crash can never pay the refund while
   * leaving the row claiming the transfer is still in flight.
   */
  refundWithdrawal(sig: string, wallet: string, lamports: number): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE players SET balance = balance + ? WHERE wallet = ?")
        .run(lamports, wallet);
      this.db.prepare("UPDATE transfers SET status = 'failed' WHERE sig = ?").run(sig);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
