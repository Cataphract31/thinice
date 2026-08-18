/**
 * THE ARCADE'S LAMPORT ARITHMETIC, COPIED IN WITHOUT BEING REWRITTEN.
 *
 *     node tools/vendor-arcade.mjs [--from <path to the gielinor checkout>]
 *
 * WHY THIS EXISTS FOR ONE FUNCTION. `config.ts` used to convert SOL to
 * lamports with `Math.round(sol * 1e9)`. Measured over 200,000 amounts from
 * 0.001 to 200 SOL, that agrees with the arcade's own `solToLamports` on every
 * single one -- `Math.round` really does rescue the float error at these
 * magnitudes, and no round of Thin Ice was ever mispriced by it.
 *
 * It was still the wrong function to be running. money.js is the file the
 * arcade, the ledger, the verifier page and every other game on this box agree
 * about lamports through, and its own header says why that matters: "the
 * verifier page and the server must compute the same number or a player is
 * told their own settlement was wrong." Two implementations that agree today
 * are two implementations, and the one over here is the one nobody would think
 * to check when the other changed.
 *
 * So it is not reimplemented, it is copied, and `vendorcheck.ts` says at every
 * boot whether the copy is still honest.
 *
 * TAKEN FROM THE COMMIT, NEVER FROM THE WORKING TREE. This is the lesson from
 * the same tool in C:\HOLD, learned the expensive way: reading the file off
 * disk means copying whatever is half-written on a machine where somebody is
 * editing the arcade -- which is every machine that has both checkouts. It
 * happened there. An uncommitted fix was vendored, deployed, and ran in
 * production while existing in no repository at all.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(HERE, "..", "apps", "server", "vendor", "arcade", "money");

/*
 * ONLY money.js. Thin Ice is a POT game: entries make the prize and the house
 * takes a rake, so it carries no bankroll and no exposure ceiling, and
 * bankroll.js -- which C:\HOLD vendors beside this -- would be a rule with
 * nothing here to apply it to.
 */
const FILES = ["money.js"];
const GUESSES = ["C:/GIELINOR", "/c/GIELINOR", "/opt/gielinor/repo"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : "";
};

const explicit = arg("from");
const from = (explicit ? [explicit] : GUESSES).find((c) =>
  fs.existsSync(path.join(c, "arcade", "money", "money.js")),
);
if (!from) {
  console.error(`no gielinor checkout found (looked in ${GUESSES.join(", ")}). Pass --from <path>.`);
  process.exit(1);
}

fs.mkdirSync(VENDOR_DIR, { recursive: true });
const hashes = {};
const dirty = [];
for (const f of FILES) {
  const rel = `arcade/money/${f}`;
  const buf = execFileSync("git", ["-C", from, "show", `HEAD:${rel}`], { maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(VENDOR_DIR, f), buf);
  hashes[f] = sha256(buf);
  if (sha256(fs.readFileSync(path.join(from, rel))) !== hashes[f]) dirty.push(f);
  console.log(`  ${f}  ${hashes[f].slice(0, 12)}  ${buf.length} bytes`);
}
if (dirty.length) {
  console.warn(
    `\n  NOTE: ${dirty.join(", ")} has uncommitted changes in ${from} that were` +
      "\n  NOT taken. Commit them there and run this again to pick them up.",
  );
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", from, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* a checkout with no HEAD; the hashes above are still the truth */
}

fs.writeFileSync(
  path.join(VENDOR_DIR, "VENDORED.json"),
  `${JSON.stringify({ source: "gielinor arcade/money", commit, files: hashes }, null, 2)}\n`,
);
console.log(`\nvendored from ${from} at ${commit.slice(0, 8)}`);
