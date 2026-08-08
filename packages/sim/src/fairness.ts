/**
 * Fairness and determinism certification.
 *
 * Two claims are load-bearing for a real-money build, and neither is checked
 * by the economics suite:
 *
 *   1. The round RNG is unpredictable. It was not: the seed used to be 32 bits,
 *      and since its hash is published before the round runs, an attacker could
 *      enumerate all four billion candidates inside the lobby and know every
 *      elimination in advance. The commitment meant to prove fairness was the
 *      oracle that broke it.
 *   2. A round replays bit-identically from its record. If it does not, the
 *      verify button accuses an honest operator.
 *
 * Run after any change to the RNG, the round loop, or the record format.
 */
import { randomBytes } from "node:crypto";
import {
  BONANZA_TAG,
  DEFAULT_CONFIG,
  Round,
  canonicalConfig,
  deriveRng,
  outcomeDigest,
  replayRound,
  rngFromSeedHex,
  sfc32,
  verifyBonanzaDraw,
  type Entrant,
} from "@zinc/engine";

let bad = 0;
const fail = (m: string) => { console.log("  FAIL " + m); bad++; };
const ok = (m: string) => console.log("  ok   " + m);

// ---------------------------------------------------------------- 1. uniformity
{
  const rng = rngFromSeedHex(randomBytes(16).toString("hex"));
  const BINS = 64, N = 6_000_000;
  const bins = new Array(BINS).fill(0);
  let min = 1, max = 0, sum = 0;
  for (let i = 0; i < N; i++) {
    const x = rng.next();
    if (x < 0 || x >= 1) fail(`out of range: ${x}`);
    bins[Math.floor(x * BINS)]++;
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  const exp = N / BINS;
  const chi2 = bins.reduce((a, b) => a + (b - exp) ** 2 / exp, 0);
  // 63 df: p=0.001 critical value is ~112.3; p=0.999 lower is ~32.5
  if (chi2 > 112.3 || chi2 < 32.5) fail(`chi2 ${chi2.toFixed(1)} outside [32.5, 112.3]`);
  else ok(`uniform: chi2=${chi2.toFixed(1)} (63 df), mean=${(sum / N).toFixed(5)}`);
}

// ------------------------------------------------------- 2. no short-cycle / bias
{
  // Consecutive-pair independence: 2D chi-square over a 32x32 grid.
  const rng = rngFromSeedHex(randomBytes(16).toString("hex"));
  const G = 32, N = 4_000_000;
  const grid = new Array(G * G).fill(0);
  for (let i = 0; i < N; i++) {
    const a = Math.floor(rng.next() * G), b = Math.floor(rng.next() * G);
    grid[a * G + b]++;
  }
  const exp = N / (G * G);
  const chi2 = grid.reduce((a, b) => a + (b - exp) ** 2 / exp, 0);
  const df = G * G - 1; // 1023
  // Normal approx: mean=df, sd=sqrt(2df)=45.2. Allow +/-5 sd.
  const sd = Math.sqrt(2 * df);
  if (Math.abs(chi2 - df) > 5 * sd) fail(`pair chi2 ${chi2.toFixed(0)} vs df ${df} +/- ${(5*sd).toFixed(0)}`);
  else ok(`pairs independent: chi2=${chi2.toFixed(0)} (df ${df}, sd ${sd.toFixed(1)})`);
}

// ------------------------------------------------- 3. distinct seeds -> distinct streams
{
  const seen = new Set<string>();
  for (let i = 0; i < 20000; i++) {
    const r = rngFromSeedHex(randomBytes(16).toString("hex"));
    const sig = [r.next(), r.next(), r.next()].map((x) => x.toFixed(9)).join(",");
    if (seen.has(sig)) fail(`stream collision after ${i} seeds`);
    seen.add(sig);
  }
  ok(`20,000 distinct seeds produced 20,000 distinct streams`);
}

// ------------------------------------------------------------ 4. seed guard
{
  for (const bad8 of ["deadbeef", "", "xyz", "0".repeat(31)]) {
    try { rngFromSeedHex(bad8); fail(`short seed "${bad8}" was accepted`); }
    catch { /* expected */ }
  }
  ok("short/invalid seeds are refused, not silently padded");
}

// --------------------------------------------- 5. determinism: same seed, same stream
{
  const hex = randomBytes(16).toString("hex");
  const a = rngFromSeedHex(hex), b = rngFromSeedHex(hex);
  for (let i = 0; i < 100000; i++) {
    if (a.next() !== b.next()) { fail("same seed diverged"); break; }
  }
  ok("same seed reproduces an identical stream");
  const c = sfc32(1, 2, 3, 4), d = sfc32(1, 2, 3, 4);
  if (c.next() !== d.next()) fail("sfc32 not deterministic");
}

// ------------------------------------------- 6. full round replay, new record format
//
// Half the exits here are MANUAL — round.cashOut() called between ticks —
// because that is the only kind production actually produces: server entrants
// carry no strategy at all and every real exit arrives over the wire. The
// suite previously drove every exit from an in-tick strategy, so the manual
// branch of replayRound (the one every player's "verify" button runs) was
// certified by nothing. Some fire at tick 0, before the first step, which is
// its own code path again.
{
  let mismatches = 0;
  let manualExits = 0;
  for (let t = 0; t < 400; t++) {
    const seedHex = randomBytes(16).toString("hex");
    const n = 5 + Math.floor(Math.random() * 30);
    const exits = new Map<number, number>();
    const manualAt = new Map<number, number>();
    const entrants: Entrant[] = [];
    for (let i = 1; i <= n; i++) {
      const at = Math.random() < 0.7 ? 1 + Math.floor(Math.random() * 25) : Infinity;
      if (Number.isFinite(at) && Math.random() < 0.5) {
        // Manual: leave the strategy inert and call cashOut at that tick.
        manualAt.set(i, Math.random() < 0.1 ? 0 : at);
      } else {
        exits.set(i, at);
      }
      entrants.push({
        id: i,
        strategyId: "t",
        strategy: (ctx) => ctx.tick >= (exits.get(i) ?? Infinity),
      });
    }
    const round = new Round(DEFAULT_CONFIG, rngFromSeedHex(seedHex), entrants);
    const byTick = new Map<number, number[]>();
    for (const [id, at] of manualAt) byTick.set(at, [...(byTick.get(at) ?? []), id]);
    for (const id of byTick.get(0) ?? []) {
      if (round.cashOut(id) !== null) manualExits++;
    }
    while (!round.finished) {
      round.step();
      for (const id of byTick.get(round.currentTick) ?? []) {
        if (round.cashOut(id) !== null) manualExits++;
      }
    }
    const res = round.result();
    const live = outcomeDigest(res);

    const replay = replayRound(DEFAULT_CONFIG, {
      seedHex,
      config: DEFAULT_CONFIG,
      entrantIds: res.players.map((p) => p.id),
      cashOuts: res.cashOuts,
    });
    if (outcomeDigest(replay) !== live) mismatches++;
  }
  if (mismatches) fail(`${mismatches}/400 rounds failed to replay`);
  else if (manualExits < 400) fail(`only ${manualExits} manual exits generated — the production path is undertested`);
  else ok(`400 random rounds replayed bit-identically (${manualExits} manual between-tick exits included)`);
}

// --------------------------------------------------- 7. legacy records still replay
{
  const entrants: Entrant[] = [1,2,3,4,5,6,7,8].map((id) => ({
    id, strategyId: "t", strategy: (ctx) => ctx.tick >= 6,
  }));
  const { mulberry32 } = await import("@zinc/engine");
  const round = new Round(DEFAULT_CONFIG, mulberry32(12345), entrants);
  while (!round.finished) round.step();
  const res = round.result();
  const replay = replayRound(DEFAULT_CONFIG, {
    seed: 12345,
    entrantIds: res.players.map((p) => p.id),
    cashOuts: res.cashOuts,
  });
  if (outcomeDigest(replay) !== outcomeDigest(res)) fail("legacy 32-bit record no longer replays");
  else ok("pre-existing 32-bit history rows still verify");
}

// ------------------------------------------------- 8. canonicalConfig is order-stable
{
  const a = canonicalConfig(DEFAULT_CONFIG);
  const shuffled = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const reordered: any = {};
  for (const k of Object.keys(shuffled).reverse()) reordered[k] = shuffled[k];
  const b = canonicalConfig(reordered);
  if (a !== b) fail("canonicalConfig depends on key order");
  else ok("canonicalConfig is key-order independent");
  const c = canonicalConfig({ ...DEFAULT_CONFIG, entry: DEFAULT_CONFIG.entry * 2 });
  if (a === c) fail("canonicalConfig ignores a changed value");
  else ok("canonicalConfig detects a changed rule");
}

// ------------------------------------------ 9. the jackpot draw is committed too
//
// The bonanza is the biggest single payout in the game. It used to be decided
// by a wall-clock-seeded 32-bit generator outside the ceremony entirely — the
// operator could predict every fire, and no player could check any of them.
// It now runs on a stream derived from the same committed seed.
{
  const seedHex = randomBytes(16).toString("hex");
  const a = deriveRng(seedHex, BONANZA_TAG);
  const b = deriveRng(seedHex, BONANZA_TAG);
  if (a.next() !== b.next()) fail("derived jackpot stream is not deterministic");
  else ok("jackpot stream reproduces exactly from the revealed seed");

  // Disjoint from the round's own stream, or the jackpot draw would shift the
  // eliminations and break every replay.
  const round = rngFromSeedHex(seedHex);
  const bon = deriveRng(seedHex, BONANZA_TAG);
  let collisions = 0;
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(round.next());
  for (let i = 0; i < 500; i++) if (seen.has(bon.next())) collisions++;
  if (collisions > 2) fail(`jackpot stream overlaps the round stream (${collisions} shared draws)`);
  else ok("jackpot stream is independent of the round's elimination stream");

  // A different seed must give a different jackpot outcome.
  const other = deriveRng(randomBytes(16).toString("hex"), BONANZA_TAG);
  if (other.next() === deriveRng(seedHex, BONANZA_TAG).next()) {
    fail("two different seeds produced the same jackpot draw");
  } else ok("a different seed gives a different jackpot draw");

  // And the recorded draw round-trips through the verifier the UI uses.
  const rng = deriveRng(seedHex, BONANZA_TAG);
  const rec = {
    seedHex,
    entrantIds: [1],
    cashOuts: [],
    bonanza: { fire: rng.next(), winner: rng.next(), totalTickets: 200, winnerId: 1 },
  };
  if (verifyBonanzaDraw(rec) !== true) fail("an honest jackpot draw failed verification");
  else ok("an honest jackpot draw verifies");
  const tampered = { ...rec, bonanza: { ...rec.bonanza, winner: rec.bonanza.winner + 1e-9 } };
  if (verifyBonanzaDraw(tampered) !== false) fail("a tampered jackpot draw passed verification");
  else ok("a tampered jackpot draw is caught");
}

console.log(bad === 0 ? "\n  ALL RNG/REPLAY CHECKS PASS\n" : `\n  ${bad} CHECK(S) FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
