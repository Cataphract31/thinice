/*
 * THE ARCADE'S WALLET, COPIED IN RATHER THAN REWRITTEN.
 *
 * WHY A COPY AND NOT AN IMPORT. The handshake -- provider discovery, the
 * sign-in ceremony, the session cookie, resume, disconnect, and the whole
 * phone story behind it -- lives once, in C:\GIELINOR\arcade\web\wallet.js.
 * Five tables in that repo import it directly through its `#arcade/...`
 * subpath and are thirty-line shims. This world cannot: it is a separate
 * repository with its own bundler, so a bare specifier has nothing to resolve
 * against at build time, and an absolute /arcade/web/wallet.js resolves only
 * on the vendored deploy -- not in `npm run dev`, not under the smoke test,
 * not on a standalone Vercel build.
 *
 * So the dependency direction is simply reversed: the arcade vendors this
 * world's BUILD into itself with tools/vendor-world.mjs, and this vendors the
 * arcade's wallet into this world's SOURCE. Same idea, same guarantee -- one
 * author, many copies, and a check that shouts when they disagree.
 *
 * GIELINOR IS THE ONLY AUTHOR. Nothing in src/arcade/ may be edited here. A
 * fix made in this repo would be a fix the other six tables silently do not
 * have, which is the failure the arcade consolidated six copies to end.
 *
 * Usage, from the repo root:
 *   node scripts/sync-arcade.mjs           copy in, report what moved
 *   node scripts/sync-arcade.mjs --check   fail if a copy has drifted
 *   ARCADE=../elsewhere node ... /sync-arcade.mjs   a checkout somewhere else
 *
 * --check IS A NO-OP WITHOUT THE SOURCE, on purpose. The copies are committed,
 * so Vercel builds this world without GIELINOR anywhere near it; a check that
 * failed when it could not find the original would turn "no checkout" into a
 * broken deploy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = resolve(here, "..", "src", "arcade");
const src = resolve(process.env.ARCADE ?? resolve(here, "..", "..", "..", "..", "GIELINOR"), "arcade", "web");

/*
 * THE CLOSURE OF arcade/web/wallet.js, and it is worth knowing why each is
 * here rather than trimming the list to what a desktop touches.
 *
 *   wallet.js         the handshake itself
 *   origin.js         where the box is, which wallet.js asks on every call
 *   platform.js       is this a phone, and what to advise when there is no
 *                     wallet in it
 *   deeplink.js       the phone round trip: this page is destroyed, the wallet
 *                     app opens, the answer comes back in a query string
 *   wallet-apps.js    which apps exist and how to reach them from this browser
 *   wallet-chooser.js the sheet that asks which one
 *   base58.js         encode-only, for the keys a deeplink is sealed with
 *   vendor/nacl...    x25519 + secretbox, which is what the deeplink payloads
 *                     are sealed with. Public domain, checked in upstream.
 *
 * Only the first three are reached on a desktop. The rest hang off dynamic
 * imports taken on a phone, so they cost a desktop nothing at runtime -- but
 * they must be present for the bundler to make those chunks at all.
 */
const FILES = [
  "wallet.js",
  "origin.js",
  "platform.js",
  "deeplink.js",
  "wallet-apps.js",
  "wallet-chooser.js",
  "base58.js",
  "vendor/nacl.min.js",
];

const check = process.argv.includes("--check");

if (!existsSync(src)) {
  if (check) {
    console.log(`sync-arcade: no arcade checkout at ${src} — skipping the drift check`);
    process.exit(0);
  }
  console.error(`sync-arcade: no arcade checkout at ${src}`);
  console.error("             set ARCADE=<path to GIELINOR> if it lives somewhere else");
  process.exit(1);
}

const drifted = [];
const copied = [];
for (const rel of FILES) {
  const from = join(src, rel);
  const to = join(dest, rel);
  if (!existsSync(from)) {
    console.error(`sync-arcade: ${rel} is not in ${src}`);
    process.exit(1);
  }
  /* Bytes, not text: a copy that differs only in line endings is still a copy
     somebody will one day diff and be confused by. */
  const want = readFileSync(from);
  const have = existsSync(to) ? readFileSync(to) : null;
  if (have && have.equals(want)) continue;
  if (check) { drifted.push(rel); continue; }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, want);
  copied.push(rel);
}

if (check) {
  if (drifted.length) {
    console.error("sync-arcade: these copies no longer match the arcade:");
    for (const f of drifted) console.error(`  src/arcade/${f}`);
    console.error("\n  If the arcade changed:  node scripts/sync-arcade.mjs");
    console.error("  If this repo changed:   put the change in GIELINOR instead — see the");
    console.error("                          header of this file for why.");
    process.exit(1);
  }
  console.log(`sync-arcade: ${FILES.length} files match the arcade`);
} else {
  console.log(copied.length
    ? `sync-arcade: updated ${copied.length} of ${FILES.length} — ${copied.join(", ")}`
    : `sync-arcade: already current (${FILES.length} files)`);
}
