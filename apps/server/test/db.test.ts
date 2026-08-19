import test from "node:test";
import assert from "node:assert/strict";

import { Database } from "../src/db.ts";
import { CHARS } from "../src/config.ts";

const fresh = (): Database => new Database(":memory:");

const STAKE = 100_000_000;

function enter(db: Database, roundId: number, wallet: string, seats: number[]): void {
  db.player(wallet);
  for (const seat of seats) db.takeEntry(roundId, wallet, STAKE, seat);
}

test("a new wallet is created on first sight, with a face from the roster", () => {
  const db = fresh();
  const p = db.player("WalletA");
  assert.equal(p.wallet, "WalletA");
  assert.ok(CHARS.includes(p.charId), `dealt a face that is not on the roster: ${p.charId}`);
  assert.equal(p.roundsPlayed, 0);
  assert.equal(p.wagered, 0);
  assert.equal(p.returned, 0);
  assert.equal(db.player("WalletA").createdAt, p.createdAt);
  db.close();
});

test("a spectator gets a row that was never written down", () => {
  const row = Database.spectatorRow("Watcher");
  assert.equal(row.wallet, "Watcher");
  assert.ok(CHARS.includes(row.charId));
  assert.equal(row.roundsPlayed, 0);
  const db = fresh();
  assert.deepEqual(db.historyFor("Watcher"), [], "and nothing was persisted for them");
  db.close();
});

test("buying a plate records the entry and the stake together", () => {
  const db = fresh();
  db.openRound(1, "commit-1", Date.now());
  enter(db, 1, "WalletA", [1]);
  const p = db.player("WalletA");
  assert.equal(p.roundsPlayed, 1);
  assert.equal(p.wagered, STAKE);
  assert.equal(db.owedFor(1, 1), null, "an unsettled seat is owed nothing yet");
  db.close();
});

test("settlement is keyed on the seat, so one plate cannot overwrite another", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1, 2, 3]);
  db.settleEntry(1, "WalletA", 1, STAKE * 3, 3, 12, "cashed", true);
  db.settleEntry(1, "WalletA", 2, 0, 0, 5, "dead", false);
  db.settleEntry(1, "WalletA", 3, 0, 0, 5, "dead", false);
  assert.equal(db.owedFor(1, 1), STAKE * 3);
  assert.equal(db.owedFor(1, 2), 0);
  assert.equal(db.owedFor(1, 3), 0);
  const p = db.player("WalletA");
  assert.equal(p.wagered, STAKE * 3, "three plates staked");
  assert.equal(p.returned, STAKE * 3, "one of them came back at 3x");
  assert.equal(p.roundsWon, 1, "and only the winning plate counted as a win");
  assert.equal(p.bestMultiple, 3);
  db.close();
});

test("a total loss settles at zero and is still a settlement", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, 0, 0, 4, "dead", false);
  assert.equal(db.owedFor(1, 1), 0);
  assert.notEqual(db.owedFor(1, 1), null);
  assert.equal(db.player("WalletA").roundsWon, 0);
  db.close();
});

test("a seat settles once, however many times it is told to", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, 250_000_000, 2.5, 9, "cashed", true);
  const after = db.player("WalletA");

  db.settleEntry(1, "WalletA", 1, 250_000_000, 2.5, 9, "cashed", true);
  db.settleEntry(1, "WalletA", 1, 999_000_000, 9.99, 40, "cashed", true);
  const twice = db.player("WalletA");

  assert.equal(twice.returned, after.returned, "lifetime returns counted twice");
  assert.equal(twice.roundsWon, after.roundsWon, "one round, counted as two wins");
  assert.equal(twice.bestMultiple, after.bestMultiple, "a repeat wrote a new personal best");
  assert.equal(db.owedFor(1, 1), 250_000_000, "the second call rewrote what was owed");

  db.openRound(2, "c", Date.now());
  enter(db, 2, "WalletB", [1]);
  db.refundOpenEntries();
  const swept = db.player("WalletB");
  db.settleEntry(2, "WalletB", 1, 500_000_000, 5, 20, "cashed", true);
  assert.deepEqual(
    { r: db.player("WalletB").returned, w: db.player("WalletB").roundsWon },
    { r: swept.returned, w: swept.roundsWon },
    "a refunded seat was settled on top of its refund",
  );
  db.close();
});

