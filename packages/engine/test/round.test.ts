/*
 * The round: the hazard curve, and what happens to the money.
 *
 * Two things are being defended here and they are not the same thing.
 *
 * The first is CONSERVATION. Every lamport of the pot leaves through a
 * player. Eliminated balances are shared pro-rata among the survivors of that
 * same tick, so the only exits are a voluntary walk-out and a sole survivor
 * taking what is left. A leak here is not a rounding curiosity: it is money
 * the game took and never paid, and it would surface as a solvency drift in
 * the arcade's books long before anyone found it in this file.
 *
 * The second is that the hazard curve exists EXACTLY ONCE. `hazardAt` is
 * consulted by the round, displayed by the client as the rate the next tick
 * will roll at, and swept by the pacing tools. Those last two used to carry
 * hand-copied versions and one had already drifted -- it omitted thin-field
 * relief, so it was certifying a curve the engine no longer ran. The tests
 * below pin the shape of the real one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, totalRake, drawFieldSize, type GameConfig, type HazardConfig } from "../src/config.js";
import { Round, hazardAt, type Entrant, type RoundResult } from "../src/round.js";
import { rngFromSeedHex, type Rng } from "../src/rng.js";

const SEED = "0123456789abcdef0123456789abcdef";
const H = DEFAULT_CONFIG.hazard;

/** Entrants who never walk out unless `exit` names a tick for them. */
const field = (n: number, exit: (id: number) => number | null = () => null): Entrant[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    strategyId: "test",
    strategy: (ctx) => {
      const t = exit(id);
      return t !== null && ctx.tick >= t;
    },
  }));

const run = (n: number, exit?: (id: number) => number | null, cfg: GameConfig = DEFAULT_CONFIG): RoundResult =>
  new Round(cfg, rngFromSeedHex(SEED), field(n, exit)).play();

/** A stream that always fires: every roll lands below any hazard. */
const alwaysKill: Rng = { next: () => 0 };
/** A stream that never fires. 0.999999 is above qMax, so nobody is eliminated. */
const neverKill: Rng = { next: () => 0.999999 };

test("the pot is the handle minus the rake, split evenly", () => {
  const round = new Round(DEFAULT_CONFIG, rngFromSeedHex(SEED), field(10));
  assert.equal(round.grossHandle, 10 * DEFAULT_CONFIG.entry);
  assert.equal(round.pot, round.grossHandle * (1 - totalRake(DEFAULT_CONFIG)));
  assert.equal(round.entryBalance, round.pot / 10);
  const res = round.play();
  assert.equal(res.toPlatform, res.grossHandle * DEFAULT_CONFIG.rake.platform);
  assert.equal(res.toBuyback, res.grossHandle * DEFAULT_CONFIG.rake.buyback);
  // The rake is the WHOLE edge -- no second cut, nothing held back in a pool.
  assert.ok(Math.abs(res.toPlatform + res.toBuyback + res.pot - res.grossHandle) < 1e-12);
});

test("an empty lobby is refused rather than played", () => {
  assert.throws(() => new Round(DEFAULT_CONFIG, rngFromSeedHex(SEED), []), /at least one entrant/);
});

test("every lamport of the pot leaves through a player", () => {
  // The invariant the arcade's books depend on. Swept across field sizes and
  // exit policies, because redistribution is where a leak would hide.
  const policies: Array<(id: number) => number | null> = [
    () => null,
    (id) => (id % 3 === 0 ? 3 + (id % 7) : null),
    (id) => id + 1,
  ];
  for (const n of [1, 2, 3, 8, 30, 100]) {
    for (const exit of policies) {
      const res = run(n, exit);
      const paid = res.players.reduce((a, p) => a + p.cashedOut, 0);
      // Lamport scale against a 0.1 SOL entry. Anything real is far larger.
      assert.ok(Math.abs(paid + res.wipeLeak - res.pot) < 1e-9,
        `n=${n}: paid ${paid} + leak ${res.wipeLeak} != pot ${res.pot}`);
      assert.equal(res.players.filter((p) => p.outcome === "in").length, 0, "nobody is left holding");
      for (const p of res.players) {
        if (p.outcome === "dead") assert.equal(p.cashedOut, 0, "the dead are paid nothing");
        else assert.ok(p.cashedOut > 0, "a survivor banked something");
      }
    }
  }
});

test("a dead player's balance is shared pro-rata among that tick's survivors", () => {
  // Every live player holds an identical balance, so pro-rata is an even
  // split -- but it is written pro-rata because that is what stays correct if
  // it ever stops being identical.
  const round = new Round(DEFAULT_CONFIG, alwaysKill, field(4));
  const entry = round.entryBalance;
  round.step();
  round.step(); // grace: nobody dies
  const ev = round.step()!; // the first live roll: all doomed, one spared
  assert.equal(ev.grace, false);
  assert.equal(ev.killed, 3);
  assert.equal(ev.redistributed, entry * 3);
  const survivor = round.players.find((p) => p.outcome === "in")!;
  assert.ok(Math.abs(survivor.balance - entry * 4) < 1e-12, "the survivor holds the whole pot");
});

