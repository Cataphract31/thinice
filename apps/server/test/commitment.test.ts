/*
 * The commit-reveal ceremony, as a string.
 *
 * Before a round seals the server publishes sha256("thinice:{roundId}:
 * {seedHex}:{rulesHash}"). When the round is over it reveals the seed, and
 * anyone can recompute that hash, check it against what was published, and
 * replay the round. The engine's side of this is covered in
 * packages/engine/test/fairness.test.ts; what is tested here is the preimage
 * itself, which is the part a verifier has to reconstruct EXACTLY or the
 * check fails for an honest round.
 *
 * Three things have to hold and each is a separate way to build a ceremony
 * that proves nothing: the rules have to be in the hash (or the round can be
 * replayed under different numbers than it was played under), the seed has to
 * be in the hash (or it can be chosen after the fact), and the round id has to
 * be in the hash (or one round's commitment is another's).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DEFAULT_CONFIG, type GameConfig } from "@zinc/engine";
import { commitPreimage, rulesHashOf, commitmentFor } from "../src/game.ts";

const SEED = "0123456789abcdef0123456789abcdef";
const RULES = rulesHashOf(DEFAULT_CONFIG);

test("the preimage is the documented format, field for field", () => {
  // Pinned as a literal because a verifier elsewhere has to build this same
  // string. Changing the format is a breaking change to every published
  // commitment, not a refactor -- if this fails, that is the question.
  assert.equal(commitPreimage(7, SEED, "abc"), `thinice:7:${SEED}:abc`);
  assert.equal(commitPreimage(0, "", ""), "thinice:0::");
});

test("the commitment is sha256 of that string and nothing else", () => {
  const byHand = createHash("sha256").update(`thinice:7:${SEED}:${RULES}`).digest("hex");
  assert.equal(commitmentFor(7, SEED, RULES), byHand);
  assert.match(commitmentFor(7, SEED, RULES), /^[0-9a-f]{64}$/);
});

test("every field moves the commitment", () => {
  const base = commitmentFor(7, SEED, RULES);
  assert.notEqual(commitmentFor(8, SEED, RULES), base, "round id is bound");
  assert.notEqual(commitmentFor(7, `${SEED.slice(0, 31)}0`, RULES), base, "seed is bound");
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