test("owedFor reads back what was recorded, for a settlement the ledger missed", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [7]);
  assert.equal(db.owedFor(1, 7), null, "not settled yet");
  db.settleEntry(1, "WalletA", 7, 250_000_000, 2.5, 9, "cashed", true);
  assert.equal(db.owedFor(1, 7), 250_000_000);
  assert.equal(db.owedFor(1, 99), null, "a seat that does not exist owes nothing");
  assert.equal(db.owedFor(99, 7), null, "nor a round that does not");
  db.close();
});

test("the best multiple only ever climbs", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1, 2]);
  db.settleEntry(1, "WalletA", 1, STAKE * 5, 5, 20, "cashed", true);
  db.settleEntry(1, "WalletA", 2, STAKE * 2, 2, 8, "cashed", true);
  assert.equal(db.player("WalletA").bestMultiple, 5, "a later smaller win must not lower it");
  db.close();
});

test("a round that never ended is refunded at startup, plate by plate", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1, 2]);
  enter(db, 1, "WalletB", [3]);
  const before = db.player("WalletA");
  assert.equal(before.roundsPlayed, 2);
  assert.equal(before.wagered, STAKE * 2);

  assert.equal(db.refundOpenEntries(), 3, "one refund per PLATE, not per wallet");
  const a = db.player("WalletA");
  assert.equal(a.roundsPlayed, 0, "the rounds were un-counted");
  assert.equal(a.wagered, 0, "and so was the stake");
  assert.equal(db.player("WalletB").roundsPlayed, 0);
  assert.equal(db.refundOpenEntries(), 0);
  assert.equal(db.player("WalletA").roundsPlayed, 0, "and the stats did not go negative");
  db.close();
});

test("the sweep leaves a seat that had already settled completely alone", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, STAKE * 4, 4, 15, "cashed", true);
  assert.equal(db.player("WalletA").roundsWon, 1);
  assert.equal(db.refundOpenEntries(), 0, "a settled seat is not an orphan");
  const p = db.player("WalletA");
  assert.equal(p.roundsWon, 1, "the win stands: they were actually paid");
  assert.equal(p.returned, STAKE * 4, "and so does the payout");
  assert.equal(p.roundsPlayed, 1);
  assert.equal(db.owedFor(1, 1), STAKE * 4, "the entry row still says what it said");
  db.close();
});

test("a mix of settled and open seats rolls back only the open ones", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1, 2, 3]);
  db.settleEntry(1, "WalletA", 1, STAKE * 3, 3, 12, "cashed", true);
  db.settleEntry(1, "WalletA", 2, 0, 0, 8, "dead", false);
  assert.equal(db.refundOpenEntries(), 1, "only seat 3 was open");
  const p = db.player("WalletA");
  assert.equal(p.wagered, STAKE * 2, "the refunded plate's stake is un-counted");
  assert.equal(p.roundsPlayed, 2);
  assert.equal(p.returned, STAKE * 3, "the cash-out is untouched");
  assert.equal(p.roundsWon, 1);
  assert.equal(db.owedFor(1, 2), 0, "and the dead plate stays dead rather than refunded");
  db.close();
});

test("an interrupted round is closed and revealed rather than hidden", () => {
  const db = fresh();
  db.openRound(7, "the-commitment", Date.now());
  enter(db, 7, "WalletA", [1]);
  assert.deepEqual(db.historyFor("WalletA"), [], "invisible while it hangs open");

  assert.equal(db.refundOpenEntries(), 1);
  db.closeInterrupted(7, "the-secret", 1, 4, JSON.stringify({ interrupted: true }));

  const rows = db.historyFor("WalletA");
  assert.equal(rows.length, 1, "now it is a round a player can ask about");
  assert.equal(rows[0]!.commit, "the-commitment");
  assert.equal(rows[0]!.seedHex, "the-secret", "the reveal is what the commitment covered");
  assert.equal(rows[0]!.ticks, 4);
  assert.equal(rows[0]!.staked, STAKE);
  assert.equal(rows[0]!.returned, STAKE, "a rolled-back plate came back at 1x");

  db.openRound(8, "c8", Date.now());
  enter(db, 8, "WalletA", [1]);
  db.settleEntry(8, "WalletA", 1, STAKE * 2, 2, 9, "cashed", true);
  db.closeRound(8, "real-seed", 1, 9, 2, "WalletA", "pepe", STAKE, "{}", "digest");
  db.closeInterrupted(8, "wrong-secret", 0, 0, "{}");
  const after = db.historyFor("WalletA").find((r) => r.roundId === 8)!;
  assert.equal(after.seedHex, "real-seed");
  assert.equal(after.digest, "digest");
  db.close();
});