test("nobody can be eliminated during the opening grace, but the rate is published", () => {
  const round = new Round(DEFAULT_CONFIG, alwaysKill, field(20));
  for (let i = 0; i < H.graceTicks; i++) {
    const ev = round.step()!;
    assert.equal(ev.grace, true, `tick ${ev.tick} should be sheltered`);
    assert.equal(ev.killed, 0);
    assert.ok(ev.q > 0, "players still see the rate they are about to face");
    assert.equal(ev.liveBefore, 20);
  }
  const first = round.step()!;
  assert.equal(first.grace, false);
  assert.ok(first.killed > 0, "the shaft turns on at graceTicks + 1");
});

test("a tick never wipes the field while the guarantee is on", () => {
  // The only leak in the redistribution loop, and the reason in-game return is
  // exactly independent of when a player walks out.
  for (const n of [2, 3, 9, 40]) {
    const res = new Round(DEFAULT_CONFIG, alwaysKill, field(n)).play();
    assert.equal(res.ending, "resolved", `n=${n} wiped`);
    assert.equal(res.wipeLeak, 0);
    assert.equal(res.players.filter((p) => p.outcome === "cashed").length, 1);
    const winner = res.players.find((p) => p.lastStanding)!;
    assert.ok(Math.abs(winner.cashedOut - res.pot) < 1e-12, "the last one standing takes the pot");
  }
});

test("turning the guarantee off strands the pot instead of losing it quietly", () => {
  // Unreachable in the shipped config. `wipeLeak` is kept because it is the
  // only thing that would make such a config visible rather than silently short.
  const cfg: GameConfig = { ...DEFAULT_CONFIG, hazard: { ...H, guaranteeSurvivor: false } };
  const res = new Round(cfg, alwaysKill, field(6)).play();
  assert.equal(res.ending, "wipe");
  assert.ok(Math.abs(res.wipeLeak - res.pot) < 1e-12);
  assert.equal(res.players.reduce((a, p) => a + p.cashedOut, 0), 0);
});

test("a sole survivor is flagged, a final-tick walk-out is not", () => {
  // Both end with ticksSurvived === round ticks, so `lastStanding` is the only
  // way to tell "the engine banked them" from "they pressed the button".
  const auto = new Round(DEFAULT_CONFIG, alwaysKill, field(5)).play();
  assert.equal(auto.players.filter((p) => p.lastStanding).length, 1);

  const res = new Round(DEFAULT_CONFIG, neverKill, field(3, () => 1)).play();
  assert.equal(res.players.filter((p) => p.lastStanding).length, 0, "everyone left on their own");
  assert.equal(res.players.every((p) => p.outcome === "cashed"), true);
  assert.equal(res.ending, "resolved");
});

test("a one-entrant round pays the pot back without ever rolling", () => {
  const res = run(1);
  assert.equal(res.ticks, 0);
  assert.equal(res.events.length, 0);
  assert.equal(res.players[0]!.lastStanding, true);
  assert.equal(res.players[0]!.cashedOut, res.pot);
});

test("cashOut banks between ticks and refuses anyone not live", () => {
  const round = new Round(DEFAULT_CONFIG, neverKill, field(4));
  round.step();
  assert.equal(round.cashOut(1), round.entryBalance);
  assert.equal(round.players[1]!.outcome, "cashed");
  assert.equal(round.cashOut(1), null, "cannot bank twice");
  assert.equal(round.cashOut(999), null, "unknown id");
  assert.deepEqual(round.cashOutLog[0], { id: 1, tick: 1, manual: true });
  // Emptying the shaft by hand ends the round rather than leaving it running.
  round.cashOut(0);
  round.cashOut(2);
  round.cashOut(3);
  assert.equal(round.finished, true);
});

test("a walk-out cannot dodge the tick already in flight", () => {
  // Decisions resolve AFTER the roll. A strategy that exits at tick 1 is still
  // exposed to tick 1's elimination, and whoever dies there stays dead.
  const cfg: GameConfig = { ...DEFAULT_CONFIG, hazard: { ...H, graceTicks: 0 } };
  const res = new Round(cfg, alwaysKill, field(6, () => 1)).play();
  assert.equal(res.players.filter((p) => p.outcome === "dead").length, 5,
    "five died on the very tick they had decided to leave on");
  assert.equal(res.players.filter((p) => p.outcome === "cashed").length, 1);
});

test("result() refuses to report on a round still running", () => {
  const round = new Round(DEFAULT_CONFIG, rngFromSeedHex(SEED), field(10));
  assert.throws(() => round.result(), /still running/);
  round.play();
  assert.doesNotThrow(() => round.result());
});

test("ticksSurvived counts the rolls a player was exposed to", () => {
  const round = new Round(DEFAULT_CONFIG, neverKill, field(3, (id) => (id === 0 ? 2 : null)));
  round.step();
  round.step();
  round.step();
  assert.equal(round.players[0]!.ticksSurvived, 2, "stopped counting when they left");
  assert.equal(round.players[1]!.ticksSurvived, 3);
});

