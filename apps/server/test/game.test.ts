/*
 * THE ROUND ITSELF, WHICH HAD NO TEST AT ALL.
 *
 * `game.ts` is where the money decisions are: who is seated, what is held,
 * what is settled, and what happens to any of it when the ledger is slow, the
 * round rolls over, or the tick loop throws. Every other file on this server
 * had a suite and this one did not, which is why a whole family of bugs sat
 * here green for months. They share one shape:
 *
 *   EVERY GUARD IN THIS FILE READS STATE THAT IS WRITTEN AFTER AN AWAIT.
 *
 * A stake moves over HTTP. A seat is recorded when the answer comes back. So
 * for one network round trip the server's honest answer to "how many plates
 * does this wallet hold" was zero, and every cap, every step-off and every
 * auto-buy decision read that zero. The tests below are written against the
 * WINDOW rather than against the functions: they inject latency and then do
 * the thing a real client does inside it.
 *
 * Nothing here touches a socket, a real database file or a real ledger. The
 * fake ledger records what it was asked, answers when told to, and can be made
 * slow or broken on demand -- which is the only way to write down "250ms of
 * ledger latency charged this player five times".
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, totalRake } from "@zinc/engine";
import { Database } from "../src/db.ts";
import { CONFIG, toLamports } from "../src/config.ts";
import { GameServer, roundSeedFrom, commitmentFor, rulesHashOf, type Session } from "../src/game.ts";
import { LedgerError, type ArcadeLedger } from "../src/arcade.ts";

const STAKE = toLamports(DEFAULT_CONFIG.entry);
const RULES = rulesHashOf(DEFAULT_CONFIG);

/** Lets an in-flight promise chain run without inventing a wall-clock wait. */
const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** Wait for real timers -- only for the fake ledger's injected latency. */
const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Latency plus the microtasks behind it: everything in the air has landed. */
const flush = async (ms = 80): Promise<void> => {
  await after(ms);
  await settleAll();
};

/*
 * A LEDGER THAT ANSWERS WHEN IT IS TOLD TO.
 *
 * `latencyMs` is the whole point of this harness: the arcade's books are one
 * SQLite IMMEDIATE transaction shared with every other game on the box, so a
 * couple of hundred milliseconds under contention is ordinary rather than
 * exotic, and it is exactly the window the bugs below live in.
 */
function fakeLedger() {
  const holds: { wallet: string; roundId: number; seat: number; amount: number }[] = [];
  const settles: { roundId: number; seat: number; payout: number }[] = [];
  const releases: { roundId: number; seat: number }[] = [];
  const reserves: { roundId: number; amount: number }[] = [];
  const exposureReleases: number[] = [];
  const state = {
    latencyMs: 0,
    /** Refuse every hold with this code, as the real client would report it. */
    holdError: null as string | null,
    /** Refuse every settle: the books briefly unreachable. */
    settleError: null as string | null,
    releaseError: null as string | null,
    /** Answer the next hold with an EXISTING hold rather than a new one. */
    replayNext: false,
    sweeps: 0,
    exposureSweeps: 0,
    exposureError: null as LedgerError | null,
  };

  const wait = async (): Promise<void> => {
    if (state.latencyMs > 0) await after(state.latencyMs);
  };

  const ledger = {
    enabled: true,
    refFor: (roundId: number, seat: number) => `thin-ice:r${roundId}:s${seat}`,
    async balanceOf() {
      return { freeLamports: 100 * STAKE, heldLamports: 0 };
    },
    async hold(wallet: string, amount: number, roundId: number, seat: number) {
      await wait();
      if (state.holdError) throw new LedgerError(state.holdError, state.holdError, 503);
      holds.push({ wallet, roundId, seat, amount });
      const replayed = state.replayNext;
      state.replayNext = false;
      return {
        ref: ledger.refFor(roundId, seat),
        amount,
        state: "open",
        replayed,
        freeLamports: 100 * STAKE,
        heldLamports: amount,
      };
    },
    async settle(roundId: number, seat: number, payout: number) {
      await wait();
      if (state.settleError) throw new LedgerError(state.settleError, state.settleError, 503);
      settles.push({ roundId, seat, payout });
    },
    async release(roundId: number, seat: number) {
      await wait();
      if (state.releaseError) throw new LedgerError(state.releaseError, state.releaseError, 503);
      releases.push({ roundId, seat });
    },
    async sweep() {
      state.sweeps++;
      return 0;
    },
    exposure: {
      async reserve(roundId: number, amount: number) {
        if (state.exposureError) throw state.exposureError;
        reserves.push({ roundId, amount });
      },
      async release(roundId: number) {
        exposureReleases.push(roundId);
      },
      async sweep() {
        state.exposureSweeps++;
        return 0;
      },
    },
  };

  return { ledger: ledger as unknown as ArcadeLedger, holds, settles, releases, reserves, exposureReleases, state };
}

