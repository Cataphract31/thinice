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
    this.addRevealColumns();
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
        /* The preimage of commit_, written when the lobby opens and NOT
           published until the round closes.

           WHY IT IS ON DISK AT ALL. It is only ever in memory otherwise, so a
           round the process died inside could never be revealed by the process
           that came after -- the commitment was published, real SOL moved, and
           the one thing that could prove it honest went with the crash. It
           gives an operator nothing they did not already have (they hold it in
           memory for the whole lobby either way); what it buys is that a
           restart can still keep the promise. Same for sealNonce, drawn when
           the lobby seals. */
        secret    TEXT    NOT NULL DEFAULT '',
        sealNonce TEXT    NOT NULL DEFAULT '',
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
         on later connects so Phantom is not asked to sign every socket.

         A BEARER CREDENTIAL FOR A SEAT, AND A SEAT IS A MONEY PRIMITIVE. It
         used to live forever and could not be revoked: the at column was
         written and never read, resume compared bytes and asked nothing else,
         there was no logout in the protocol, and disconnecting a wallet
         cleared only the browser's copy. The token also rides in a cookie
         scoped to the whole arcade domain, so any XSS in any world on it
         lifted a permanent one -- and a lifted seat is not griefing: seat the
         victim, bond their five plates, enter the same lobby with your own
         wallet, extract yours and let theirs die. It expires now
         (CONFIG.tokenTtlMs, matching the arcade's own 30 days) and
         clearAuthToken is the revocation path. */
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
  /**
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
   * so an installed database never grows a column the schema above gained.
   * Added here rather than in a migration framework because there are two of
   * them and both default to empty, which is exactly what a round opened
   * before this change knows about itself.
   */
  private addRevealColumns(): void {
    const cols = this.db.prepare("PRAGMA table_info(rounds)").all() as { name: string }[];
    const has = (name: string): boolean => cols.some((c) => c.name === name);
    if (!has("secret")) this.db.exec("ALTER TABLE rounds ADD COLUMN secret TEXT NOT NULL DEFAULT ''");
    if (!has("sealNonce")) {
      this.db.exec("ALTER TABLE rounds ADD COLUMN sealNonce TEXT NOT NULL DEFAULT ''");
    }
  }

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
   * Crash recovery, run at startup before any round opens and again whenever
   * the tick loop has to abandon a round.
   *
   * A round that never reached `closeRound` is rolled back: every entry still
   * OPEN in it is marked refunded and its stats un-counted, as if it never
   * played. The stake itself comes back through `ledger.sweep()`, which
   * releases the hold; this file only owns the game's own account of it.
   *
   * IT USED TO REWRITE SETTLED ROWS TOO, AND THE HOUSE PAID FOR IT. The
   * selection was `outcome <> 'refunded'`, which includes every seat that had
   * already cashed or died, and each of them was rewritten to
   * `outcome='refunded', returned=staked, multiple=1` -- decrementing
   * `players.returned` by a payout the player had genuinely been paid and
   * declaring a lost stake returned. Combined with the sweep releasing every
   * still-open hold, one round could pay A 0.8 SOL out of B, C and D's stakes,
   * hand B, C and D their stakes back in full, and leave `~house` covering the
   * 0.7 SOL difference with `overdraft: true` and no cap on it. No crash was
   * needed to trigger that: a deploy restart timed after a large extraction
   * does it, which makes it something an attacker can wait for rather than
   * something that happens to them.
   *
   * The older comment on this method argued the opposite -- that cash-outs
   * must be clawed back or the redistributed money is quietly kept -- and it
   * was right about a single-sided balance column that no longer exists. A
   * seat that settled settled: its hold was closed against an idempotent ref
   * and the player was paid, and this game has no power to debit anybody to
   * take that back. What is left open is exactly what is still owed.
   *
   * The round row keeps its NULL endedAt unless the caller closes it: it is
   * the audit trail of the crash. `closeInterrupted` is how a round that has
   * been rolled back still gets its seed revealed.
   *
   * @returns the entries rolled back, for the caller to log
   */
  refundOpenEntries(): number {
    const orphans = this.db
      .prepare(
        `SELECT e.roundId, e.wallet, e.staked, e.returned, e.outcome, e.seat
           FROM entries e JOIN rounds r ON r.id = e.roundId
          WHERE r.endedAt IS NULL AND e.outcome = 'in'`,
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
        // Only the stake and the round count come off. An open entry has been
        // paid nothing, so there is no `returned` to reverse and no win to
        // un-count -- and the settled rows that DO carry those numbers are no
        // longer selected, because reversing a payout the player has actually
        // received is a lie the books cannot see.
        this.db
          .prepare(
            `UPDATE players
                SET wagered = wagered - ?,
                    roundsPlayed = roundsPlayed - 1
              WHERE wallet = ?`,
          )
          .run(o.staked, o.wallet);
        // Per seat, not per wallet: a multi-plate wallet has one row per
        // plate in the orphaned round and each is its own refund.
        this.db
          .prepare(
            `UPDATE entries SET outcome = 'refunded', returned = staked, multiple = 1
              WHERE roundId = ? AND wallet = ? AND seat = ? AND outcome = 'in'`,
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

  /**
   * Open a round, recording the commitment AND the secret behind it.
   *
   * The secret is not published by this: `historyFor` reads `seedHex`, which
   * stays empty until the round closes. It is written here so that a round the
   * process dies inside can still be revealed by the process that replaces it.
   */
  openRound(id: number, commit: string, startedAt: number, secret = ""): void {
    this.db
      .prepare(
        `INSERT INTO rounds (id, commit_, secret, startedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET commit_ = excluded.commit_, secret = excluded.secret`,
      )
      .run(id, commit, secret, startedAt);
  }

  /** The seal nonce, once the entrant list is final. See the schema comment. */
  sealRound(id: number, sealNonce: string): void {
    this.db.prepare("UPDATE rounds SET sealNonce = ? WHERE id = ?").run(sealNonce, id);
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

  /**
   * Close a round nobody could finish, and reveal what it committed to.
   *
   * A round that never reaches `closeRound` keeps a NULL `endedAt` and an
   * empty `seedHex` forever, and `historyFor` excludes it -- so a round that
   * published a commitment, ran, and moved real SOL becomes one the operator
   * can never be asked to prove. For a game whose fairness claim IS the
   * commit-reveal ceremony, every crash and every deploy restart minted one of
   * those, silently. The audit trail argument for leaving the row open was
   * about a round the recovery sweep had not touched yet; once it HAS been
   * rolled back, an unclosed row is not evidence of anything, it is a round
   * hidden from the only people entitled to check it.
   *
   * No winner, no pot, no digest: there is no outcome to record. The record
   * says `interrupted`, which is what tells a verifier to check the
   * commitment and report the replay as not applicable rather than failed.
   * `endedAt IS NULL` in the WHERE so this can never overwrite a round that
   * actually finished.
   */
  closeInterrupted(
    id: number,
    secretHex: string,
    entrants: number,
    ticks: number,
    record: string,
  ): void {
    this.db
      .prepare(
        `UPDATE rounds SET seedHex = ?, entrants = ?, ticks = ?, record = ?, endedAt = ?
          WHERE id = ? AND endedAt IS NULL`,
      )
      .run(secretHex, entrants, ticks, record, Date.now(), id);
  }

  /**
   * Reveal every round the last process never closed. Run once at startup,
   * after the entries have been rolled back.
   *
   * `closeInterrupted` covers the round this process aborts itself. This
   * covers the other two ways a round ends without closing, which are the
   * common ones: the box dies, or a deploy restarts the service. Both used to
   * leave a round that published a commitment, took real SOL and was excluded
   * from history forever -- unprovable by construction, and minted on every
   * single deploy.
   *
   * It can only reveal what was written down. The secret was (see openRound),
   * the seal nonce was, and the entrant list is recoverable from the entry
   * rows in seat order -- which is the order the seats were issued in and
   * therefore the order they were sealed in. That is enough to rebuild the
   * seed the round ran on. The cash-out schedule is not: it lived in memory,
   * so there is no replay, and the record says so rather than implying one.
   *
   * `deriveSeed` is passed in rather than imported so this file stays free of
   * the ceremony; game.ts owns that string and hashes it.
   *
   * @returns the rounds revealed, for the caller to log
   */
  revealInterrupted(
    config: unknown,
    deriveSeed: (secret: string, sealNonce: string, entrantIds: number[]) => string,
  ): number {
    const open = this.db
      .prepare("SELECT id, secret, sealNonce FROM rounds WHERE endedAt IS NULL")
      .all() as { id: number; secret: string; sealNonce: string }[];
    let revealed = 0;
    for (const r of open) {
      const seats = this.db
        .prepare("SELECT seat FROM entries WHERE roundId = ? ORDER BY seat ASC")
        .all(r.id) as { seat: number }[];
      const entrantIds = seats.map((s) => s.seat);
      this.closeInterrupted(
        r.id,
        r.secret,
        entrantIds.length,
        0,
        JSON.stringify({
          interrupted: true,
          // Empty when the process died before the lobby sealed, which is the
          // honest answer: no seed was ever drawn for that round.
          seedHex: r.sealNonce ? deriveSeed(r.secret, r.sealNonce, entrantIds) : "",
          sealNonce: r.sealNonce,
          config,
          entrantIds,
          cashOuts: [],
        }),
      );
      revealed++;
    }
    return revealed;
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

  /**
   * The wallet's live token, or null once it has aged out.
   *
   * `at` was written by `setAuthToken` from the beginning and read by nothing,
   * so every token this server ever minted was valid forever. The row is
   * deleted rather than merely refused: an expired credential kept on disk is
   * a credential, and this way one stale row cannot outlive the wallet.
   */
  authTokenOf(wallet: string): string | null {
    const r = this.db
      .prepare("SELECT token, at FROM wallet_tokens WHERE wallet = ?")
      .get(wallet) as { token: string; at: number } | undefined;
    if (!r) return null;
    if (CONFIG.tokenTtlMs > 0 && Date.now() - Number(r.at) > CONFIG.tokenTtlMs) {
      this.clearAuthToken(wallet);
      return null;
    }
    return r.token;
  }

  /**
   * Revocation. Disconnecting a wallet used to clear the BROWSER's copy only,
   * which meant the server row stayed valid forever and "disconnect" was a
   * statement about one device rather than about the seat.
   */
  clearAuthToken(wallet: string): void {
    this.db.prepare("DELETE FROM wallet_tokens WHERE wallet = ?").run(wallet);
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
