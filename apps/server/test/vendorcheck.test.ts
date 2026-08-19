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
  assert.equal(String(mod.solToLamports(String(1))), "1000000000");
});

test("the check answers with one of the three states it documents", () => {
  const { status, detail } = checkVendoredMoney();
  assert.ok(["matches", "DRIFTED", "unchecked"].includes(status), `unknown status ${status}`);
  assert.equal(typeof detail, "string");
  assert.ok(detail.length > 0, "an answer with no detail is not actionable");
});

test("the lamport arithmetic here is the arcade's", () => {
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
  if (!arcade) return;
  const mine = sha256(fs.readFileSync(VENDOR));
  const theirs = sha256(fs.readFileSync(path.join(arcade, "arcade", "money", "money.js")));
  assert.equal(mine, theirs,
    `the vendored copy differs from the working tree at ${arcade}. ` +
    "If the arcade's file has uncommitted edits, that is the cause; otherwise re-vendor.");
});

test("reporting never throws and never refuses the boot", () => {
  let status: ReturnType<typeof reportVendoredMoney> | null = null;
  assert.doesNotThrow(() => {
    status = reportVendoredMoney();
  });
  assert.equal(status, checkVendoredMoney().status, "it reports the answer it checked");
});