/** A connected human, as the socket layer would present one. */
function fakeSession(wallet: string, guest = false): Session & { last: unknown } {
  return {
    wallet,
    guest,
    session: 0,
    last: null,
    send(state) {
      (this as unknown as { last: unknown }).last = state;
    },
    sendHistory() {},
    sendChat() {},
  } as Session & { last: unknown };
}

/*
 * THE LIFECYCLE HANDLES THE SOCKET LAYER DOES NOT HAVE.
 *
 * `seal`, `tick`, `openLobby` and `abortRound` are private because no message
 * may reach them: they are the clock, and the clock belongs to the server.
 * A test has to be able to stand where the clock stands -- the alternative is
 * ten-second lobbies and real crashes -- so it reaches in here, deliberately
 * and in one place, rather than the game exposing them to everybody.
 */
interface Inner {
  phase: "lobby" | "live" | "result";
  roundId: number;
  secretHex: string;
  sealNonce: string;
  seedHex: string;
  commit: string;
  seats: Map<number, { id: number; wallet: string }>;
  seatsOf: Map<string, number[]>;
  unsettled: Map<string, { roundId: number; seat: number }>;
  unreleased: Map<string, { roundId: number; seat: number }>;
  round: { currentTick: number; finished: boolean; players: { id: number; outcome: string }[] } | null;
  seal(): void;
  tick(): void;
  openLobby(): void;
  abortRound(err: unknown): void;
  autoEnter(): void;
  settleExit(wallet: string, seat: number, sol: number, ticks: number, outcome: string): void;
  reconcileBooks(): Promise<void>;
}
const inner = (g: GameServer): Inner => g as unknown as Inner;

/** A game in an open lobby with its clock stopped, so tests own the timing. */
function table(opts: { latencyMs?: number } = {}) {
  const db = new Database(":memory:");
  const fake = fakeLedger();
  fake.state.latencyMs = opts.latencyMs ?? 0;
  const game = new GameServer(db, fake.ledger);
  game.start();
  game.stop();
  return { db, game, g: inner(game), ...fake };
}

/* ---- the window between a stake moving and a seat being recorded ---- */

test("ten bond presses in one tick buy five plates, not ten", async () => {
  /*
   * The cap read `seatsOf`, which is written after the hold returns, so every
   * one of ten concurrent joins saw an empty list and sent its own hold. The
   * client dispatches with no busy guard and the server with `void handle()`,
   * so this is a real client hammering a button, not a synthetic race.
   */
  const t = table({ latencyMs: 20 });
  const s = fakeSession("WalletA");
  t.game.attach(s);

  const answers = await Promise.all(Array.from({ length: 10 }, () => t.game.join(s)));

  assert.equal(t.holds.length, CONFIG.maxPlatesPerWallet, "one hold per plate the cap allows");
  assert.equal(answers.filter((a) => a === null).length, CONFIG.maxPlatesPerWallet);
  assert.equal(t.g.seatsOf.get("WalletA")?.length, CONFIG.maxPlatesPerWallet);
  assert.equal(t.g.seats.size, CONFIG.maxPlatesPerWallet, "and no plate is orphaned");
  // Every refusal names the cap rather than blaming the books.
  for (const a of answers.filter((x) => x !== null)) assert.match(String(a), /plate limit/);
  t.db.close();
});

