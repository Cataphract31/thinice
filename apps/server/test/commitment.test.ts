/*
 * The commit-reveal ceremony, as a string.
 *
 * Before a round seals the server publishes sha256("thinice:2:{roundId}:
 * {secret}:{rulesHash}"). When the round is over it reveals that secret, and
 * anyone can recompute the hash, check it against what was published, rebuild
 * the seed the round actually ran on, and replay it. The engine's side of this
 * is covered in packages/engine/test/fairness.test.ts; what is tested here is
 * the preimage itself, which is the part a verifier has to reconstruct EXACTLY
 * or the check fails for an honest round.
 *
 * Three things have to hold and each is a separate way to build a ceremony
 * that proves nothing: the rules have to be in the hash (or the round can be
 * replayed under different numbers than it was played under), the secret has
 * to be in the hash (or the draw can be chosen after the fact), and the round
 * id has to be in the hash (or one round's commitment is another's).
 *
 * THE SECOND HALF OF THE CEREMONY IS TESTED HERE TOO. The committed secret is
 * not the seed: the seed is derived from it at the seal, together with a nonce
 * drawn once the entrant list is final and with that list itself. Without
 * that, whoever holds the seed through the lobby picks the winner by choosing
 * join order -- no grinding needed -- and the replay still verifies, because
 * the record honestly states the order that was used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DEFAULT_CONFIG, roundSeedPreimage, type GameConfig } from "@zinc/engine";
import {
  CEREMONY,
  commitPreimage,
  commitmentFor,
  roundSeedFrom,
  rulesHashOf,
} from "../src/game.ts";

const SEED = "0123456789abcdef0123456789abcdef";
const RULES = rulesHashOf(DEFAULT_CONFIG);

test("the preimage is the documented format, field for field", () => {
  // Pinned as a literal because a verifier elsewhere has to build this same
  // string. Changing the format is a breaking change to every published
  // commitment, not a refactor -- if this fails, that is the question.
  assert.equal(commitPreimage(7, SEED, "abc"), `thinice:2:7:${SEED}:abc`);
  assert.equal(commitPreimage(0, "", ""), "thinice:2:0::");
});

test("the ceremony version is inside the commitment, so it cannot be downgraded", () => {
  /*
   * The version is what stops an operator committing under the ceremony that
   * binds the entrant set and then shipping a record shaped like the one that
   * does not. Without the tag a verifier would fall back to the old chain --
   * whose hash it can still compute perfectly well -- and the downgrade would
   * render as a green tick.
   */
  assert.equal(CEREMONY, 2);
  const asV1 = createHash("sha256").update(`thinice:7:${SEED}:${RULES}`).digest("hex");
  assert.notEqual(
    commitmentFor(7, SEED, RULES),
    asV1,
    "a v1 preimage must not satisfy a v2 commitment",
  );
});

test("the commitment is sha256 of that string and nothing else", () => {
  const byHand = createHash("sha256").update(`thinice:2:7:${SEED}:${RULES}`).digest("hex");
  assert.equal(commitmentFor(7, SEED, RULES), byHand);
  assert.match(commitmentFor(7, SEED, RULES), /^[0-9a-f]{64}$/);
});

test("the seed is derived from the secret, the seal nonce AND the entrant list", () => {
  const NONCE = "fedcba9876543210fedcba9876543210";
  const seed = roundSeedFrom(SEED, NONCE, [1, 2, 3]);
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.equal(
    seed,
    createHash("sha256").update(roundSeedPreimage(SEED, NONCE, [1, 2, 3])).digest("hex"),
    "one preimage builder, shared with the browser that verifies it",
  );

  // Every input moves the seed, and the entrant list moves it in each of the
  // three ways a hostile operator would want to move it.
  const base = seed;
  assert.notEqual(roundSeedFrom(`${SEED.slice(0, 31)}0`, NONCE, [1, 2, 3]), base, "secret is bound");
  assert.notEqual(roundSeedFrom(SEED, `${NONCE.slice(0, 31)}f`, [1, 2, 3]), base, "nonce is bound");
  assert.notEqual(roundSeedFrom(SEED, NONCE, [2, 1, 3]), base, "ORDER is bound");
  assert.notEqual(roundSeedFrom(SEED, NONCE, [1, 2, 3, 4]), base, "an added seat is bound");
  assert.notEqual(roundSeedFrom(SEED, NONCE, [1, 2]), base, "a dropped seat is bound");
});

test("the derived seed is long enough for the live RNG, by construction", () => {
  // rngFromSeedHex refuses anything under 128 bits and a sha256 digest is 256.
  // Stated as a test because the derivation is what feeds the live round now:
  // truncating the digest for tidiness would stop rounds from starting at all.
  assert.equal(roundSeedFrom("a", "b", []).length, 64);
});

test("every field moves the commitment", () => {
  const base = commitmentFor(7, SEED, RULES);
  assert.notEqual(commitmentFor(8, SEED, RULES), base, "round id is bound");
  assert.notEqual(commitmentFor(7, `${SEED.slice(0, 31)}0`, RULES), base, "the secret is bound");
  assert.notEqual(commitmentFor(7, SEED, rulesHashOf({ ...DEFAULT_CONFIG, entry: 0.2 })), base,
    "rules are bound");
});

test("the rules hash covers the rules a round is actually played under", () => {
  // Not a spot check of one field: canonicalConfig is what makes this total,
  // and packages/engine/test/fairness.test.ts sweeps every rule through it.
  // What is asserted here is the join -- that this server hashes the canonical
  // form and not, say, JSON.stringify of whatever key order it happened to hold.
  assert.match(RULES, /^[0-9a-f]{64}$/);
  const reordered = {
    field: DEFAULT_CONFIG.field,
    hazard: DEFAULT_CONFIG.hazard,
    timing: DEFAULT_CONFIG.timing,
    rake: DEFAULT_CONFIG.rake,
    entry: DEFAULT_CONFIG.entry,
  } as GameConfig;
  assert.equal(rulesHashOf(reordered), RULES, "key order must not move the commitment");
  assert.equal(rulesHashOf(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as GameConfig), RULES,
    "and neither must a JSON round trip on the way to a verifier");
});

test("no two rounds can share a commitment by field-boundary accident", () => {
  // The colon-separated form is only unambiguous because the fields cannot
  // contain colons: the round id is a number, and both hashes are hex. This
  // states that as a test so a future field of free text is caught here rather
  // than by two rounds verifying against each other's hash.
  assert.doesNotMatch(RULES, /:/);
  assert.match(SEED, /^[0-9a-f]+$/);
  // The failure the constraint prevents, spelled out: without it, these two
  // different rounds would produce one preimage.
  assert.notEqual(commitPreimage(1, "2", "3"), commitPreimage(1, "2:3", ""));
});

test("the same inputs always commit to the same hash", () => {
  // A verifier runs this minutes or months later, on another machine.
  for (let i = 0; i < 3; i++) assert.equal(commitmentFor(42, SEED, RULES), commitmentFor(42, SEED, RULES));
  assert.equal(rulesHashOf(DEFAULT_CONFIG), rulesHashOf({ ...DEFAULT_CONFIG }));
});
