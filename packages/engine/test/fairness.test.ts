import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, type GameConfig } from "../src/config.js";
import { Round, type Entrant, type RoundResult } from "../src/round.js";
import { rngFromSeedHex } from "../src/rng.js";
import { canonicalConfig, replayRound, outcomeDigest, type RoundRecord } from "../src/fairness.js";

const SEED = "0123456789abcdef0123456789abcdef";
const OTHER_SEED = "fedcba9876543210fedcba9876543210";

const field = (n: number, exit: (id: number) => number | null = () => null): Entrant[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    strategyId: "test",
    strategy: (ctx) => {
      const t = exit(id);
      return t !== null && ctx.tick >= t;
    },
  }));

function played(
  n: number,
  exit: (id: number) => number | null,
  cfg: GameConfig = DEFAULT_CONFIG,
  seedHex: string = SEED,
): { res: RoundResult; rec: RoundRecord } {
  const round = new Round(cfg, rngFromSeedHex(seedHex), field(n, exit));
  const res = round.play();
  return {
    res,
    rec: { seedHex, config: cfg, entrantIds: res.players.map((p) => p.id), cashOuts: res.cashOuts },
  };
}

test("an honest round replays bit-for-bit from the revealed seed", () => {
  const { res, rec } = played(24, (id) => (id % 4 === 0 ? 5 : null));
  assert.equal(outcomeDigest(replayRound(DEFAULT_CONFIG, rec)), outcomeDigest(res));
});

test("replay reproduces the event stream, not merely the final balances", () => {
  const { res, rec } = played(30, (id) => (id % 5 === 0 ? 4 + id : null));
  const again = replayRound(DEFAULT_CONFIG, rec);
  assert.equal(again.ticks, res.ticks);
  assert.deepEqual(again.events, res.events);
  assert.deepEqual(again.cashOuts, res.cashOuts);
  assert.ok(res.events.length > 3, "the fixture actually ran a round");
});

test("a manual walk-out and a strategy exit replay as the different things they are", () => {
  const round = new Round(DEFAULT_CONFIG, rngFromSeedHex(SEED), field(20, (id) => (id % 6 === 0 ? 6 : null)));
  round.cashOut(1);
  round.step();
  round.step();
  round.step();
  round.cashOut(2);
  const res = round.play();

  assert.deepEqual(res.cashOuts[0], { id: 1, tick: 0, manual: true });
  assert.deepEqual(res.cashOuts[1], { id: 2, tick: 3, manual: true });
  assert.ok(res.cashOuts.some((c) => !c.manual), "and some strategy exits to mix in");

  const rec: RoundRecord = {
    seedHex: SEED,
    config: DEFAULT_CONFIG,
    entrantIds: res.players.map((p) => p.id),
    cashOuts: res.cashOuts,
  };
  assert.equal(outcomeDigest(replayRound(DEFAULT_CONFIG, rec)), outcomeDigest(res));
});

test("a swapped seed does not reproduce the round", () => {
  const { res, rec } = played(30, () => null);
  const forged = replayRound(DEFAULT_CONFIG, { ...rec, seedHex: OTHER_SEED });
  assert.notEqual(outcomeDigest(forged), outcomeDigest(res));
});

test("a misreported exit does not reproduce the round", () => {
  const { res, rec } = played(24, (id) => (id % 4 === 0 ? 5 : null));
  const moved = rec.cashOuts.map((c, i) => (i === 0 ? { ...c, tick: c.tick + 2 } : c));
  assert.notEqual(outcomeDigest(replayRound(DEFAULT_CONFIG, { ...rec, cashOuts: moved })),
    outcomeDigest(res));
  const reordered = [...rec.entrantIds].reverse();
  assert.notEqual(outcomeDigest(replayRound(DEFAULT_CONFIG, { ...rec, entrantIds: reordered })),
    outcomeDigest(res));
});

test("a record with no seed is refused instead of replayed against seed zero", () => {
  const { rec } = played(10, () => null);
  const seedless: RoundRecord = { entrantIds: rec.entrantIds, cashOuts: rec.cashOuts };
  assert.throws(() => replayRound(DEFAULT_CONFIG, seedless), /carries no seed/);
});