test("stepping off while the stake is moving is honoured, not silently ignored", async () => {
  /*
   * THE WORST OF THE SET. `unjoin` looked in `seatsOf`, found nothing because
   * the holds were still in the air, and returned null -- which index.ts
   * reports as success and shows the player nothing. The holds then landed.
   * The player pressed step off, was told nothing was wrong, and was bonded
   * three plates deep in a round they had explicitly left; timed at the last
   * second of the lobby, sealed into it.
   */
  const t = table({ latencyMs: 20 });
  const s = fakeSession("WalletA");
  t.game.attach(s);
  t.db.setAuto("WalletA", true, 2, 1);

  const joins = [t.game.join(s), t.game.join(s), t.game.join(s)];
  // Inside the window, exactly as a real press would land.
  const off = await t.game.unjoin(s);
  const answers = await Promise.all(joins);
  await flush();

  assert.equal(off, null, "stepping off itself succeeded");
  assert.equal(t.g.seatsOf.get("WalletA"), undefined, "no seat survived the withdrawal");
  assert.equal(t.g.seats.size, 0);
  assert.equal(t.holds.length, 3, "the stakes had already moved");
  assert.equal(t.releases.length, 3, "and every one of them was given back");
  for (const a of answers) assert.match(String(a), /stepped off/);
  assert.equal(
    t.db.player("WalletA").autoEnabled,
    0,
    "auto play goes off with the step-off, or the next tick buys the seat straight back",
  );
  t.db.close();
});

test("auto play under a slow ledger buys what was configured and not the cap", async () => {
  /*
   * `autoEnter` runs off the 50ms loop and skipped a wallet only once
   * `seatsOf` had it. With a 250ms ledger that is five independent auto-buys
   * before the first records anything, each of which passed a post-await
   * re-check that enforced the GLOBAL cap and never the caller's own target.
   * A player with auto on and one plate configured was charged 0.5 SOL a
   * round, every round, without touching anything.
   */
  const t = table({ latencyMs: 30 });
  const s = fakeSession("WalletA");
  t.game.attach(s);
  t.db.player("WalletA");
  t.db.setAuto("WalletA", true, 2, 1);

  // Ten passes of the lobby loop inside one hold.
  for (let i = 0; i < 10; i++) t.g.autoEnter();
  await after(120);
  await settleAll();

  assert.equal(t.holds.length, 1, "one plate was configured, so one stake moved");
  assert.equal(t.g.seatsOf.get("WalletA")?.length, 1);
  t.db.close();
});

test("auto play with three plates configured buys exactly three", async () => {
  const t = table({ latencyMs: 20 });
  const s = fakeSession("WalletB");
  t.game.attach(s);
  t.db.player("WalletB");
  t.db.setAuto("WalletB", true, 2, 3);

  for (let i = 0; i < 10; i++) t.g.autoEnter();
  await after(200);
  await settleAll();
  for (let i = 0; i < 5; i++) t.g.autoEnter();
  await after(100);
  await settleAll();

  assert.equal(t.holds.length, 3, "the target is the ceiling, on every pass");
  assert.equal(t.g.seatsOf.get("WalletB")?.length, 3);
  t.db.close();
});

test("a round that rolls over during a hold does not seat anybody in the next one", async () => {
  /*
   * `openLobby` resets seat numbering to 1. A stake held for round R and
   * written into round R+1 lands on a seat id that round may have already
   * sold: the entry row collides and `seats.set` overwrites a stranger's seat
   * outright, redirecting their payout. Three seconds of timing margin, held
   * by config values in two different repositories, was the whole defence.
   */
  const t = table({ latencyMs: 30 });
  const s = fakeSession("WalletA");
  t.game.attach(s);

  const pending = t.game.join(s);
  const wasRound = t.g.roundId;
  t.g.openLobby();
  const answer = await pending;
  await flush();

  assert.match(String(answer), /sealed while the stake was moving/);
  assert.equal(t.g.roundId, wasRound + 1);
  assert.equal(t.g.seats.size, 0, "nothing was written into the new round");
  assert.deepEqual(t.releases, [{ roundId: wasRound, seat: 1 }], "and the stake went back");
  t.db.close();
});

test("a hold the books answer with an EXISTING hold does not sell a seat", async () => {
  // Refs are idempotent, so a 200 does not by itself mean this stake just
  // moved. Seating on a replayed ref is a plate nobody paid for -- and the
  // hold that came back belongs to whoever made it, so it is not released.
  const t = table();
  const s = fakeSession("WalletA");
  t.game.attach(s);
  t.state.replayNext = true;

  const answer = await t.game.join(s);
  assert.match(String(answer), /nothing was staked/);
  assert.equal(t.g.seats.size, 0);
  assert.equal(t.releases.length, 0, "a stranger's live stake is not handed back");
  t.db.close();
});

