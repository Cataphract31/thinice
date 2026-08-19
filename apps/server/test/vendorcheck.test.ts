/*
 * Is our lamport arithmetic still the arcade's?
 *
 * `apps/server/vendor/arcade/money/money.js` is a byte-for-byte copy of the
 * arcade's own file, and every SOL figure this server converts goes through
 * it. A copy with nothing watching it drifts, and this particular drift is
 * silent in the worst way: this server and the arcade's verifier page would
 * each be certain about a settlement and disagree about its last lamport.
 *
 * The check runs at boot on the box, where both checkouts sit side by side.
 * These tests cover the check itself -- and, when a GIELINOR checkout is on
 * this machine, actually assert the copy has not drifted, which is the thing
 * the boot warning is for.
 *
 * IT IS ALLOWED TO ANSWER "unchecked". A laptop with no arcade checkout
 * cannot compare anything, and that is not a failure -- so these tests demand
 * "not DRIFTED" rather than "matches", and make the stronger claim only where
 * there is something to compare against.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkVendoredMoney, reportVendoredMoney } from "../src/vendorcheck.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor", "arcade", "money", "money.js");
const CANDIDATES = ["/opt/gielinor/repo", "C:/GIELINOR", "/c/GIELINOR"];

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

test("the vendored copy is present and is the file config.ts actually converts through", async () => {
  assert.ok(fs.existsSync(VENDOR), "the vendored money.js is missing entirely");
  const mod = await import("../vendor/arcade/money/money.js");
  assert.equal(typeof mod.solToLamports, "function");
  // The function this server's toLamports is built on. If the vendored file
  // stops exporting it, the boot fails in a way this says plainly.
  assert.equal(String(mod.solToLamports(String(1))), "1000000000");
});

test("the check answers with one of the three states it documents", () => {
  const { status, detail } = checkVendoredMoney();
  assert.ok(["matches", "DRIFTED", "unchecked"].includes(status), `unknown status ${status}`);
  assert.equal(typeof detail, "string");
  assert.ok(detail.length > 0, "an answer with no detail is not actionable");
});

test("the lamport arithmetic here is the arcade's", () => {
  // The real assertion, and the one that fails when somebody edits the copy.
  // On a machine with no arcade checkout there is nothing to compare and the
  // check says so -- that is the documented third state, not a pass smuggled in.
  const { status, detail } = checkVendoredMoney();
  assert.notEqual(status, "DRIFTED",
    `the vendored money.js differs from the arcade's: ${detail}. ` +
    "Run `node tools/vendor-arcade.mjs`, read the diff, and redeploy.");
  if (status === "unchecked") {
    assert.equal(CANDIDATES.some((c) => fs.existsSync(path.join(c, "arcade", "money", "money.js"))), false,
      "an arcade checkout is present, so 'unchecked' is hiding a real answer");
  }
});

test("where an arcade checkout exists, the copy is byte-identical to it", () => {
  const arcade = CANDIDATES.find((c) => fs.existsSync(path.join(c, "arcade", "money", "money.js")));
  if (!arcade) return; // nothing to compare on this machine; covered above
  // Deliberately compares the WORKING TREE here, where the check compares the
  // committed file. The two differ exactly when somebody has edited the
  // arcade's copy without committing it -- which is a real state on a laptop
  // and not a drift, so this is asserted only as a hash equality that holds on
  // a clean checkout, with the reason spelled out if it ever fails.
  const mine = sha256(fs.readFileSync(VENDOR));
  const theirs = sha256(fs.readFileSync(path.join(arcade, "arcade", "money", "money.js")));
  assert.equal(mine, theirs,
    `the vendored copy differs from the working tree at ${arcade}. ` +
    "If the arcade's file has uncommitted edits, that is the cause; otherwise re-vendor.");
});

test("reporting never throws and never refuses the boot", () => {
  // A mismatch usually means the arcade was pulled and we have not been yet --
  // an ordinary five minutes mid-deploy. A game server that would not start
  // during it turns a routine update into an outage for everyone mid-round.
  let status: ReturnType<typeof reportVendoredMoney> | null = null;
  assert.doesNotThrow(() => {
    status = reportVendoredMoney();
  });
  assert.equal(status, checkVendoredMoney().status, "it reports the answer it checked");
});
