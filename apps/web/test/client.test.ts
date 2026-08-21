import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  Round,
  canonicalConfig,
  outcomeDigest,
  rngFromSeedHex,
  roundSeedPreimage,
} from "@zinc/engine";
import {
  commitPreimage,
  sha256Hex,
  verifyEntry,
  type HistoryEntry,
} from "../src/game/client";

// The fairness panel is the product's whole public claim, so its verdicts get
// adversarial fixtures: not just "an honest round verifies" but "the ways a
// dishonest server could try to look honest do not".

const CONFIG = DEFAULT_CONFIG;

async function honestRound(roundId = 7): Promise<{
  h: HistoryEntry;
  secret: string;
}> {
  const secret = "a1".repeat(16);
  const sealNonce = "b2".repeat(16);
  const entrantIds = [1, 2];
  const seedHex = await sha256Hex(roundSeedPreimage(secret, sealNonce, entrantIds));
  assert.ok(seedHex);
  const round = new Round(
    CONFIG,
    rngFromSeedHex(seedHex),
    entrantIds.map((id) => ({ id, strategyId: "human", strategy: () => false })),
  );
  const res = round.play();
  const rulesHash = await sha256Hex(canonicalConfig(CONFIG));
  assert.ok(rulesHash);
  const commit = await sha256Hex(commitPreimage(roundId, secret, rulesHash));
  assert.ok(commit);

  const seats = [1, 2];
  const claimed =
    res.players.reduce((a, p) => a + p.cashedOut, 0) / (CONFIG.entry * seats.length);

  const h: HistoryEntry = {
    roundId,
    entrants: res.entrants,
    ticks: res.ticks,
    joined: true,
    yourOutcome: "cashed",
    yourMultiple: claimed,
    bestMultiple: 1,
    commit,
    observedCommit: commit,
    seedHex: secret,
    verified: null,
    seedOk: null,
    replayOk: null,
    rulesOk: null,
    payoutOk: null,
    yourSeats: seats,
    record: {
      seedHex,
      sealNonce,
      config: CONFIG,
      entrantIds,
      cashOuts: res.cashOuts,
    },
    digest: outcomeDigest(res),
    winnerChar: null,
    winnerYou: false,
  };
  return { h, secret };
}

test("an honest round this browser witnessed from the lobby verifies", async () => {
  const { h } = await honestRound();
  await verifyEntry(h, CONFIG);
  assert.equal(h.verified, true);
  assert.equal(h.seedOk, true);
  assert.equal(h.replayOk, true);
  assert.equal(h.rulesOk, true);
  assert.equal(h.payoutOk, true);
  assert.equal(h.unwitnessed, undefined);
});

test("a self-consistent round the browser never witnessed is NOT verified", async () => {
  const { h } = await honestRound();
  h.observedCommit = undefined;
  await verifyEntry(h, CONFIG);
  assert.equal(h.verified, null, "self-consistency is not pre-registration");
  assert.equal(h.unwitnessed, true);
  assert.equal(h.replayOk, true, "the replay itself still checks out");
  assert.equal(h.seedOk, null, "the commit check is the part that cannot be done");
});

test("a server swapping the commitment after the fact fails", async () => {
  const { h } = await honestRound();
  h.observedCommit = "f".repeat(64);
  await verifyEntry(h, CONFIG);
  assert.equal(h.verified, false);
  assert.equal(h.seedOk, false);
});

test("a fabricated 'interrupted' lobby record cannot earn the badge", async () => {
  // This exact shape used to verify green: interrupted, no seed, seedsAgree
  // handed a free true, replay null passing as "not false".
  const secret = "c3".repeat(16);
  const rulesHash = await sha256Hex(canonicalConfig(CONFIG));
  assert.ok(rulesHash);
  const commit = await sha256Hex(commitPreimage(9, secret, rulesHash));
  assert.ok(commit);
  const h: HistoryEntry = {
    roundId: 9,
    entrants: 0,
    ticks: 0,
    joined: false,
    yourOutcome: "none",
    yourMultiple: null,
    bestMultiple: 0,
    commit,
    observedCommit: commit,
    seedHex: secret,
    verified: null,
    seedOk: null,
    replayOk: null,
    rulesOk: null,
    payoutOk: null,
    yourSeats: [],
    record: {
      interrupted: true,
      seedHex: "",
      sealNonce: "",
      config: CONFIG,
      entrantIds: [],
      cashOuts: [],
    },
    digest: "",
    winnerChar: null,
    winnerYou: false,
  };
  await verifyEntry(h, CONFIG);
  assert.equal(h.verified, null, "an unfinished round has no verdict to give");
  assert.equal(h.seedOk, null, "no seed was ever drawn; the check says neither yes nor no");
  assert.equal(h.checked, true);
});

test("a sealed-but-interrupted round checks its seed derivation but still gives no verdict", async () => {
  const { h, secret } = await honestRound();
  h.record.interrupted = true;
  h.digest = "";
  await verifyEntry(h, CONFIG);
  assert.equal(h.verified, null, "nothing finished, so nothing is fair or unfair");
  assert.equal(h.seedOk, true, "the secret and seal nonce still answer for themselves");
  assert.equal(h.replayOk, null);
  assert.equal(h.seedHex, secret);
});

test("a record replaying under doctored rules fails even when everything else lines up", async () => {
  const { h } = await honestRound();
  h.record = { ...h.record, config: { ...CONFIG, entry: 0.05 } };
  await verifyEntry(h, CONFIG);
  assert.equal(h.rulesOk, false);
  assert.equal(h.verified, false);
});

test("a tampered digest accuses the server instead of blessing it", async () => {
  const { h } = await honestRound();
  h.digest = h.digest.replace("cashed", "dead");
  await verifyEntry(h, CONFIG);
  assert.equal(h.replayOk, false);
  assert.equal(h.verified, false);
});
