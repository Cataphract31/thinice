/*
 * DOES A ROUND OF THIN ICE MOVE REAL MONEY CORRECTLY?
 *
 * Not a unit test -- it drives two live servers and a websocket, which is
 * exactly why it exists. Every part of this path was individually plausible and
 * the only question that mattered was whether the whole chain adds up: sign in
 * at the arcade, hold a stake in the ledger, play, settle, and have the books
 * close at zero.
 *
 *   Terminal 1:  PORT=8080 LEDGER_KEY=itest-key LEDGER_DB=:memory:  *                  node /c/GIELINOR/arcade/server/main.js
 *   Terminal 2:  PORT=8787 LEDGER_KEY=itest-key DB_PATH=:memory: MIN_ENTRANTS=2  *                  npx tsx apps/server/src/index.ts
 *   Terminal 3:  node itest-ledger.mjs
 *
 * It mints two ed25519 keypairs and signs in for real, because the arcade
 * checks the signature and a fake token proves nothing. What to look for in the
 * output: `sum: 0`, `escrow: 0`, `openHolds: 0`, `escrowMatchesHolds: true`, and
 * the two wallets' movements plus the house rake adding to exactly nothing.
 *
 * The signature is BASE64, not base58 -- base58Decode caps at 64 characters and
 * a 64-byte signature encodes to about 88, which is how the first run of this
 * failed.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import WebSocket from "ws";

const ARCADE = "http://127.0.0.1:8080";
const KEY = "itest-key";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
};
const post = (p, b, h = {}) => fetch(ARCADE + p, {
  method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A wallet that can actually sign, because the arcade checks. */
function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { address: b58(raw), privateKey };
}

async function signIn(w) {
  const ch = await post("/api/auth/challenge", { wallet: w.address });
  const stmt = ch.body.statement;
  const sig = sign(null, Buffer.from(stmt, "utf8"), w.privateKey);
  const v = await post("/api/auth/verify", { wallet: w.address, nonce: ch.body.nonce, signature: Buffer.from(sig).toString("base64") });
  if (!v.body?.token) throw new Error("sign-in failed: " + JSON.stringify(v.body));
  return v.body.token;
}

const audit = () => fetch(`${ARCADE}/api/ledger/audit`, { headers: { "x-ledger-key": KEY } }).then((r) => r.json());
const bal = (w) => fetch(`${ARCADE}/api/ledger/balance?wallet=${w}`, { headers: { "x-ledger-key": KEY } }).then((r) => r.json());

const players = [makeWallet(), makeWallet()];
for (const p of players) {
  p.token = await signIn(p);
  await post("/api/ledger/credit", { wallet: p.address, amount: 2_000_000_000, ref: `fund-${p.address.slice(0, 10)}`, kind: "deposit" }, { "x-ledger-key": KEY });
}
console.log("signed in and funded 2 wallets, 2 SOL each");
for (const p of players) console.log("  ", p.address.slice(0, 12) + "...", JSON.stringify(await bal(p.address)));

/** Drive one socket through auth -> join -> whatever the round does. */
function play(p) {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:8787");
    const seen = [];
    ws.on("open", () => ws.send(JSON.stringify({ t: "arcade", token: p.token })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "error") seen.push("ERR:" + m.message);
      if (m.t === "ready") { p.joined = true; ws.send(JSON.stringify({ t: "join" })); }
      if (m.t === "state") { p.lastWallet = m.state.wallet; p.phase = m.state.phase; p.frames = (p.frames || 0) + 1; }
    });
    setTimeout(() => { ws.close(); resolve(seen); }, 22000);
  });
}

const errs = (await Promise.all(players.map(play))).flat();
console.log("socket errors:", errs.length ? errs : "none");
for (const p of players) console.log("  ", p.address.slice(0, 12) + "...", "wallet shown:", p.lastWallet, "SOL  phase:", p.phase, " frames:", p.frames);
console.log("balances after:");
for (const p of players) console.log("  ", p.address.slice(0, 12) + "...", JSON.stringify(await bal(p.address)));
console.log("audit:", JSON.stringify(await audit()));
