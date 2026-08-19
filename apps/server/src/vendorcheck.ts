import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor", "arcade", "money");
const FILES = ["money.js"];

const CANDIDATES = ["/opt/gielinor/repo", "C:/GIELINOR", "/c/GIELINOR"];

export type VendorStatus = "matches" | "DRIFTED" | "unchecked";

function committedBytes(repo: string, rel: string): Buffer {
  try {
    return execFileSync("git", ["-C", repo, "show", `HEAD:${rel}`], {
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
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
