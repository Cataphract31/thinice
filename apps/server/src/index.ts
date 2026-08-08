import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG, toLamports, toSol } from "./config.ts";
import { Database } from "./db.ts";
import { CHARS, GameServer, type Session } from "./game.ts";
import { RPC_URL, houseBalance, loadHouse, sendWithdrawal, verifyDeposit } from "./chain.ts";
import type { ClientMessage, NetHistory, NetState, ServerMessage } from "./protocol.ts";

const db = new Database();
const house = loadHouse();

// A round interrupted by a crash left stakes debited and never settled. Refund
// them before opening anything new: money that silently evaporates on restart
// is the one bug a ledger may never have.
const refunded = db.refundOpenEntries();
if (refunded > 0) console.log(`refunded ${refunded} entries from an unfinished round`);

const game = new GameServer(db);
game.start();

/** What a wallet has to sign to prove it is really theirs. */
function challengeText(nonce: string): string {
  return `THIN ICE login\nnonce: ${nonce}`;
}

/**
 * How long a login challenge stays good for.
 *
 * The nonce used to live as long as the socket, which the requesting party
 * controls: a page could hold one open indefinitely and use the signature
 * whenever it suited. A signed challenge is a bearer credential for the
 * account, so it should be worth nothing a couple of minutes later.
 */
const NONCE_TTL_MS = 120_000;

function verify(wallet: string, nonce: string, sigBase64: string): boolean {
  try {
    const pubkey = bs58.decode(wallet);
    if (pubkey.length !== 32) return false;
    const sig = Buffer.from(sigBase64, "base64");
    if (sig.length !== 64) return false;
    const msg = new TextEncoder().encode(challengeText(nonce));
    return nacl.sign.detached.verify(msg, new Uint8Array(sig), pubkey);
  } catch {
    return false;
  }
}

