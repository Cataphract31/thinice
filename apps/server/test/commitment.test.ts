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
  assert.equal(commitPreimage(7, SEED, "abc"), `thinice:2:7:${SEED}:abc`);
  assert.equal(commitPreimage(0, "", ""), "thinice:2:0::");
});

test("the ceremony version is inside the commitment, so it cannot be downgraded", () => {
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

  const base = seed;
  assert.notEqual(roundSeedFrom(`${SEED.slice(0, 31)}0`, NONCE, [1, 2, 3]), base, "secret is bound");
  assert.notEqual(roundSeedFrom(SEED, `${NONCE.slice(0, 31)}f`, [1, 2, 3]), base, "nonce is bound");
  assert.notEqual(roundSeedFrom(SEED, NONCE, [2, 1, 3]), base, "ORDER is bound");
  assert.notEqual(roundSeedFrom(SEED, NONCE, [1, 2, 3, 4]), base, "an added seat is bound");
  assert.notEqual(roundSeedFrom(SEED, NONCE, [1, 2]), base, "a dropped seat is bound");
});

test("the derived seed is long enough for the live RNG, by construction", () => {
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
  assert.doesNotMatch(RULES, /:/);
  assert.match(SEED, /^[0-9a-f]+$/);
  assert.notEqual(commitPreimage(1, "2", "3"), commitPreimage(1, "2:3", ""));
});

test("the same inputs always commit to the same hash", () => {
  for (let i = 0; i < 3; i++) assert.equal(commitmentFor(42, SEED, RULES), commitmentFor(42, SEED, RULES));
  assert.equal(rulesHashOf(DEFAULT_CONFIG), rulesHashOf({ ...DEFAULT_CONFIG }));
});
