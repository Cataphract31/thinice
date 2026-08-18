/*
 * IS OUR LAMPORT ARITHMETIC STILL THE ARCADE'S? ASKED ON THE BOX, AT BOOT.
 *
 * `apps/server/vendor/arcade/money/money.js` is a byte-for-byte copy of the
 * arcade's own, and `config.ts` converts every SOL figure through it. A copy
 * with nothing watching it is a copy that drifts, and the failure would be
 * silent in the worst way: this server and the verifier page would each be
 * certain about a settlement and disagree about the last lamport of it.
 *
 * THIS RUNS HERE BECAUSE THERE IS NOWHERE ELSE TO PUT IT. Thin Ice has no unit
 * suite; `itest-ledger.mjs` needs two live servers and a websocket, so it is
 * something a person runs deliberately and rarely. The box, meanwhile, has both
 * checkouts sitting side by side and never asks. That is the same gap the same
 * check closed in C:\HOLD, and it closed it after a real drift went unnoticed
 * until somebody happened to run the tests.
 *
 * IT WARNS AND NEVER REFUSES TO START. A mismatch usually means the arcade was
 * pulled and we have not been yet -- an ordinary five minutes in the middle of
 * a deploy -- and a game server that would not boot during it would turn a
 * routine update into an outage for everyone mid-round.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor", "arcade", "money");
const FILES = ["money.js"];

/** The box first, because the box is the machine whose answer matters. */
const CANDIDATES = ["/opt/gielinor/repo", "C:/GIELINOR", "/c/GIELINOR"];

export type VendorStatus = "matches" | "DRIFTED" | "unchecked";

/**
 * THE ARCADE'S FILE MEANS THE ARCADE'S COMMITTED FILE.
 *
 * `tools/vendor-arcade.mjs` reads `git show HEAD:path` and this has to ask the
 * same question, or the two disagree by construction: a clean box would look
 * drifted the moment anybody edited that file on a laptop, which is an alarm
 * that cries wolf. Falls back to the file on disk when git cannot answer,
 * which is weaker and still better than refusing to answer at all.
 */
function committedBytes(repo: string, rel: string): Buffer {
  try {
    return execFileSync("git", ["-C", repo, "show", `HEAD:${rel}`], { maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return fs.readFileSync(path.join(repo, rel));
  }
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

export function checkVendoredMoney(): { status: VendorStatus; detail: string } {
  const arcade = CANDIDATES.find((c) =>
    fs.existsSync(path.join(c, "arcade", "money", "money.js")),
  );
  if (!arcade) return { status: "unchecked", detail: "no gielinor checkout on this machine" };

  const drifted: string[] = [];
  for (const f of FILES) {
    try {
      const mine = sha256(fs.readFileSync(path.join(VENDOR, f)));
      const theirs = sha256(committedBytes(arcade, `arcade/money/${f}`));
      if (mine !== theirs) drifted.push(f);
    } catch (err) {
      return { status: "unchecked", detail: `could not read ${f}: ${(err as Error).message}` };
    }
  }
  if (drifted.length === 0) return { status: "matches", detail: arcade };
  return { status: "DRIFTED", detail: `${drifted.join(", ")} differ from ${arcade}` };
}

/** Say it at boot, in the log somebody reads when a settlement looks wrong. */
export function reportVendoredMoney(): VendorStatus {
  const { status, detail } = checkVendoredMoney();
  if (status === "DRIFTED") {
    console.warn(
      `[thin-ice] THE LAMPORT ARITHMETIC HERE IS NOT THE ARCADE'S: ${detail}. ` +
        "Run `node tools/vendor-arcade.mjs`, read the diff, and redeploy.",
    );
  }
  return status;
}