test("a hold whose answer is lost is released rather than declared untouched", async () => {
  /*
   * The old message said "your money has not been touched", which this code
   * cannot know: the 5s abort is OURS, so a request that arrived and lost only
   * its response leaves a real hold under this exact ref. The player watches
   * the balance move while being told it did not.
   */
  const t = table();
  const s = fakeSession("WalletA");
  t.game.attach(s);
  t.state.holdError = "LEDGER_UNREACHABLE";

  const answer = await t.game.join(s);
  await settleAll();

  assert.doesNotMatch(String(answer), /has not been touched/);
  assert.match(String(answer), /being returned/);
  assert.equal(t.releases.length, 1, "the release is attempted, and it is idempotent");
  t.db.close();
});

test("a guest is turned away before the arcade's books are ever asked", () => {
  // `{t:"guest"}` needs no signature, and a wallet that never gets a seat
  // never trips a cap -- so every message was a free POST against the SQLite
  // file every game on this box shares.
  const t = table();
  const s = fakeSession("guest:aaaaaaaa", true);
  t.game.attach(s);

  return t.game.join(s).then((answer) => {
    assert.match(String(answer), /connect a wallet/);
    assert.equal(t.holds.length, 0, "no round trip at all");
    t.db.close();
  });
});

/* ---- settlement, and what a seat number is worth as an identity ---- */

test("a pending payout survives the same seat number coming round again", async () => {
  /*
   * Seat ids restart at 1 every lobby, and the pending set held only the
   * number. Round R seat 3 wins 8x and its settle fails; round R+1's seat 3
   * dies, settles fine, and its `.then()` deleted round R's entry. The winner
   * was then never paid: their hold stayed open until a restart, at which
   * point the startup sweep RELEASED it -- handing back a 0.1 SOL stake in
   * place of 0.8 SOL of winnings.
   */
  const t = table();
  t.db.player("Winner");
  t.db.takeEntry(t.g.roundId, "Winner", STAKE, 3);
  const roundOne = t.g.roundId;

  t.state.settleError = "LEDGER_UNREACHABLE";
  t.g.settleExit("Winner", 3, 0.8, 12, "cashed");
  await settleAll();
  assert.ok(t.g.unsettled.has(`r${roundOne}:s3`), "round R's seat 3 is owed money");

  // A new round, a different player, the same seat number, and it settles.
  // The lobby's own reconcile pass runs first and is still refused, which is
  // what leaves round R's entry standing to be collided with.
  t.g.openLobby();
  await settleAll();
  t.state.settleError = null;
  t.db.player("Loser");
  t.db.takeEntry(t.g.roundId, "Loser", STAKE, 3);
  t.g.settleExit("Loser", 3, 0, 5, "dead");
  await settleAll();

  assert.ok(
    t.g.unsettled.has(`r${roundOne}:s3`),
    "and round R's entry is still there, which is the whole bug",
  );

  await t.g.reconcileBooks();
  assert.deepEqual(
    t.settles.filter((s) => s.roundId === roundOne),
    [{ roundId: roundOne, seat: 3, payout: toLamports(0.8) }],
    "the winner is paid what the entry row says, not what memory said",
  );
  assert.equal(t.g.unsettled.size, 0);
  t.db.close();
});

test("a release the books refuse is queued and asked again", async () => {
  // Settlement had a durable retry and release had nothing but the startup
  // sweep -- so a player who stepped off watched their stake sit in escrow for
  // as long as the process happened to stay up, with the local row already
  // gone and nothing pointing at it.
  const t = table();
  const s = fakeSession("WalletA");
  t.game.attach(s);
  await t.game.join(s);
  t.state.releaseError = "LEDGER_UNREACHABLE";

  await t.game.unjoin(s);
  assert.equal(t.g.unreleased.size, 1, "the failure is remembered rather than logged and dropped");
  assert.equal(t.releases.length, 0);

  t.state.releaseError = null;
  await t.g.reconcileBooks();
  assert.equal(t.releases.length, 1, "and asked again once the books answer");
  assert.equal(t.g.unreleased.size, 0);
  t.db.close();
});