test("the round's own rules win over the verifier's build", () => {
  const oldRules: GameConfig = { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, q0: 0.11 } };
  const { res, rec } = played(30, () => null, oldRules);
  assert.equal(outcomeDigest(replayRound(DEFAULT_CONFIG, rec)), outcomeDigest(res));
  const withoutRules: RoundRecord = { ...rec, config: undefined };
  assert.notEqual(outcomeDigest(replayRound(DEFAULT_CONFIG, withoutRules)), outcomeDigest(res));
});

test("the rules hash input is stable under key order", () => {
  const shuffled = {
    field: DEFAULT_CONFIG.field,
    timing: DEFAULT_CONFIG.timing,
    rake: { buyback: DEFAULT_CONFIG.rake.buyback, platform: DEFAULT_CONFIG.rake.platform },
    hazard: DEFAULT_CONFIG.hazard,
    entry: DEFAULT_CONFIG.entry,
  } as GameConfig;
  assert.equal(canonicalConfig(shuffled), canonicalConfig(DEFAULT_CONFIG));
  assert.equal(canonicalConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as GameConfig),
    canonicalConfig(DEFAULT_CONFIG));
});

test("every rule that changes a round changes the rules hash input", () => {
  const base = canonicalConfig(DEFAULT_CONFIG);
  const variants: GameConfig[] = [
    { ...DEFAULT_CONFIG, entry: 0.2 },
    { ...DEFAULT_CONFIG, rake: { ...DEFAULT_CONFIG.rake, platform: 0.006 } },
    { ...DEFAULT_CONFIG, rake: { ...DEFAULT_CONFIG.rake, buyback: 0.016 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, q0: 0.076 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, alpha: 2.5 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, creep: 3.8e-7 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, creepPower: 2 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, creepBlend: 0.23 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, thinField: 13 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, thinPower: 1 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, qMin: 0.005 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, qMax: 0.43 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, graceTicks: 3 } },
    { ...DEFAULT_CONFIG, hazard: { ...DEFAULT_CONFIG.hazard, guaranteeSurvivor: false } },
    { ...DEFAULT_CONFIG, field: { ...DEFAULT_CONFIG.field, max: 251 } },
    { ...DEFAULT_CONFIG, field: { ...DEFAULT_CONFIG.field, min: 9 } },
  ];
  for (const v of variants) {
    assert.notEqual(canonicalConfig(v), base, `a rule change left the hash input untouched: ${JSON.stringify(v)}`);
  }
});

test("the canonical form survives the shapes JSON can hand it", () => {
  const walk = (v: unknown): string => canonicalConfig(v as GameConfig);
  assert.equal(walk({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(walk({ a: [3, { z: 1, y: 2 }] }), '{"a":[3,{"y":2,"z":1}]}');
  assert.equal(walk(null), "null");
  assert.notEqual(walk({ a: [1, 2] }), walk({ a: [2, 1] }));
});

test("the outcome digest ignores float noise and nothing else", () => {
  const { res } = played(20, (id) => (id % 3 === 0 ? 4 : null));
  const nudged: RoundResult = {
    ...res,
    players: res.players.map((p) => ({ ...p, cashedOut: p.cashedOut + 1e-13 })),
  };
  assert.equal(outcomeDigest(nudged), outcomeDigest(res));
  const short: RoundResult = {
    ...res,
    players: res.players.map((p, i) => (i === 0 ? { ...p, cashedOut: p.cashedOut + 1e-9 } : p)),
  };
  assert.notEqual(outcomeDigest(short), outcomeDigest(res));
});

test("a strategy that draws from the round's RNG breaks its own replay", () => {
  const greedy: Entrant[] = Array.from({ length: 20 }, (_, id) => ({
    id,
    strategyId: "draws",
    strategy: (ctx) => ctx.rng.next() < 0.02,
  }));
  const round = new Round(DEFAULT_CONFIG, rngFromSeedHex(SEED), greedy);
  const res = round.play();
  const rec: RoundRecord = {
    seedHex: SEED,
    config: DEFAULT_CONFIG,
    entrantIds: res.players.map((p) => p.id),
    cashOuts: res.cashOuts,
  };
  assert.notEqual(outcomeDigest(replayRound(DEFAULT_CONFIG, rec)), outcomeDigest(res),
    "a round whose strategies consumed draws should NOT replay -- if it does, the stream moved");
});
