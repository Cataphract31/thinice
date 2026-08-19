import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(HERE, "..", "apps", "server", "vendor", "arcade", "money");

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
}

fs.writeFileSync(
  path.join(VENDOR_DIR, "VENDORED.json"),
  `${JSON.stringify({ source: "gielinor arcade/money", commit, files: hashes }, null, 2)}\n`,
);
console.log(`\nvendored from ${from} at ${commit.slice(0, 8)}`);
