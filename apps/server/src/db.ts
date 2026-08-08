import { DatabaseSync } from "node:sqlite";
import { CONFIG, toLamports } from "./config.ts";

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
  roundsPlayed: number;
  roundsWon: number;
  wagered: number;
  returned: number;
  bestMultiple: number;
  bonanzaTickets: number;
  revTickets: number;
  /** Decayed rev-share weight, so a restart does not reset anyone's slice. */
  revWeight: number;
  /** Everything the stream has paid so far, the marker preventing double pays. */
  revClaimed: number;
  revEarned: number;
  /** Lifetime jackpot winnings; paid to the balance, never via a settlement. */
  bonanzaWon: number;
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
        roundsPlayed   INTEGER NOT NULL DEFAULT 0,
        roundsWon      INTEGER NOT NULL DEFAULT 0,
        wagered        INTEGER NOT NULL DEFAULT 0,
        returned       INTEGER NOT NULL DEFAULT 0,
        bestMultiple   REAL    NOT NULL DEFAULT 0,
        bonanzaTickets INTEGER NOT NULL DEFAULT 0,
        revTickets     INTEGER NOT NULL DEFAULT 0,
        revWeight      REAL    NOT NULL DEFAULT 0,
        revClaimed     INTEGER NOT NULL DEFAULT 0,
        revEarned      INTEGER NOT NULL DEFAULT 0,
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
        /* One ROW per PLATE: a wallet may hold several seats in one round.
           The wallet stays in the key because rows from before the seat
           column existed all carry seat 0 and are unique by wallet alone. */
        PRIMARY KEY (roundId, wallet, seat)
      );

      CREATE INDEX IF NOT EXISTS entries_wallet ON entries(wallet, roundId DESC);

      /* Added after the first databases existed; ALTER runs outside this
         block because IF NOT EXISTS does not apply to columns. */

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      /* On-chain movements. The PRIMARY KEY on the signature is the entire
         double-credit defence for deposits: a transaction can be presented a
         thousand times and only the first insert credits anything. */
      CREATE TABLE IF NOT EXISTS transfers (
        sig       TEXT PRIMARY KEY,
        wallet    TEXT NOT NULL,
        direction TEXT NOT NULL,
        lamports  INTEGER NOT NULL,
        at        INTEGER NOT NULL
      );
    `);

    // Additive column migrations for databases created before they existed.
    // SQLite has no ADD COLUMN IF NOT EXISTS, and a duplicate-column error is
    // exactly the "already migrated" case, so it is the one error to swallow.
    for (const sql of [
      "ALTER TABLE entries ADD COLUMN seat INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN bonanzaWon INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(sql);
      } catch (err) {
        if (!/duplicate column/i.test(String(err))) throw err;
      }
    }

    // Multi-plate migration. Databases created before multi-betting carry
    // PRIMARY KEY (roundId, wallet), which structurally forbids a second seat
    // for the same wallet. SQLite cannot alter a primary key, so the table is
    // rebuilt once, in a transaction. Old rows survive verbatim — their
    // pre-seat-column entries are all seat 0 and unique by wallet, which is
    // exactly why wallet stays in the new key.
    const entriesSql = (
      this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'")
        .get() as { sql: string } | undefined
    )?.sql;
    if (entriesSql && /PRIMARY KEY \(roundId, wallet\)/.test(entriesSql)) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE entries RENAME TO entries_old;
        CREATE TABLE entries (
          roundId  INTEGER NOT NULL REFERENCES rounds(id),
          wallet   TEXT    NOT NULL,
          staked   INTEGER NOT NULL,
          returned INTEGER NOT NULL DEFAULT 0,
          multiple REAL    NOT NULL DEFAULT 0,
          ticks    INTEGER NOT NULL DEFAULT 0,
          outcome  TEXT    NOT NULL DEFAULT 'in',
          seat     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (roundId, wallet, seat)
        );
        INSERT INTO entries (roundId, wallet, staked, returned, multiple, ticks, outcome, seat)
          SELECT roundId, wallet, staked, returned, multiple, ticks, outcome, seat FROM entries_old;
        DROP TABLE entries_old;
        CREATE INDEX IF NOT EXISTS entries_wallet ON entries(wallet, roundId DESC);
        COMMIT;
      `);
    }
  }

  /**
   * Finds a player, creating them with the devnet starting credit if new.
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
    this.db
      .prepare(
        `INSERT INTO players (wallet, balance, createdAt, seenAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(wallet, toLamports(CONFIG.startingBalanceSol), now, now);
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

  setChar(wallet: string, charId: string): void {
    this.db.prepare("UPDATE players SET charId = ? WHERE wallet = ?").run(charId, wallet);
  }

  setAuto(wallet: string, enabled: boolean, target: number): void {
    this.db
      .prepare("UPDATE players SET autoEnabled = ?, autoTarget = ? WHERE wallet = ?")
      .run(enabled ? 1 : 0, target, wallet);
  }

  setTickets(wallet: string, bonanza: number, revLifetime: number, revWeight: number): void {
    this.db
      .prepare(
        "UPDATE players SET bonanzaTickets = ?, revTickets = ?, revWeight = ? WHERE wallet = ?",
      )
      .run(Math.round(bonanza), Math.round(revLifetime), revWeight, wallet);
  }

  /**
   * Everyone holding a position in either economy, for restoring the ledgers.
   * `revClaimed > 0` is in here deliberately: a wallet that has been paid
   * rakeback must be restored even if its weight has since decayed away, or
   * the ledger's lifetime total for it restarts below what was already paid.
   */
  allPlayersWithTickets(): PlayerRow[] {
    return this.db
      .prepare(
        `SELECT * FROM players
          WHERE bonanzaTickets > 0 OR revTickets > 0 OR revWeight > 0 OR revClaimed > 0`,
      )
      .all() as unknown as PlayerRow[];
  }

  revClaimed(wallet: string): number {
    const r = this.db.prepare("SELECT revClaimed FROM players WHERE wallet = ?").get(wallet) as
      | { revClaimed: number }
      | undefined;
    return r?.revClaimed ?? 0;
  }

  setRevClaimed(wallet: string, lamports: number): void {
    this.db
      .prepare("UPDATE players SET revClaimed = ? WHERE wallet = ?")
      .run(lamports, wallet);
  }

  /**
   * Settles a jackpot fire: pay the winner, wipe every ticket, and record the
   * pool's new value, all in one commit.
   *
   * These were three separate autocommitted writes. A crash between the payout
   * and the pool write left the winner paid while the restart re-seeded the
   * pool from its stale full value — the house minting a second jackpot out of
   * nothing, the largest single money bug the ledger could have.
   */
  settleBonanza(winner: string | null, lamports: number, poolMeta: string): void {
    this.db.exec("BEGIN");
    try {
      if (winner && lamports > 0) {
        this.db
          .prepare(
            "UPDATE players SET balance = balance + ?, bonanzaWon = bonanzaWon + ? WHERE wallet = ?",
          )
          .run(lamports, lamports, winner);
      }
      this.db.exec("UPDATE players SET bonanzaTickets = 0");
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('bonanzaPool', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(poolMeta);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Credits rakeback and advances the claimed marker together. Split apart, a
   * crash in between pays the money and forgets it was paid — and since the
   * marker is what bounds the next payment, the entire lifetime total goes out
   * again on the very next round.
   */
  payRakeback(wallet: string, lamports: number, claimedTotal: number): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE players SET balance = balance + ?, revEarned = revEarned + ?, revClaimed = ?
            WHERE wallet = ?`,
        )
        .run(lamports, lamports, claimedTotal, wallet);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
  }

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

  /** Books a completed withdrawal against the already-debited balance. */
  recordWithdrawal(sig: string, wallet: string, lamports: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO transfers (sig, wallet, direction, lamports, at) VALUES (?, ?, 'withdraw', ?, ?)",
      )
      .run(sig, wallet, lamports, Date.now());
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
