import { DatabaseSync } from "node:sqlite";
import { CHARS, CONFIG } from "./config.ts";

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
        secret    TEXT    NOT NULL DEFAULT '',
        sealNonce TEXT    NOT NULL DEFAULT '',
        seedHex   TEXT    NOT NULL DEFAULT '',
        entrants  INTEGER NOT NULL DEFAULT 0,
        ticks     INTEGER NOT NULL DEFAULT 0,
        bestMult  REAL    NOT NULL DEFAULT 0,
        winner    TEXT,
        winnerCh  TEXT,
        pot       INTEGER NOT NULL DEFAULT 0,
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
        seat     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (roundId, wallet, seat)
      );

      CREATE INDEX IF NOT EXISTS entries_wallet ON entries(wallet, roundId DESC);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_tokens (
        wallet TEXT PRIMARY KEY,
        token  TEXT NOT NULL,
        at     INTEGER NOT NULL
      );
    `);

  }

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
        this.db
          .prepare(
            `UPDATE players
                SET wagered = wagered - ?,
                    roundsPlayed = roundsPlayed - 1
              WHERE wallet = ?`,
          )
          .run(o.staked, o.wallet);
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

  owedFor(roundId: number, seat: number): number | null {
    const r = this.db
      .prepare("SELECT returned, outcome FROM entries WHERE roundId = ? AND seat = ?")
      .get(roundId, seat) as { returned: number; outcome: string } | undefined;
    if (!r || r.outcome === "in") return null;
    return r.returned;
  }

  openRound(id: number, commit: string, startedAt: number, secret = ""): void {
    this.db
      .prepare(
        `INSERT INTO rounds (id, commit_, secret, startedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET commit_ = excluded.commit_, secret = excluded.secret`,
      )
      .run(id, commit, secret, startedAt);
  }

  sealRound(id: number, sealNonce: string): void {
    this.db.prepare("UPDATE rounds SET sealNonce = ? WHERE id = ?").run(sealNonce, id);
  }

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
    this.db.exec("BEGIN");
    try {
      const moved = this.db
        .prepare(
          `UPDATE entries SET returned = ?, multiple = ?, ticks = ?, outcome = ?
           WHERE roundId = ? AND wallet = ? AND seat = ? AND outcome = 'in'`,
        )
        .run(returnedLamports, multiple, ticks, outcome, roundId, wallet, seat);
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

  teamWins(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT winnerCh, COUNT(*) AS n FROM rounds WHERE winnerCh IS NOT NULL GROUP BY winnerCh")
      .all() as { winnerCh: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.winnerCh] = r.n;
    return out;
  }

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
      .prepare("SELECT token, at FROM wallet_tokens WHERE wallet = ?")
      .get(wallet) as { token: string; at: number } | undefined;
    if (!r) return null;
    if (CONFIG.tokenTtlMs > 0 && Date.now() - Number(r.at) > CONFIG.tokenTtlMs) {
      this.clearAuthToken(wallet);
      return null;
    }
    return r.token;
  }

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