test("the clock is pure presentation and touches no probability", () => {
  const slow: GameConfig = { ...DEFAULT_CONFIG, timing: { lobbyMs: 1, tickMs: 4000, resultMs: 2 } };
  const a = run(30);
  const b = run(30, undefined, slow);
  assert.equal(a.ticks, b.ticks);
  assert.deepEqual(a.events.map((e) => e.q), b.events.map((e) => e.q));
  assert.equal(b.durationMs, 1 + b.ticks * 4000 + 2);
});

/* ---- the hazard curve itself ---- */

test("risk falls as the shaft empties", () => {
  // The signal the whole game is read on: fewer people, more oxygen.
  let previous = Infinity;
  for (const live of [100, 80, 60, 40, 20, 10, 5, 2]) {
    const q = hazardAt(H, 5, live, 100);
    assert.ok(q <= previous, `hazard rose from ${previous} to ${q} at live=${live}`);
    previous = q;
  }
});

test("thin-field relief buys a small lobby a real round", () => {
  // Crowding is a fraction, so 3-of-3 is as dangerous as 30-of-30 -- but that
  // round is over after two deaths. The damping is by ABSOLUTE headcount.
  const full = hazardAt(H, 3, 100, 100);
  const thin = hazardAt(H, 3, 3, 3);
  assert.ok(thin < full, `a thin full field should be gentler: ${thin} vs ${full}`);
  // At or above thinField the relief is switched off entirely, so a busy shaft
  // is not quietly discounted.
  const relieved = hazardAt(H, 3, H.thinField, H.thinField);
  const unrelieved = hazardAt({ ...H, thinField: 0 }, 3, H.thinField, H.thinField);
  assert.ok(Math.abs(relieved - unrelieved) < 1e-12);
});

test("creep stays out of the way early and closes the round out late", () => {
  // Cubic and tiny. At power 2 it had overtaken crowding by mid-game, which
  // flattened the hazard: a wave of deaths barely moved the number.
  const early = hazardAt(H, 5, 50, 100);
  const noCreep = hazardAt({ ...H, creep: 0 }, 5, 50, 100);
  assert.ok(early - noCreep < 0.001, "creep is negligible while the shaft is busy");
  // A stalled round still terminates: with two players left forever, the rate
  // has to climb until it resolves.
  assert.ok(hazardAt(H, 400, 2, 100) > hazardAt(H, 40, 2, 100));
  assert.ok(hazardAt(H, 5000, 2, 100) > 0.05, "a stalled round is not a stalemate");
});

test("the curve is clamped at both ends", () => {
  assert.equal(hazardAt(H, 0, 1, 100000), H.qMin);
  assert.equal(hazardAt({ ...H, q0: 9 }, 1, 100, 100), H.qMax);
  const cases: Array<[number, number, number]> = [[0, 1, 1], [1, 2, 2], [50, 7, 300], [9999, 3, 8]];
  for (const [tick, live, total] of cases) {
    const q = hazardAt(H, tick, live, total);
    assert.ok(q >= H.qMin && q <= H.qMax, `escaped the clamp: ${q}`);
  }
});

test("the round consults that one curve and no other", () => {
  // The drift this catches: a second copy of the hazard maths appearing in the
  // round, or in the client, quietly disagreeing with the published rate.
  const round = new Round(DEFAULT_CONFIG, neverKill, field(25));
  while (!round.finished && round.currentTick < 6) {
    const ev = round.step();
    if (!ev) break;
    assert.equal(ev.q, hazardAt(H, ev.tick, ev.liveBefore, 25));
    assert.equal(round.hazard, ev.q, "the rate the client shows is the rate that rolled");
  }
});

test("the hazard config is a pure function of its arguments", () => {
  // No hidden state between calls: the client asks for the NEXT tick's rate
  // before it has happened, and must get the same answer the round will roll.
  const probe: HazardConfig = { ...H };
  const first = hazardAt(probe, 7, 13, 40);
  for (let i = 0; i < 5; i++) assert.equal(hazardAt(probe, 7, 13, 40), first);
  assert.deepEqual(probe, H, "reading the curve must not mutate the rules");
});

test("the lobby range is a live rule, drawn from the config", () => {
  assert.equal(drawFieldSize(DEFAULT_CONFIG, 0), DEFAULT_CONFIG.field.min);
  assert.equal(drawFieldSize(DEFAULT_CONFIG, 0.9999999), DEFAULT_CONFIG.field.max);
  assert.ok(DEFAULT_CONFIG.field.min >= 2, "a round needs someone to lose to");
  for (const u of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const n = drawFieldSize(DEFAULT_CONFIG, u);
    assert.ok(n >= DEFAULT_CONFIG.field.min && n <= DEFAULT_CONFIG.field.max, `${u} -> ${n}`);
  }
});
