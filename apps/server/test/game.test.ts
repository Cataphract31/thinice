import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, totalRake } from "@zinc/engine";
import { Database } from "../src/db.ts";
import { CONFIG, toLamports } from "../src/config.ts";
import { GameServer, roundSeedFrom, commitmentFor, rulesHashOf, type Session } from "../src/game.ts";
import { LedgerError, type ArcadeLedger } from "../src/arcade.ts";

const STAKE = toLamports(DEFAULT_CONFIG.entry);
const RULES = rulesHashOf(DEFAULT_CONFIG);

const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const flush = async (ms = 80): Promise<void> => {
  await after(ms);
  await settleAll();
};

function fakeLedger() {
  const holds: { wallet: string; roundId: number; seat: number; amount: number }[] = [];
  const settles: { roundId: number; seat: number; payout: number }[] = [];
  const releases: { roundId: number; seat: number }[] = [];
  const reserves: { roundId: number; amount: number }[] = [];
  const exposureReleases: number[] = [];
  const state = {
    latencyMs: 0,
    holdError: null as string | null,
    settleError: null as string | null,
    releaseError: null as string | null,
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

function table(opts: { latencyMs?: number } = {}) {
  const db = new Database(":memory:");
  const fake = fakeLedger();
  fake.state.latencyMs = opts.latencyMs ?? 0;
  const game = new GameServer(db, fake.ledger);
  game.start();
  game.stop();
  return { db, game, g: inner(game), ...fake };
}

test("ten bond presses in one tick buy five plates, not ten", async () => {
  const t = table({ latencyMs: 20 });
  const s = fakeSession("WalletA");
  t.game.attach(s);

  const answers = await Promise.all(Array.from({ length: 10 }, () => t.game.join(s)));

  assert.equal(t.holds.length, CONFIG.maxPlatesPerWallet, "one hold per plate the cap allows");
  assert.equal(answers.filter((a) => a === null).length, CONFIG.maxPlatesPerWallet);
  assert.equal(t.g.seatsOf.get("WalletA")?.length, CONFIG.maxPlatesPerWallet);
  assert.equal(t.g.seats.size, CONFIG.maxPlatesPerWallet, "and no plate is orphaned");
  for (const a of answers.filter((x) => x !== null)) assert.match(String(a), /plate limit/);
  t.db.close();
});

test("stepping off while the stake is moving is honoured, not silently ignored", async () => {
  const t = table({ latencyMs: 20 });
  const s = fakeSession("WalletA");
  t.game.attach(s);
  t.db.setAuto("WalletA", true, 2, 1);

  const joins = [t.game.join(s), t.game.join(s), t.game.join(s)];
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
  const t = table({ latencyMs: 30 });
  const s = fakeSession("WalletA");
  t.game.attach(s);
  t.db.player("WalletA");
  t.db.setAuto("WalletA", true, 2, 1);

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
  const t = table();
  const s = fakeSession("guest:aaaaaaaa", true);
  t.game.attach(s);

  return t.game.join(s).then((answer) => {
    assert.match(String(answer), /connect a wallet/);
    assert.equal(t.holds.length, 0, "no round trip at all");
    t.db.close();
  });
});

test("a pending payout survives the same seat number coming round again", async () => {
  const t = table();
  t.db.player("Winner");
  t.db.takeEntry(t.g.roundId, "Winner", STAKE, 3);
  const roundOne = t.g.roundId;

  t.state.settleError = "LEDGER_UNREACHABLE";
  t.g.settleExit("Winner", 3, 0.8, 12, "cashed");
  await settleAll();
  assert.ok(t.g.unsettled.has(`r${roundOne}:s3`), "round R's seat 3 is owed money");

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

test("no seed exists while the lobby is open, and the commitment still does", async () => {
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

  const pot = 2 * DEFAULT_CONFIG.entry * (1 - totalRake(DEFAULT_CONFIG));
  assert.deepEqual(t.reserves, [
    { roundId: round, amount: toLamports(pot) - toLamports(DEFAULT_CONFIG.entry) },
  ]);
  t.db.close();
});

test("an arcade with no exposure register does not stop the round", async () => {
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

test("extraction during grace is refused by the server, not just hidden", async () => {
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

test("an aborted round rolls back BOTH halves and stays verifiable", async () => {
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