const http = createServer((req, res) => {
  // A trivial health endpoint, so "is the server up" never needs a websocket.
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// maxPayload is enforced by the protocol layer, before ws allocates anything.
// The 4 KiB guard in the message handler runs only after the whole frame has
// been buffered in memory, so on its own it protects JSON.parse and nothing
// else: the default cap is 100 MiB per frame.
const wss = new WebSocketServer({ server: http, maxPayload: 8 * 1024 });

// A socket-level error with no listener is thrown out of an I/O callback as
// ERR_UNHANDLED_ERROR and takes the process down. ws emits 'error' on the
// socket for any frame-level protocol violation — meaning one malformed frame
// from any client would kill the round every other player is mid-way through.
wss.on("error", (err) => console.error("wss error", err));

wss.on("connection", (ws: WebSocket) => {
  const nonce = randomBytes(16).toString("hex");
  const nonceAt = Date.now();
  /** One attempt per challenge: a rejected signature must not be retryable. */
  let nonceSpent = false;
  let session: Session | null = null;
  let alive = true;

  ws.on("error", (err) => {
    console.error("socket error", err);
    ws.terminate();
  });

  const send = (m: ServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    // Backpressure. A client that never reads still gets a full state pushed
    // several times a second plus a 40-round history at every round end; with
    // no ceiling that queue is unbounded server memory held for one socket.
    if (ws.bufferedAmount > 1_000_000) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(m));
  };

  send({ t: "challenge", nonce });

  const seat = (wallet: string, guest: boolean): void => {
    if (session) return;
    db.player(wallet);
    db.touch(wallet);
    session = {
      wallet,
      guest,
      session: 0,
      send: (state: NetState) => send({ t: "state", state }),
      sendHistory: (history: NetHistory[]) => send({ t: "history", history }),
    };
    send({
      t: "ready",
      wallet,
      guest,
      ...(guest ? {} : { house: house.publicKey.toBase58() }),
    });
    game.attach(session);
  };

  /** One in-flight chain operation per socket: banking is not a burst activity. */
  let bankBusy = false;

  async function handleDeposit(s: Session, sig: string): Promise<void> {
    const check = await verifyDeposit(sig, s.wallet, house.publicKey);
    if (!check.ok) {
      send({ t: "tx", kind: "deposit", ok: false, sol: 0, note: check.reason ?? "rejected" });
      return;
    }
    if (!db.creditDeposit(sig, s.wallet, check.lamports)) {
      send({ t: "tx", kind: "deposit", ok: false, sol: 0, note: "already credited" });
      return;
    }
    send({ t: "tx", kind: "deposit", ok: true, sol: toSol(check.lamports), note: "credited" });
    game.refresh(s);
  }

  async function handleWithdraw(s: Session, sol: number): Promise<void> {
    const lamports = toLamports(sol);
    // Debit first, atomically — the balance check and the debit are one SQL
    // statement, so two racing withdrawals cannot both pass on one balance.
    if (!db.adjustBalance(s.wallet, -lamports)) {
      send({ t: "tx", kind: "withdraw", ok: false, sol: 0, note: "not enough balance" });
      return;
    }
    try {
      const sig = await sendWithdrawal(house, s.wallet, lamports);
      db.recordWithdrawal(sig, s.wallet, lamports);
      send({ t: "tx", kind: "withdraw", ok: true, sol, note: sig });
    } catch (err) {
      // The transfer never confirmed: put the money back where it was.
      db.adjustBalance(s.wallet, lamports);
      console.error("withdrawal failed", s.wallet, err);
      send({
        t: "tx",
        kind: "withdraw",
        ok: false,
        sol: 0,
        note: "chain transfer failed — is the house funded?",
      });
    }
    game.refresh(s);
  }

  // Crude flood control. Every message costs a database write or a broadcast,
  // so one socket in a tight loop is enough to stall the round everyone else
  // is playing. Generous enough that no human interaction reaches it.
  let budget = 40;
  const refill = setInterval(() => {
    budget = Math.min(40, budget + 20);
  }, 1000);

  ws.on("message", (raw) => {
    // Clamped at zero and reported. Post-decrementing on every message drove
    // the counter unboundedly negative, so a burst muted the socket for
    // minutes — including its `cashout`, the one message in this protocol that
    // is worth money and cannot wait.
    if (budget <= 0) {
      send({ t: "error", message: "rate limited" });
      return;
    }
    budget--;
    if (typeof raw === "object" && "byteLength" in raw && raw.byteLength > 4096) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    // One malformed or unlucky request must never take the casino down with
    // it: everyone else is mid-round and would lose their stake to a restart.
    try {
      handle(msg);
    } catch (err) {
      console.error("message failed", msg.t, err);
      send({ t: "error", message: "server error" });
    }
  });

  function handle(msg: ClientMessage): void {
    switch (msg.t) {
      case "auth":
        // A real wallet must prove ownership by signing the nonce. Without
        // this anyone could claim to be any address and spend its balance.
        if (nonceSpent || Date.now() - nonceAt > NONCE_TTL_MS) {
          send({ t: "error", message: "challenge expired" });
          return;
        }
        nonceSpent = true;
        if (!verify(String(msg.wallet ?? ""), nonce, String(msg.sig ?? ""))) {
          send({ t: "error", message: "signature rejected" });
          return;
        }
        seat(msg.wallet, false);
        return;

      case "guest": {
        // Devnet convenience: play without a wallet under a local id. Namespaced
        // so a guest can never collide with, or impersonate, a real address.
        const id = String(msg.id ?? "").slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, "");
        if (id.length < 8) {
          send({ t: "error", message: "bad guest id" });
          return;
        }
        seat(`guest:${id}`, true);
        return;
      }

      case "join": {
        if (!session) return;
        const err = game.join(session);
        if (err) send({ t: "error", message: err });
        return;
      }

      case "cashout":
        if (session) game.cashOut(session);
        return;

      case "setAuto": {
        if (!session) return;
        // Clamped at both ends. An unbounded or non-finite target is written
        // straight to the database and then compared against every tick, so a
        // NaN here disables the player's auto-exit without telling them.
        const raw = Number(msg.target);
        const target = Number.isFinite(raw) ? Math.min(1000, Math.max(1.05, raw)) : 2;
        db.setAuto(session.wallet, Boolean(msg.enabled), target);
        return;
      }

      case "setChar":
        if (!session) return;
        // Whitelisted, not merely truncated: charId is echoed to every other
        // client and rendered, so an arbitrary client-supplied string is an
        // injection vector aimed at everyone else in the lobby.
        if (!CHARS.includes(String(msg.charId))) {
          send({ t: "error", message: "unknown character" });
          return;
        }
        db.setChar(session.wallet, String(msg.charId));
        return;

      case "deposit": {
        // Real wallets only: a guest has no chain identity to receive from or
        // pay to, and crediting a guest from an arbitrary transaction would
        // let anyone bank someone else's transfer under a throwaway id.
        if (!session || session.guest) return;
        const sig = String(msg.sig ?? "");
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) {
          send({ t: "tx", kind: "deposit", ok: false, sol: 0, note: "bad signature" });
          return;
        }
        if (bankBusy) {
          send({ t: "tx", kind: "deposit", ok: false, sol: 0, note: "one at a time" });
          return;
        }
        bankBusy = true;
        const s = session;
        void handleDeposit(s, sig)
          .catch((err) => {
            console.error("deposit failed", s.wallet, err);
            send({ t: "tx", kind: "deposit", ok: false, sol: 0, note: "server error" });
          })
          .finally(() => {
            bankBusy = false;
          });
        return;
      }

      case "withdraw": {
        if (!session || session.guest) return;
        const sol = Number(msg.sol);
        // Bounded and truthy: NaN, negatives, dust and absurd sizes all die
        // here rather than reaching the balance SQL or the chain.
        if (!Number.isFinite(sol) || sol < 0.01 || sol > 1000) {
          send({ t: "tx", kind: "withdraw", ok: false, sol: 0, note: "bad amount" });
          return;
        }
        if (bankBusy) {
          send({ t: "tx", kind: "withdraw", ok: false, sol: 0, note: "one at a time" });
          return;
        }
        bankBusy = true;
        const s = session;
        void handleWithdraw(s, sol)
          .catch((err) => {
            console.error("withdraw failed", s.wallet, err);
            send({ t: "tx", kind: "withdraw", ok: false, sol: 0, note: "server error" });
          })
          .finally(() => {
            bankBusy = false;
          });
        return;
      }
    }
  }

  ws.on("pong", () => {
    alive = true;
  });

  const ping = setInterval(() => {
    // Half-open sockets otherwise sit in the session set forever, inflating
    // the online count and auto-entering rounds for players who left.
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 20_000);

  ws.on("close", () => {
    clearInterval(ping);
    clearInterval(refill);
    if (session) game.detach(session);
  });
});

http.listen(CONFIG.port, () => {
  console.log(`THIN ICE server on :${CONFIG.port}`);
  console.log(`  db     ${CONFIG.dbPath}`);
  console.log(`  rpc    ${RPC_URL}`);
  console.log(`  house  ${house.publicKey.toBase58()}`);
  void houseBalance(house).then((l) =>
    console.log(`  house balance ${(l / 1e9).toFixed(4)} SOL`),
  );
});

// Last line of defence. Everything money-related is committed transactionally
// and an unfinished round is refunded at startup, so staying up on an
// unexpected throw is strictly better than dropping every player mid-round.
process.on("uncaughtException", (err) => console.error("uncaught", err));
process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    game.stop();
    db.close();
    process.exit(0);
  });
}
