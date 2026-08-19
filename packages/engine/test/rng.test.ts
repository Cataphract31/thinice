/*
 * The round stream, and the vectors that pin it.
 *
 * Thin Ice publishes sha256 of the seed BEFORE a round runs and reveals the
 * seed after, so this file is where "provably fair" is either true or a
 * decoration. Two properties carry the whole claim and both are tested here:
 * the stream must be reproducible bit-for-bit from the seed alone (or nobody
 * can verify a round), and the seed must be too large to enumerate against
 * the published hash (or the commitment hands the seed to anyone who wants
 * it, and every elimination is known before a plate cracks).
 *
 * ON THE PINNED VECTORS. These were generated from THIS implementation, not
 * inherited from an earlier one, so they are a regression guard and nothing
 * more: they prove the stream has not moved, not that it was ever right. That
 * is still the property worth nailing down, because sfc32's output is fixed
 * by the int32 ops ECMAScript specifies exactly, and a round replayed in a
 * browser must reproduce what the server rolled. If one of these fails, the
 * question is what changed in rng.ts -- NOT whether to regenerate the number.
 * Regenerating them to make the suite green silently invalidates every round
 * ever verified against the old stream.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sfc32, rngFromSeedHex, mulberry32, seedFromString, type Rng } from "../src/rng.js";

const SEED = "0123456789abcdef0123456789abcdef";

const take = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.next());

test("the live stream still reproduces its pinned vectors exactly", () => {
  assert.deepEqual(take(rngFromSeedHex(SEED), 5), [
    0.8219981321599334, 0.6375069217756391, 0.536356320604682,
    0.5420460167806596, 0.5736625213176012,
  ]);
  // Both extremes of the seed space, because a stream that only works for
  // "interesting" seeds is a stream with a branch nobody meant to write.
  assert.deepEqual(take(rngFromSeedHex("f".repeat(32)), 3), [
    0.7800596803426743, 0.5163531841244549, 0.12097864295355976,
  ]);
  assert.deepEqual(take(rngFromSeedHex("0".repeat(32)), 3), [
    0.9396795427892357, 0.317481443984434, 0.03381406492553651,
  ]);
});

test("a seed short enough to brute-force is refused, not zero-padded", () => {
  // THIS IS THE COMMITMENT'S ONLY DEFENCE. A 32-bit seed is 4.3 billion
  // candidates against a published hash -- seconds of GPU time, well inside a
  // lobby. Padding a short seed to length would produce a stream that looks
  // fine and is fully predictable from the commitment the game publishes to
  // prove it is honest.
  for (const bad of ["", "0", "deadbeef", "0".repeat(31), "abc123"]) {
    assert.throws(() => rngFromSeedHex(bad), /at least 128 bits/, `accepted "${bad}"`);
  }
  // Not hex is refused for the same reason: parseInt would return NaN, NaN
  // >>> 0 is 0, and the round would quietly run on seed zero.
  for (const bad of ["g".repeat(32), `${"0".repeat(31)}x`, `0x${"0".repeat(32)}`]) {
    assert.throws(() => rngFromSeedHex(bad), /at least 128 bits/, `accepted "${bad}"`);
  }
  assert.equal(Number.isFinite(rngFromSeedHex("0".repeat(32)).next()), true);
});

test("a longer seed is accepted and case cannot change the stream", () => {
  // A verifier that lowercases the revealed seed, or a server that emits it
  // uppercase, must not produce a different round from the one that was played.
  assert.deepEqual(take(rngFromSeedHex(SEED.toUpperCase()), 4), take(rngFromSeedHex(SEED), 4));
  // Only the first 128 bits are consumed, so a 64-character seed is legal and
  // its tail is decoration. Stated as a test because it is a real hazard: two
  // seeds sharing a prefix replay identically.
  assert.deepEqual(take(rngFromSeedHex(`${SEED}${"9".repeat(32)}`), 4), take(rngFromSeedHex(SEED), 4));
});

test("the seed is diffused before anyone reads a draw", () => {
  // Without the 12 warm-up draws sfc32(0,0,0,0) returns EXACTLY 0 first, and
  // the low seeds stay visibly correlated with early output for several more.
  // This asserts the warm-up is still there by asserting the tell it removes.
  assert.notEqual(sfc32(0, 0, 0, 0).next(), 0);
  // Avalanche: one bit of seed difference must not survive into the output.
  const a = take(rngFromSeedHex("0".repeat(32)), 3);
  const b = take(rngFromSeedHex(`${"0".repeat(31)}1`), 3);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) > 1e-3, `draw ${i} barely moved: ${a[i]} vs ${b[i]}`);
  }
});

test("the same seed replays exactly, and different seeds do not", () => {
  assert.deepEqual(take(rngFromSeedHex(SEED), 200), take(rngFromSeedHex(SEED), 200));
  const other = take(rngFromSeedHex(`${"0".repeat(31)}1`), 200);
  assert.notDeepEqual(take(rngFromSeedHex(SEED), 200), other);
});

test("every draw is a uniform in [0, 1), with no bias a hazard roll would inherit", () => {
  // The round compares next() against a hazard of a few percent, so a stream
  // biased low kills more players than the published curve says it does.
  const rng = rngFromSeedHex(SEED);
  const BUCKETS = 10, N = 200_000;
  const hits = new Array<number>(BUCKETS).fill(0);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const u = rng.next();
    assert.ok(u >= 0 && u < 1, `draw ${i} escaped [0, 1): ${u}`);
    sum += u;
    hits[Math.floor(u * BUCKETS)]! += 1;
  }
  assert.ok(Math.abs(sum / N - 0.5) < 0.005, `mean drifted: ${sum / N}`);
  const expected = N / BUCKETS;
  for (let b = 0; b < BUCKETS; b++) {
    // ~4 sigma. Fixed seed, so this is deterministic: it cannot flake.
    assert.ok(Math.abs(hits[b]! - expected) < 0.04 * expected, `bucket ${b} off: ${hits[b]}`);
  }
});

test("the simulation PRNG is deterministic and stays out of live rounds", () => {
  // mulberry32 is fine for bulk simulation and catastrophic for a live round:
  // its whole state is 32 bits. The engine cannot enforce "never live" by
  // type, so the guard that actually holds is rngFromSeedHex refusing every
  // seed small enough to feed it -- asserted above and restated here as the
  // reason this function is allowed to exist at all.
  assert.equal(mulberry32(1).next(), 0.6270739405881613);
  assert.deepEqual(take(mulberry32(7), 50), take(mulberry32(7), 50));
  assert.throws(() => rngFromSeedHex(seedFromString("any run name").toString(16)));
});

test("a simulation run name maps to a stable seed", () => {
  // Named runs are how a bad simulation result gets reproduced later, so this
  // mapping is not allowed to move between builds.
  assert.equal(seedFromString("thin-ice"), 4049743336);
  assert.equal(seedFromString(""), 2166136261);
  assert.equal(seedFromString("a"), seedFromString("a"));
  assert.notEqual(seedFromString("ab"), seedFromString("ba"), "order must matter");
  assert.ok(seedFromString("\u{1f9ca}") >>> 0 === seedFromString("\u{1f9ca}"), "always uint32");
});