/* ---- the seed, and what the commitment covers ---- */

test("no seed exists while the lobby is open, and the commitment still does", async () => {
  /*
   * Elimination consumes one draw per live player in join order and the hazard
   * curve reads live/total, so a seed known during the lobby makes who dies a
   * pure function of join order and entrant count -- both of which the server
   * decides, after seeing it. No grinding required, and the replay verifies
   * perfectly because the record honestly states the order that was used.
   */
  const t = table();
  assert.equal(t.g.seedHex, "", "there is nothing to steer with");
  assert.equal(t.g.sealNonce, "");
  assert.match(t.g.secretHex, /^[0-9a-f]{32}$/);
  assert.equal(
    t.g.commit,
    commitmentFor(t.g.roundId, t.g.secretHex, RULES),
    "and the hash on screen during the lobby is over the secret",
  );

  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  t.g.seal();

  assert.match(t.g.sealNonce, /^[0-9a-f]{32}$/, "drawn only once the entrants are final");
  assert.equal(
    t.g.seedHex,
    roundSeedFrom(t.g.secretHex, t.g.sealNonce, [1, 2]),
    "and the entrant list is inside the seed",
  );
  assert.notEqual(
    roundSeedFrom(t.g.secretHex, t.g.sealNonce, [2, 1]),
    t.g.seedHex,
    "so swapping two joins is no longer free",
  );
  t.db.close();
});

test("sealing reserves the round's worst case against the arcade's house", async () => {
  const t = table();
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  const round = t.g.roundId;
  t.g.seal();
  await settleAll();

  // Self-funding in the ordinary case; the exposure is what the recovery paths
  // could cost, which is one seat banking the whole pot while every other
  // stake is released: pot minus that seat's own entry.
  const pot = 2 * DEFAULT_CONFIG.entry * (1 - totalRake(DEFAULT_CONFIG));
  assert.deepEqual(t.reserves, [
    { roundId: round, amount: toLamports(pot) - toLamports(DEFAULT_CONFIG.entry) },
  ]);
  t.db.close();
});

test("an arcade with no exposure register does not stop the round", async () => {
  // The reservation is a backstop. Refusing to seal a table whose payouts are
  // already fully funded by held stakes, because a backstop is unreachable,
  // would be strictly worse for every player at it.
  const t = table();
  t.state.exposureError = new LedgerError("NOT_FOUND", "no such route", 404);
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  t.g.seal();
  await settleAll();

  assert.equal(t.g.phase, "live");
  assert.equal(t.reserves.length, 0);
  t.db.close();
});

/* ---- extraction, and the rule the HUD used to own alone ---- */

test("extraction during grace is refused by the server, not just hidden", async () => {
  // The HUD hides the button; a scripted client sent the message anyway and
  // banked 0.98x, below the stake it had just paid. A rule the server does not
  // hold is not a rule, and this one is inside the rules hash.
  const t = table();
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  t.g.seal();

  t.game.cashOut(a);
  await settleAll();
  assert.equal(t.settles.length, 0, "nothing banked on tick zero");
  assert.equal(t.g.round?.players.find((p) => p.id === 1)?.outcome, "in");

  for (let i = 0; i < DEFAULT_CONFIG.hazard.graceTicks; i++) t.g.tick();
  t.game.cashOut(a);
  await settleAll();
  assert.ok(t.settles.length > 0, "and it unlocks on exactly the tick the HUD says it does");
  t.db.close();
});

/* ---- the tick loop throwing ---- */

