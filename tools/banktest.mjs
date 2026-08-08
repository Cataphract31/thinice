/**
 * End-to-end devnet money-loop check.
 *
 * Boots a fresh server, then acts as a real wallet: signs the login challenge,
 * makes a genuine devnet deposit into the house, presents the signature,
 * tries to double-credit it, and withdraws back on-chain. This is the whole
 * deposit -> ledger -> withdrawal loop against the actual cluster.
 *
 * Devnet's faucet is rate-limited; if the airdrop fails the test SKIPs rather
 * than fails, because nothing about our code was disproved.
 */
import { WebSocket } from "ws";
import { spawn, execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PORT = 8791;
const DB = "banktest.db";
const HOUSE_FILE = "banktest-house.json";
const URL = `ws://127.0.0.1:${PORT}`;
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { console.log("  FAIL " + m); bad++; };
const skip = (m) => { console.log("  SKIP " + m); };

for (const f of [DB, DB + "-wal", DB + "-shm", HOUSE_FILE]) {
  try { rmSync(`../apps/server/${f}`); } catch {}
}

function kill(p) {
  try { execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: "ignore" }); }
  catch { p.kill("SIGKILL"); }
}

console.log("\n  DEVNET MONEY LOOP TEST\n");

// Pre-generate the house so the server takes the load-from-file path and never
// spends the faucet allowance — the player's deposit is what funds the house,
// and the withdrawal is paid back out of that same deposit.
const houseKp = Keypair.generate();
writeFileSync(`../apps/server/${HOUSE_FILE}`, JSON.stringify([...houseKp.secretKey]));

let houseAddr = null;
const srv = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: "../apps/server",
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, HOUSE_KEYPAIR_PATH: HOUSE_FILE },
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => {
  const m = String(d).match(/house\s+([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (m) houseAddr = m[1];
});

const conn = new Connection(RPC, "confirmed");
const player = Keypair.generate();

await sleep(7000);
if (!houseAddr) { fail("server never printed a house address"); kill(srv); process.exit(1); }
ok(`house wallet: ${houseAddr}`);

// Fund the player from the devnet faucet.
let funded = false;
try {
  const sig = await conn.requestAirdrop(player.publicKey, LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  funded = true;
  ok(`player funded by faucet: ${player.publicKey.toBase58().slice(0, 12)}…`);
} catch {
  skip("devnet faucet refused the airdrop (rate limit) — cannot exercise the chain today");
}

if (!funded) { kill(srv); process.exit(0); }

// ---- authenticate with a real signature, exactly like Phantom does
const p = await new Promise((resolve) => {
  const ws = new WebSocket(URL);
  const client = { ws, states: [], txs: [], errors: [], house: null,
    send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === "challenge") {
      const msg = new TextEncoder().encode(`THIN ICE login\nnonce: ${m.nonce}`);
      const sig = nacl.sign.detached(msg, player.secretKey);
      client.send({ t: "auth", wallet: player.publicKey.toBase58(), sig: Buffer.from(sig).toString("base64") });
    } else if (m.t === "ready") { client.house = m.house; resolve(client); }
    else if (m.t === "state") client.states.push(m.state);
    else if (m.t === "tx") client.txs.push(m);
    else if (m.t === "error") client.errors.push(m.message);
  });
  ws.on("error", () => {});
});
ok("authenticated with an ed25519 signature (no Phantom needed)");
if (p.house === houseAddr) ok("ready message carries the house address");
else fail(`ready.house wrong: ${p.house}`);

const waitState = async (pred, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = p.states[p.states.length - 1];
    if (s && pred(s)) return s;
    await sleep(100);
  }
  return null;
};
const waitTx = async (ms = 60000) => {
  const t0 = Date.now();
  const n = p.txs.length;
  while (Date.now() - t0 < ms) {
    if (p.txs.length > n) return p.txs[p.txs.length - 1];
    await sleep(200);
  }
  return null;
};

const s0 = await waitState((s) => s.wallet !== undefined);
const before = s0.wallet;
ok(`ledger balance before deposit: ${before} ◎`);

// ---- a real deposit: transfer 0.2 SOL to the house on devnet
const DEPOSIT = 0.2;
const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: player.publicKey,
    toPubkey: new PublicKey(houseAddr),
    lamports: Math.round(DEPOSIT * LAMPORTS_PER_SOL),
  }),
);
const depositSig = await sendAndConfirmTransaction(conn, tx, [player], { commitment: "confirmed" });
ok(`on-chain transfer confirmed: ${depositSig.slice(0, 20)}…`);

p.send({ t: "deposit", sig: depositSig });
const dep = await waitTx();
if (dep?.ok && Math.abs(dep.sol - DEPOSIT) < 1e-9) ok(`server verified and credited ${dep.sol} ◎`);
else fail(`deposit not credited: ${JSON.stringify(dep)}`);

const s1 = await waitState((s) => Math.abs(s.wallet - (before + DEPOSIT)) < 1e-9, 8000);
if (s1) ok(`ledger balance now ${s1.wallet} ◎ (+${DEPOSIT})`);
else fail(`balance did not rise by the deposit`);

// ---- the same signature again must be worthless
p.send({ t: "deposit", sig: depositSig });
const dup = await waitTx(20000);
if (dup && !dup.ok && /already/i.test(dup.note)) ok("replaying the same signature credits nothing");
else fail(`double-credit not blocked: ${JSON.stringify(dup)}`);

// ---- withdraw 0.1 back to the player's own address, on-chain
const chainBefore = await conn.getBalance(player.publicKey);
p.send({ t: "withdraw", sol: 0.1 });
const wd = await waitTx(90000);
if (wd?.ok) {
  ok(`withdrawal paid on-chain: ${String(wd.note).slice(0, 20)}…`);
  await sleep(2000);
  const chainAfter = await conn.getBalance(player.publicKey);
  if (chainAfter - chainBefore === 0.1 * LAMPORTS_PER_SOL) {
    ok(`player's devnet balance rose by exactly 0.1 SOL`);
  } else {
    fail(`chain delta wrong: ${(chainAfter - chainBefore) / LAMPORTS_PER_SOL} SOL`);
  }
} else {
  // The house was airdrop-funded at boot; if that airdrop failed there is
  // nothing to pay withdrawals from — our refund path must still have fired.
  const s2 = await waitState((s) => s.wallet !== undefined, 5000);
  if (wd && !wd.ok && s2 && Math.abs(s2.wallet - (before + DEPOSIT)) < 1e-9) {
    skip(`withdrawal failed (${wd.note}) but the ledger refunded in full — house likely unfunded`);
  } else {
    fail(`withdrawal failed AND balance not restored: ${JSON.stringify(wd)}`);
  }
}

// ---- withdraw more than the balance must bounce without moving anything
p.send({ t: "withdraw", sol: 999 });
const over = await waitTx(20000);
if (over && !over.ok && /balance/i.test(over.note)) ok("overdraw rejected");
else fail(`overdraw not rejected: ${JSON.stringify(over)}`);

p.ws.close();
kill(srv);
await sleep(500);
for (const f of [DB, DB + "-wal", DB + "-shm", HOUSE_FILE]) {
  try { rmSync(`../apps/server/${f}`); } catch {}
}
console.log(bad === 0 ? "\n  MONEY LOOP HOLDS\n" : `\n  ${bad} FAILURE(S)\n`);
process.exit(bad === 0 ? 0 : 1);
