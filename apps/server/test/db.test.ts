/*
 * The book of record: entries, rounds, and what survives a crash.
 *
 * The money itself lives in the arcade's double-entry ledger, not here. What
 * this file stores is the game's own account of what happened -- who bought
 * which plate, what it returned, and the seed and replay record that let a
 * player check it. Three things about that are worth defending.
 *
 * MULTI-PLATE ENTRIES ARE KEYED ON THE SEAT. One wallet can hold several
 * plates in one round, so "the wallet's row" is not a row. Settling by wallet
 * would land one plate's payout on whichever row SQLite happened to find
 * first, and the other plates would keep the stale figures.
 *
 * THE CRASH SWEEP MUST BE ABLE TO FIND THE STAKE. Anything left in a round
 * that never ended is refunded at startup, and it can only refund what it can
 * see -- which is why the entry row and the stats move in one transaction.
 *
 * A SETTLED SEAT REMEMBERS WHAT IT WAS OWED. `owedFor` reads back from the
 * row rather than from anything held in memory, so a settlement the ledger
 * missed is retried with the number that was actually recorded.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Database } from "../src/db.ts";
import { CHARS } from "../src/config.ts";

/** A private database per test. Nothing here touches the real file. */
const fresh = (): Database => new Database(":memory:");

const STAKE = 100_000_000; // 0.1 SOL

/** Buys `seats` plates for one wallet in a round that has been opened. */
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
  // Seen again is the same row, not a second one.
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
  // The failure this prevents: a three-plate wallet where one plate cashed at
  // 3x and two died, settled by wallet, reporting 3x on all three.
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
  // Zero, not null: null means "still in", and the retry path treats the two
  // completely differently.
  assert.equal(db.owedFor(1, 1), 0);
  assert.notEqual(db.owedFor(1, 1), null);
  assert.equal(db.player("WalletA").roundsWon, 0);
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

/* ---- what a crash leaves behind ---- */

test("a round that never ended is refunded at startup, plate by plate", () => {
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1, 2]);
  enter(db, 1, "WalletB", [3]);
  // The process dies here: the round has no endedAt.
  const before = db.player("WalletA");
  assert.equal(before.roundsPlayed, 2);
  assert.equal(before.wagered, STAKE * 2);

  assert.equal(db.refundOpenEntries(), 3, "one refund per PLATE, not per wallet");
  const a = db.player("WalletA");
  assert.equal(a.roundsPlayed, 0, "the rounds were un-counted");
  assert.equal(a.wagered, 0, "and so was the stake");
  assert.equal(db.player("WalletB").roundsPlayed, 0);
  // Running it again finds nothing: refunded rows are excluded, so a restart
  // loop cannot refund the same stake twice.
  assert.equal(db.refundOpenEntries(), 0);
  assert.equal(db.player("WalletA").roundsPlayed, 0, "and the stats did not go negative");
  db.close();
});

test("the sweep un-counts a win it is reversing", () => {
  // A seat that had already cashed when the process died: its payout was
  // recorded, so reversing the entry has to reverse the win too or the wallet
  // keeps a round it never played.
  const db = fresh();
  db.openRound(1, "c", Date.now());
  enter(db, 1, "WalletA", [1]);
  db.settleEntry(1, "WalletA", 1, STAKE * 4, 4, 15, "cashed", true);
  assert.equal(db.player("WalletA").roundsWon, 1);
  assert.equal(db.refundOpenEntries(), 1);
  const p = db.player("WalletA");
  assert.equal(p.roundsWon, 0);
  assert.equal(p.returned, 0);
  assert.equal(p.roundsPlayed, 0);
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

test("a lobby entry pulled before the round seals is erased, not refunded", () => {
  // Different path, different meaning: the plate was never bought. It must
  // leave no entry row behind for the crash sweep to find later.
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

/* ---- rounds ---- */

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
  // Every seat, so the client can check each plate against the replay.
  assert.deepEqual(rows[0]!.seats.split(",").map(Number).sort(), [1, 2, 3]);
  db.close();
});

test("an unfinished round stays out of history until it is closed", () => {
  // A player must not be shown a round with no seed as if it were verifiable.
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
  // A restart mid-lobby re-draws the seed for a round that never sealed.
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

/* ---- session tokens ---- */

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