test("a closed round is left alone by the sweep", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, STAKE * 2, 2, 10, "cashed", true);
  db.closeRound(1, "seed", 1, 10, 2, "WalletA", "pepe", STAKE, "{}", "digest");
  assert.equal(db.refundOpenEntries(), 0, "a finished round is not an orphan");
  assert.equal(db.player("WalletA").returned, STAKE * 2, "and its payout stands");
  db.close();
});

test("a round the process died inside is revealed by the process that replaces it", () => {
  const db = fresh();
  const derive = (secret: string, nonce: string, ids: number[]): string =>
    `seed(${secret}/${nonce}/${ids.join("-")})`;

  db.openRound(4, "commit-4", Date.now(), "secret-4");
  enter(db, 4, "WalletA", [1, 2]);
  enter(db, 4, "WalletB", [3]);
  db.sealRound(4, "nonce-4");

  assert.equal(db.refundOpenEntries(), 3);
  assert.equal(db.revealInterrupted({ entry: 0.1 }, derive), 1);
  assert.equal(db.revealInterrupted({ entry: 0.1 }, derive), 0, "and only once");

  const row = db.historyFor("WalletA")[0]!;
  assert.equal(row.seedHex, "secret-4", "the commitment's preimage is published at last");
  const record = JSON.parse(row.record) as {
    interrupted: boolean;
    sealNonce: string;
    seedHex: string;
    entrantIds: number[];
  };
  assert.equal(record.interrupted, true);
  assert.equal(record.sealNonce, "nonce-4");
  assert.deepEqual(record.entrantIds, [1, 2, 3], "recovered from the entry rows, in seal order");
  assert.equal(record.seedHex, derive("secret-4", "nonce-4", [1, 2, 3]));
  db.close();
});

test("a round interrupted before it sealed reveals a secret and no seed", () => {
  const db = fresh();
  db.openRound(5, "commit-5", Date.now(), "secret-5");
  enter(db, 5, "WalletA", [1]);
  db.refundOpenEntries();
  db.revealInterrupted({}, () => "should-not-be-called");

  const row = db.historyFor("WalletA")[0]!;
  assert.equal(row.seedHex, "secret-5");
  assert.equal((JSON.parse(row.record) as { seedHex: string }).seedHex, "");
  db.close();
});

test("a lobby entry pulled before the round seals is erased, not refunded", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1, 2]);
  assert.equal(db.refundLobbyEntry(1, "WalletA", 2), true);
  const p = db.player("WalletA");
  assert.equal(p.roundsPlayed, 1, "one plate left");
  assert.equal(p.wagered, STAKE);
  assert.equal(db.refundLobbyEntry(1, "WalletA", 2), false, "and it cannot be pulled twice");
  assert.equal(db.refundLobbyEntry(1, "Nobody", 9), false);
  db.close();
});

test("closing a round records what a player needs to verify it", () => {
  const db = fresh();
  db.openRound(4, "the-commit", Date.now());
  enter(db, 4, "WalletA", [1]);
  db.settleEntry(4, "WalletA", 1, STAKE, 1, 6, "cashed", true);
  db.closeRound(4, "the-seed", 1, 6, 1, "WalletA", "wojak", STAKE, '{"seedHex":"x"}', "the-digest");
  const [h] = db.historyFor("WalletA");
  assert.ok(h, "the round shows up in the player's own history");
  assert.equal(h.commit, "the-commit");
  assert.equal(h.seedHex, "the-seed");
  assert.equal(h.digest, "the-digest");
  assert.equal(h.record, '{"seedHex":"x"}');
  db.close();
});

test("history aggregates a wallet's plates into one row per round", () => {
  const db = fresh();
  db.openRound(1, "c1", Date.now());
  enter(db, 1, "WalletA", [1, 2, 3]);
  db.settleEntry(1, "WalletA", 1, STAKE * 3, 3, 12, "cashed", true);
  db.settleEntry(1, "WalletA", 2, 0, 0, 5, "dead", false);
  db.settleEntry(1, "WalletA", 3, 0, 0, 5, "dead", false);
  db.closeRound(1, "s1", 3, 12, 3, "WalletA", "pepe", STAKE * 3, "{}", "d1");

  const rows = db.historyFor("WalletA");
  assert.equal(rows.length, 1, "three plates, one round");
  assert.equal(rows[0]!.plates, 3);
  assert.equal(rows[0]!.staked, STAKE * 3);
  assert.equal(rows[0]!.returned, STAKE * 3);
  assert.equal(rows[0]!.anyBanked, 1);
  assert.deepEqual(rows[0]!.seats.split(",").map(Number).sort(), [1, 2, 3]);
  db.close();
});

