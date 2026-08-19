import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, totalRake, type GameConfig } from "../src/config.js";
import { Round, type Entrant } from "../src/round.js";
import { mulberry32, rngFromSeedHex, type Rng } from "../src/rng.js";

const bulk = (seed: number): Rng => {
  const r = mulberry32(seed);
  return { next: () => r.next() };
};

const entrants = (n: number, exit: (id: number) => number | null): Entrant[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    strategyId: "test",
    strategy: (ctx) => {
      const t = exit(id);
      return t !== null && ctx.tick >= t;
    },
  }));

function returnToSeat(
  exitTick: number | null,
  rounds: number,
  seed: number,
  cfg: GameConfig = DEFAULT_CONFIG,
  n = 12,
): number {
  const rng = bulk(seed);
  let banked = 0;
  for (let k = 0; k < rounds; k++) {
    const res = new Round(cfg, rng, entrants(n, (id) => (id === 0 ? exitTick : null))).play();
    banked += res.players.find((p) => p.id === 0)!.cashedOut;
  }
  return banked / (rounds * cfg.entry);
}

test("the house takes the rake and not one lamport more", () => {
  const rng = bulk(4242);
  for (let k = 0; k < 400; k++) {
    const n = 2 + (k % 30);
    const res = new Round(DEFAULT_CONFIG, rng, entrants(n, (id) => (id % 4 === 0 ? 3 + id : null))).play();
    const paid = res.players.reduce((a, p) => a + p.cashedOut, 0);
    const kept = res.grossHandle - paid;
    assert.ok(Math.abs(kept - (res.toPlatform + res.toBuyback)) < 1e-9,
      `round ${k} (n=${n}): house kept ${kept}, rake is ${res.toPlatform + res.toBuyback}`);
  }
});

test("in-game return is exactly one minus the rake, per round, with no sampling", () => {
  const target = 1 - totalRake(DEFAULT_CONFIG);
  const rng = bulk(77);
  for (const n of [2, 5, 12, 40, 120]) {
    for (const exit of [() => null, (id: number) => 3 + (id % 9), (id: number) => (id % 2 ? 4 : null)]) {
      const res = new Round(DEFAULT_CONFIG, rng, entrants(n, exit)).play();
      const paid = res.players.reduce((a, p) => a + p.cashedOut, 0);
      assert.ok(Math.abs(paid / res.grossHandle - target) < 1e-9,
        `n=${n}: field return ${paid / res.grossHandle}, expected ${target}`);
    }
  }
});

test("no exit policy beats any other", () => {
  const target = 1 - totalRake(DEFAULT_CONFIG);
  for (const exitTick of [3, 4, 6, 10]) {
    const got = returnToSeat(exitTick, 20_000, 1000 + exitTick);
    assert.ok(Math.abs(got - target) < 0.02, `exit@${exitTick}: RTP ${got.toFixed(4)}`);
  }
  assert.ok(Math.abs(returnToSeat(20, 20_000, 2020) - target) < 0.04, "exit@20");
});

test("riding to the end is not a strategy either", () => {
  const target = 1 - totalRake(DEFAULT_CONFIG);
  assert.ok(Math.abs(returnToSeat(null, 20_000, 31337) - target) < 0.08);
});

test("seat order confers no advantage", () => {
  const N = 12, ROUNDS = 40_000;
  const rng = bulk(8080);
  const wins = new Array<number>(N).fill(0);
  for (let k = 0; k < ROUNDS; k++) {
    const res = new Round(DEFAULT_CONFIG, rng, entrants(N, () => null)).play();
    for (const p of res.players) if (p.lastStanding) wins[p.id]! += 1;
  }
  const expected = ROUNDS / N;
  const sigma = Math.sqrt(expected * (1 - 1 / N));
  for (let seat = 0; seat < N; seat++) {
    const z = Math.abs(wins[seat]! - expected) / sigma;
    assert.ok(z < 4, `seat ${seat} won ${wins[seat]} of ${ROUNDS} (${z.toFixed(2)} sigma)`);
  }
  assert.equal(wins.reduce((a, b) => a + b, 0), ROUNDS, "exactly one winner per round");
});

test("the hazard schedule is pacing, and pacing does not touch return", () => {
  const target = 1 - totalRake(DEFAULT_CONFIG);
  const variants: Array<[string, GameConfig]> = [
    ["brutal", { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, q0: 0.3, alpha: 1.2 } }],
    ["gentle", { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, q0: 0.01, alpha: 4 } }],
    ["no grace", { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, graceTicks: 0 } }],
  ];
  const opening: number[] = [];
  for (const [name, cfg] of variants) {
    const got = returnToSeat(5, 20_000, 555, cfg);
    assert.ok(Math.abs(got - target) < 0.03, `${name}: RTP ${got.toFixed(4)}`);
    const round = new Round(cfg, rngFromSeedHex("0".repeat(32)), entrants(40, () => null));
    while (round.currentTick <= cfg.hazard.graceTicks) round.step();
    opening.push(round.hazard);
  }
  assert.ok(Math.max(...opening) > Math.min(...opening) * 5,
    `the variants are barely distinguishable: ${opening.join(", ")}`);
});

test("lobby size changes the arc, not the return", () => {
  const target = 1 - totalRake(DEFAULT_CONFIG);
  for (const n of [3, 12, 60]) {
    const got = returnToSeat(6, 12_000, 606, DEFAULT_CONFIG, n);
    assert.ok(Math.abs(got - target) < 0.05, `n=${n}: RTP ${got.toFixed(4)}`);
  }
});

test("the published split is the one the rounds actually pay", () => {
  assert.equal(DEFAULT_CONFIG.rake.platform, 0.005);
  assert.equal(DEFAULT_CONFIG.rake.buyback, 0.015);
  assert.equal(totalRake(DEFAULT_CONFIG), 0.02);
  const rng = bulk(9);
  let handle = 0, platform = 0, buyback = 0;
  for (let k = 0; k < 200; k++) {
    const res = new Round(DEFAULT_CONFIG, rng, entrants(10, () => 5)).play();
    handle += res.grossHandle;
    platform += res.toPlatform;
    buyback += res.toBuyback;
  }
  assert.ok(Math.abs(platform / handle - 0.005) < 1e-12);
  assert.ok(Math.abs(buyback / handle - 0.015) < 1e-12);
  assert.ok(buyback > platform * 2.9, "the buyback is the larger of the two");
});