test("an aborted round rolls back BOTH halves and stays verifiable", async () => {
  /*
   * `abortRound` did the local half and not the ledger half, while its comment
   * claimed it rolled back "exactly like the startup sweep would". The startup
   * path does two things; this did one. So every stake stayed in arcade escrow
   * -- reading `held` rather than `free` in every game on the box -- while the
   * local rows said 'refunded', and the round itself was never closed, which
   * made it a round that took real money and can never be proved.
   */
  const t = table();
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  const round = t.g.roundId;
  const secret = t.g.secretHex;
  t.g.seal();
  t.g.tick();

  t.g.abortRound(new Error("something in the tick loop"));
  await settleAll();

  assert.equal(t.state.sweeps, 1, "the ledger half, which used to be missing");
  assert.deepEqual(t.exposureReleases, [round], "and the room it was holding");
  assert.equal(t.g.seats.size, 0, "the board is cleared, not left reporting everyone as alive");
  assert.equal(t.g.seatsOf.size, 0);
  assert.equal(t.g.unsettled.size, 0, "nothing is retried against holds that were just swept");
  assert.equal(t.g.round, null);
  assert.equal(t.g.phase, "result");
  assert.deepEqual((a.last as { players: unknown[] }).players, [], "and the screen agrees");

  const rows = t.db.historyFor("WalletA");
  assert.equal(rows.length, 1, "the round is in history rather than hidden forever");
  assert.equal(rows[0]!.roundId, round);
  assert.equal(rows[0]!.seedHex, secret, "with the commitment's secret revealed");
  const record = JSON.parse(rows[0]!.record) as { interrupted?: boolean; entrantIds: number[] };
  assert.equal(record.interrupted, true, "and marked so a verifier says 'nothing to replay'");
  assert.deepEqual(record.entrantIds, [1, 2]);
  assert.equal(rows[0]!.returned, STAKE, "the stake is booked back at 1x");
  t.db.close();
});

test("a round aborted mid-flight leaves a settled seat's payout alone", async () => {
  /*
   * The other half of the same failure: `refundOpenEntries` selected every row
   * that was not already 'refunded', which includes seats that had cashed. It
   * rewrote a real payout to `returned = staked` and decremented the player's
   * lifetime total by the difference, while the sweep handed every other stake
   * back -- and `~house` covered the gap with `overdraft: true`.
   */
  const t = table();
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  const c = fakeSession("WalletC");
  t.game.attach(a);
  t.game.attach(b);
  t.game.attach(c);
  await t.game.join(a);
  await t.game.join(b);
  await t.game.join(c);
  const round = t.g.roundId;
  t.g.seal();

  // Booked directly at 8x rather than played to it: what matters here is a row
  // that has genuinely settled while its neighbours are still open, and
  // waiting for the dice to produce one would make the test a coin flip.
  t.g.settleExit("WalletA", 1, DEFAULT_CONFIG.entry * 8, 14, "cashed");
  await settleAll();
  const paid = t.db.owedFor(round, 1);
  assert.equal(paid, toLamports(DEFAULT_CONFIG.entry * 8), "A was paid, and the row says so");
  assert.ok(paid !== null && paid > STAKE);

  t.g.abortRound(new Error("crash after a big extraction"));
  await flush();

  assert.equal(t.db.owedFor(round, 1), paid, "the cash-out stands: they were actually paid");
  assert.equal(t.db.player("WalletA").returned, paid, "and so does the lifetime total");
  t.db.close();
});

test("the state a player sees after an abort does not claim they are still in", async () => {
  const t = table();
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  t.g.seal();
  t.g.abortRound(new Error("boom"));
  await settleAll();

  const state = a.last as { you: { joined: boolean; outcome: string }; liveCount: number };
  assert.equal(state.you.joined, false);
  assert.equal(state.you.outcome, "out");
  assert.equal(state.liveCount, 0);
  t.db.close();
});

test("a clean shutdown closes the open round instead of only stopping the clock", async () => {
  /*
   * `stop()` cancelled the timer and nothing else, so a deploy restart left
   * exactly what a crash leaves: entries still open, and a published
   * commitment with no reveal that `historyFor` excludes forever. The startup
   * sweep rescues the money either way; it cannot rescue the proof, and a
   * shutdown we chose should not need rescuing at all.
   */
  const t = table();
  const a = fakeSession("WalletA");
  const b = fakeSession("WalletB");
  t.game.attach(a);
  t.game.attach(b);
  await t.game.join(a);
  await t.game.join(b);
  const round = t.g.roundId;
  const secret = t.g.secretHex;
  t.g.seal();

  t.game.shutdown();

  const rows = t.db.historyFor("WalletA");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.roundId, round);
  assert.equal(rows[0]!.seedHex, secret, "the commitment is answered rather than abandoned");
  assert.equal(rows[0]!.returned, STAKE, "and the stake is booked back");
  t.db.close();
});