test("an unfinished round stays out of history until it is closed", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, STAKE, 1, 3, "cashed", true);
  assert.deepEqual(db.historyFor("WalletA"), []);
  db.closeRound(1, "s", 1, 3, 1, null, null, STAKE, "{}", "d");
  assert.equal(db.historyFor("WalletA").length, 1);
  db.close();
});

test("history is newest first and honours its limit", () => {
  const db = fresh();
  for (let id = 1; id <= 5; id++) {
    db.openRound(id, `c${id}`, Date.now());
    enter(db, id, "WalletA", [id]);
    db.settleEntry(id, "WalletA", id, 0, 0, 2, "dead", false);
    db.closeRound(id, `s${id}`, 1, 2, 0, null, null, STAKE, "{}", `d${id}`);
  }
  assert.deepEqual(db.historyFor("WalletA").map((r) => r.roundId), [5, 4, 3, 2, 1]);
  assert.deepEqual(db.historyFor("WalletA", 2).map((r) => r.roundId), [5, 4]);
  db.close();
});

test("the round id picks up where the last one left off", () => {
  const db = fresh();
  assert.equal(db.lastRoundId(), 0, "a fresh box starts at zero, not NaN");
  db.openRound(1, "c", Date.now());
  db.openRound(2, "c", Date.now());
  assert.equal(db.lastRoundId(), 2);
  db.close();
});

test("re-opening a round id replaces its commitment rather than duplicating it", () => {
  const db = fresh();
  db.openRound(1, "first-commit", Date.now());
  db.openRound(1, "second-commit", Date.now());
  assert.equal(db.lastRoundId(), 1);
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, 0, 0, 1, "dead", false);
  db.closeRound(1, "s", 1, 1, 0, null, null, STAKE, "{}", "d");
  assert.equal(db.historyFor("WalletA")[0]!.commit, "second-commit");
  db.close();
});

test("the team tally counts winners and ignores rounds with none", () => {
  const db = fresh();
  const close = (id: number, ch: string | null) => {
    db.openRound(id, "c", Date.now());
    db.closeRound(id, "s", 2, 5, 1, ch === null ? null : "W", ch, STAKE, "{}", "d");
  };
  close(1, "pepe");
  close(2, "pepe");
  close(3, "wojak");
  close(4, null);
  assert.deepEqual(db.teamWins(), { pepe: 2, wojak: 1 });
  db.close();
});

test("a wallet's session token is stored and rotated, never duplicated", () => {
  const db = fresh();
  db.player("WalletA");
  assert.equal(db.authTokenOf("WalletA"), null);
  db.setAuthToken("WalletA", "token-one");
  assert.equal(db.authTokenOf("WalletA"), "token-one");
  db.setAuthToken("WalletA", "token-two");
  assert.equal(db.authTokenOf("WalletA"), "token-two", "rotating replaces, it does not append");
  assert.equal(db.authTokenOf("WalletB"), null);
  db.close();
});

test("a session token can be revoked, and revoking it takes the row with it", () => {
  const db = fresh();
  db.player("WalletA");
  db.setAuthToken("WalletA", "token-one");
  db.clearAuthToken("WalletA");
  assert.equal(db.authTokenOf("WalletA"), null, "the seat is gone, not merely forgotten locally");
  db.setAuthToken("WalletB", "token-two");
  db.clearAuthToken("WalletA");
  assert.equal(db.authTokenOf("WalletB"), "token-two");
  db.close();
});

test("meta keys round-trip and report absence as null", () => {
  const db = fresh();
  assert.equal(db.getMeta("never-set"), null);
  db.setMeta("schema-note", "v1");
  assert.equal(db.getMeta("schema-note"), "v1");
  db.setMeta("schema-note", "v2");
  assert.equal(db.getMeta("schema-note"), "v2");
  db.close();
});

test("player settings persist and the roster gates the face", () => {
  const db = fresh();
  db.player("WalletA");
  db.setChar("WalletA", "milady");
  assert.equal(db.player("WalletA").charId, "milady");
  db.setAuto("WalletA", true, 2.5, 3);
  const p = db.player("WalletA");
  assert.equal(p.autoEnabled, 1);
  assert.equal(p.autoTarget, 2.5);
  assert.equal(p.autoPlates, 3);
  db.close();
});
