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
  assert.equal(toLamports(4.35), 4_350_000_000);
  assert.equal(toLamports(1 / 3), 333_333_333);
  assert.equal(toLamports(0.1 + 0.2), 300_000_000);
  assert.equal(toLamports(5e-10), 1);
  assert.equal(toLamports(4e-10), 0);
});

test("it agrees with the arithmetic it replaced, across the whole practical range", () => {
  let disagreements = 0;
  for (let i = 1; i <= 200_000; i++) {
    const sol = i * 0.001;
    if (toLamports(sol) !== Math.round(sol * LAMPORTS)) disagreements++;
  }
  assert.equal(disagreements, 0);
});

test("a payout that is not a number is refused, not silently zeroed", () => {
  assert.throws(() => toLamports(NaN), /not a SOL amount/);
  assert.throws(() => toLamports(Infinity), /not a SOL amount/);
  assert.throws(() => toLamports(-Infinity), /not a SOL amount/);
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
  for (const sol of [0.1, 4.35, 0.098, 25, 0.000000001]) {
    assert.equal(toSol(toLamports(sol)), sol);
  }
});

test("the shipped defaults are the ones the game is described by", () => {
  assert.equal(CONFIG.minEntrants >= 2, true, "a PvP round needs two wallets");
  assert.equal(CONFIG.maxPlatesPerWallet >= 1, true);
  assert.equal(CHARS.length, new Set(CHARS).size, "the roster has no duplicate faces");
  assert.ok(CHARS.length > 0);
});

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
  assert.equal(boot({ MIN_ENTRANTS: "" }).ok, true);
  assert.equal(boot({ MIN_ENTRANTS: "4" }).ok, true);
  assert.equal(boot({ AUTO_LAPSE_MIN: "0" }).ok, true, "0 disables auto lapsing, it is not out of range");
});
