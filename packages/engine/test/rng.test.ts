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
  assert.deepEqual(take(rngFromSeedHex("f".repeat(32)), 3), [
    0.7800596803426743, 0.5163531841244549, 0.12097864295355976,
  ]);
  assert.deepEqual(take(rngFromSeedHex("0".repeat(32)), 3), [
    0.9396795427892357, 0.317481443984434, 0.03381406492553651,
  ]);
});

test("a seed short enough to brute-force is refused, not zero-padded", () => {
  for (const bad of ["", "0", "deadbeef", "0".repeat(31), "abc123"]) {
    assert.throws(() => rngFromSeedHex(bad), /at least 128 bits/, `accepted "${bad}"`);
  }
  for (const bad of ["g".repeat(32), `${"0".repeat(31)}x`, `0x${"0".repeat(32)}`]) {
    assert.throws(() => rngFromSeedHex(bad), /at least 128 bits/, `accepted "${bad}"`);
  }
  assert.equal(Number.isFinite(rngFromSeedHex("0".repeat(32)).next()), true);
});

test("a longer seed is accepted and case cannot change the stream", () => {
  assert.deepEqual(take(rngFromSeedHex(SEED.toUpperCase()), 4), take(rngFromSeedHex(SEED), 4));
  assert.deepEqual(take(rngFromSeedHex(`${SEED}${"9".repeat(32)}`), 4), take(rngFromSeedHex(SEED), 4));
});

test("the seed is diffused before anyone reads a draw", () => {
  assert.notEqual(sfc32(0, 0, 0, 0).next(), 0);
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
    assert.ok(Math.abs(hits[b]! - expected) < 0.04 * expected, `bucket ${b} off: ${hits[b]}`);
  }
});

test("the simulation PRNG is deterministic and stays out of live rounds", () => {
  assert.equal(mulberry32(1).next(), 0.6270739405881613);
  assert.deepEqual(take(mulberry32(7), 50), take(mulberry32(7), 50));
  assert.throws(() => rngFromSeedHex(seedFromString("any run name").toString(16)));
});

test("a simulation run name maps to a stable seed", () => {
  assert.equal(seedFromString("thin-ice"), 4049743336);
  assert.equal(seedFromString(""), 2166136261);
  assert.equal(seedFromString("a"), seedFromString("a"));
  assert.notEqual(seedFromString("ab"), seedFromString("ba"), "order must matter");
  assert.ok(seedFromString("\u{1f9ca}") >>> 0 === seedFromString("\u{1f9ca}"), "always uint32");
});
