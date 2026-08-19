/*
 * Lamports, and the boot that refuses a setting it cannot read.
 *
 * `toLamports` is the only place SOL becomes money on this server, and it is
 * deliberately NOT its own arithmetic: it calls the arcade's `solToLamports`
 * through a verbatim copy of money.js, because the verifier page, the ledger
 * and every other game on the box agree about lamports through that file. Two
 * implementations that agree today are still two implementations.
 *
 * The interesting part is the `.toFixed(9)` in between, which is load-bearing
 * and reads like a formatting preference. `solToLamports` is written for an
 * exact decimal somebody typed into a withdrawal box and refuses more than
 * nine decimal places. What reaches this function instead is a pot divided
 * among entrants and a balance grown by a multiplier -- binary floats, where
 * 1/3 prints as seventeen decimals and would be refused outright. Without that
 * line this throws on nearly every settlement in a pot game. The tests below
 * pin both halves: the shapes that must convert, and the shapes that must
 * still be refused rather than quietly turning into zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toLamports, toSol, LAMPORTS, CONFIG, CHARS } from "../src/config.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

test("a whole SOL figure converts exactly", () => {
  assert.equal(toLamports(0), 0);
  assert.equal(toLamports(1), LAMPORTS);
  assert.equal(toLamports(25), 25 * LAMPORTS);
  assert.equal(toLamports(0.1), 100_000_000);
  assert.equal(LAMPORTS, 1_000_000_000);
});

test("the float traps a pot game actually hits", () => {
  // 4.35 * 1e9 really is 4349999999.999999. The arcade's own tests call this
  // one out; it is here because this server reaches the same function by a
  // different route and must land on the same lamport.
  assert.equal(toLamports(4.35), 4_350_000_000);
  // These are the shapes a pot produces: a prize divided among entrants, and a
  // balance grown by a multiplier. Both print more decimals than lamports have.
  assert.equal(toLamports(1 / 3), 333_333_333);
  assert.equal(toLamports(0.1 + 0.2), 300_000_000);
  // Rounds to the nearest lamport, never truncates toward zero.
  assert.equal(toLamports(5e-10), 1);
  assert.equal(toLamports(4e-10), 0);
});

test("it agrees with the arithmetic it replaced, across the whole practical range", () => {
  // The claim written into config.ts when the local `Math.round(sol * LAMPORTS)`
  // was swapped for the arcade's function: 200,000 amounts from 0.001 to 200
  // SOL, no disagreement. Re-run here rather than trusted, because the point of
  // vendoring the arcade's file is that its behaviour can change under us.
  let disagreements = 0;
  for (let i = 1; i <= 200_000; i++) {
    const sol = i * 0.001;
    if (toLamports(sol) !== Math.round(sol * LAMPORTS)) disagreements++;
  }
  assert.equal(disagreements, 0);
});

test("a payout that is not a number is refused, not silently zeroed", () => {
  // The damage this prevents: NaN reaching the ledger as a settlement amount.
  // `Number("x")` is NaN, NaN|0 is 0, and a payout of 0 is a VALID settlement
  // meaning "played and lost" -- so a NaN that converts quietly is a player
  // paid nothing and books that balance.
  assert.throws(() => toLamports(NaN), /not a SOL amount/);
  assert.throws(() => toLamports(Infinity), /not a SOL amount/);
  assert.throws(() => toLamports(-Infinity), /not a SOL amount/);
  // toFixed switches to exponential at 1e21, which the parser then refuses.
  // Far above any reachable pot -- 250 plates at 0.1 SOL is 25 -- and it fails
  // loudly rather than converting to something wrong.
  assert.throws(() => toLamports(1e21), /not a SOL amount/);
});

test("a refund keeps its sign", () => {
  assert.equal(toLamports(-0.5), -500_000_000);
  assert.equal(toLamports(-1), -LAMPORTS);
});

test("lamports convert back for the screen", () => {
  assert.equal(toSol(LAMPORTS), 1);
  assert.equal(toSol(0), 0);
  assert.equal(toSol(98_000_000), 0.098);
  // Round-trips at lamport scale, which is all that is stored.
  for (const sol of [0.1, 4.35, 0.098, 25, 0.000000001]) {
    assert.equal(toSol(toLamports(sol)), sol);
  }
});

/* ---- boot-time settings ---- */

test("the shipped defaults are the ones the game is described by", () => {
  assert.equal(CONFIG.minEntrants >= 2, true, "a PvP round needs two wallets");
  assert.equal(CONFIG.maxPlatesPerWallet >= 1, true);
  assert.equal(CHARS.length, new Set(CHARS).size, "the roster has no duplicate faces");
  assert.ok(CHARS.length > 0);
});

/** Boots config.ts in a child process with one setting overridden. */
function boot(env: Record<string, string>): { ok: boolean; err: string } {
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", "await import('./apps/server/src/config.ts')"],
      { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] },
    );
    return { ok: true, err: "" };
  } catch (e) {
    return { ok: false, err: String((e as { stderr?: Buffer }).stderr ?? (e as Error).message) };
  }
}

test("a setting that is not a number stops the boot instead of poisoning a comparison", () => {
  // Number("two players") is NaN, and every `seats.size >= NaN` is false -- so
  // no round ever seals while players keep being debited into lobbies that roll
  // over forever. A server that will not start is the cheap version of that.
  const bad = boot({ MIN_ENTRANTS: "two players" });
  assert.equal(bad.ok, false);
  assert.match(bad.err, /MIN_ENTRANTS.*is not a number/);
});

test("a setting outside its range stops the boot too", () => {
  assert.equal(boot({ MIN_ENTRANTS: "1" }).ok, false, "below the floor for a PvP round");
  assert.equal(boot({ MIN_ENTRANTS: "9999" }).ok, false, "above the ceiling");
  assert.equal(boot({ PORT: "0" }).ok, false);
  assert.equal(boot({ PORT: "70000" }).ok, false);
  assert.equal(boot({ MAX_PLATES_PER_WALLET: "0" }).ok, false);
});

test("an unset or empty setting takes the default rather than failing", () => {
  // Empty is what an env file with `MIN_ENTRANTS=` gives, and it must not be
  // read as zero.
  assert.equal(boot({ MIN_ENTRANTS: "" }).ok, true);
  assert.equal(boot({ MIN_ENTRANTS: "4" }).ok, true);
  assert.equal(boot({ AUTO_LAPSE_MIN: "0" }).ok, true, "0 disables auto lapsing, it is not out of range");
});
