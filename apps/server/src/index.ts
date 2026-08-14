import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG, toLamports, toSol } from "./config.ts";
import { Database } from "./db.ts";
import { CHARS, GameServer, type Session } from "./game.ts";
import {
  RPC_URL,
  houseBalance,
  loadHouse,
  prepareWithdrawal,
  verifyDeposit,
  withdrawalStatus,
} from "./chain.ts";
import type { ClientMessage, NetChat, NetHistory, NetState, ServerMessage } from "./protocol.ts";

const db = new Database();
// Play-money mode never creates key material: a box that cannot pay out has
// no business holding a keypair to steal.
const house = CONFIG.banking ? loadHouse() : null;

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
const wss = new WebSocketServer({
  server: http,
  maxPayload: 8 * 1024,
  // Outbound bandwidth is the one metered resource on a small cloud box, and
  // the protocol is repetitive JSON pushed several times a second — the ideal
  // compression victim. No context takeover and a low level keep the zlib
  // memory per socket small enough for a 1 GB machine.
  perMessageDeflate: {
    threshold: 512,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    zlibDeflateOptions: { level: 3 },
  },
});

// Connection ceilings. Every accepted socket is a stream of state pushes,
// i.e. metered egress an attacker gets billed to US — opening sockets must
// therefore be bounded, per address and in total. Legitimate use sits far
// below both numbers (a phone plus a couple of tabs is 3).
const MAX_SOCKETS = 300;
const MAX_PER_IP = 6;
const perIp = new Map<string, number>();

// A socket-level error with no listener is thrown out of an I/O callback as
// ERR_UNHANDLED_ERROR and takes the process down. ws emits 'error' on the
// socket for any frame-level protocol violation — meaning one malformed frame
// from any client would kill the round every other player is mid-way through.
wss.on("error", (err) => console.error("wss error", err));

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // Behind the reverse proxy every socket is 127.0.0.1; the real address
  // rides in X-Forwarded-For. The LAST entry, not the first: the proxy
  // APPENDS the address it actually saw, while everything before it is
  // whatever the client claimed — reading the first token let a scripted
  // client rotate its own key freely while honest browsers (which cannot
  // set the header at all) shared one.
  const fwd = String(req.headers["x-forwarded-for"] ?? "");
  const ip =
    (fwd.split(",").pop() ?? "").trim() || req.socket.remoteAddress || "?";
  const ipCount = perIp.get(ip) ?? 0;
  if (wss.clients.size > MAX_SOCKETS || ipCount >= MAX_PER_IP) {
    ws.close(1013, "server full");
    return;
  }
  perIp.set(ip, ipCount + 1);

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

  const seat = (wallet: string, guest: boolean, token?: string): void => {
    if (session) return;
    const before = db.player(wallet);
    // Read BEFORE touch below moves the presence stamp to now.
    const awayMs = Date.now() - before.seenAt;
    // Auto play lapses over a long absence, and it must lapse HERE: the seat
    // is attached to the game below, and from that moment the next lobby tick
    // buys this wallet in. Clearing it after attach would be a race the
    // player pays for.
    const autoLapsed =
      before.autoEnabled === 1 &&
      CONFIG.autoLapseMs > 0 &&
      awayMs > CONFIG.autoLapseMs;
    if (autoLapsed) db.setAuto(wallet, false, before.autoTarget, before.autoPlates ?? 1);
    db.touch(wallet);
    session = {
      wallet,
      guest,
      session: 0,
      send: (state: NetState) => send({ t: "state", state }),
      sendHistory: (history: NetHistory[]) => send({ t: "history", history }),
      sendChat: (msgs: NetChat[]) => send({ t: "chat", msgs }),
    };
    send({
      t: "ready",
      wallet,
      guest,
      // No house account offered, no bank panel rendered: the client shows
      // banking only when this field arrives.
      ...(guest || !house ? {} : { house: house.publicKey.toBase58() }),
      // Minted only on a fresh signature. The client stores it and resumes
      // with it, so one Phantom prompt covers every future connection.
      ...(token ? { token } : {}),
    });
    game.attach(session);
  };

  /** One in-flight chain operation per socket: banking is not a burst activity. */
  let bankBusy = false;

  async function handleDeposit(s: Session, sig: string): Promise<void> {
    if (!house) return;
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
    if (!house) return;
    const lamports = toLamports(sol);
    // Debit first, atomically — balance check, unsettled-rakeback hold and
    // debit are one SQL statement, so neither two racing withdrawals nor a
    // round crashing mid-request can let clawback-able money leave on-chain.
    if (!db.debitForWithdrawal(s.wallet, lamports)) {
      send({
        t: "tx",
        kind: "withdraw",
        ok: false,
        sol: 0,
        note: "not enough settled balance — rakeback from a round in play unlocks when it ends",
      });
      return;
    }
    // Sign first, so the signature exists BEFORE any lamport can move and
    // the intent row ties it to the debit. Nothing has been broadcast if
    // preparation itself fails, so that one refund is genuinely safe.
    let prep;
    try {
      prep = await prepareWithdrawal(house, s.wallet, lamports);
    } catch (err) {
      db.adjustBalance(s.wallet, lamports);
      console.error("withdrawal prepare failed", s.wallet, err);
      send({
        t: "tx",
        kind: "withdraw",
        ok: false,
        sol: 0,
        note: "chain transfer failed — is the house funded?",
      });
      game.refresh(s);
      return;
    }
    db.recordWithdrawalIntent(prep.sig, s.wallet, lamports);
    try {
      await prep.send();
      db.setTransferStatus(prep.sig, "ok");
      send({ t: "tx", kind: "withdraw", ok: true, sol, note: prep.sig });
    } catch (err) {
      // A confirmation failure is NOT proof the transfer failed: an HTTP
      // timeout after the RPC node accepted it is a transfer that landed.
      // Ask the chain, and refund only when it PROVES the money never moved.
      console.error("withdrawal confirm failed", s.wallet, err);
      const status = await withdrawalStatus(prep.sig, prep.lastValidBlockHeight);
      if (status === "landed") {
        db.setTransferStatus(prep.sig, "ok");
        send({ t: "tx", kind: "withdraw", ok: true, sol, note: prep.sig });
      } else if (status === "failed" || status === "expired") {
        db.refundWithdrawal(prep.sig, s.wallet, lamports);
        send({
          t: "tx",
          kind: "withdraw",
          ok: false,
          sol: 0,
          note: "chain transfer failed — is the house funded?",
        });
      } else {
        // Unknowable right now: the debit stands, flagged for the operator.
        // Re-crediting here is the double-payout path.
        db.setTransferStatus(prep.sig, "unknown");
        send({
          t: "tx",
          kind: "withdraw",
          ok: false,
          sol: 0,
          note: "transfer status unknown — balance held while it settles",
        });
      }
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

  // Chat gets its own, far tighter bucket. The global budget is sized for
  // gameplay traffic — twenty messages a second — and every chat line is a
  // broadcast to the whole room, so at gameplay rates one keyboard is a
  // denial of service against every other player's screen.
  let chatBudget = 4;
  const chatRefill = setInterval(() => {
    chatBudget = Math.min(4, chatBudget + 1);
  }, 1500);

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
    // Same ceiling as the socket layer's maxPayload: two disagreeing caps
    // meant frames between them were accepted by one and silently dropped
    // by the other.
    if (typeof raw === "object" && "byteLength" in raw && raw.byteLength > 8192) return;
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
      case "auth": {
        // Already seated: nothing here may run. Processing a late auth used
        // to rotate the wallet's stored token BEFORE seat() no-opped, which
        // silently logged out every other session resuming on the old token
        // while the fresh token was discarded undelivered.
        if (session) return;
        // A real wallet must prove ownership by signing the nonce. Without
        // this anyone could claim to be any address and spend its balance.
        if (nonceSpent || Date.now() - nonceAt > NONCE_TTL_MS) {
          send({ t: "error", message: "challenge expired" });
          return;
        }
        nonceSpent = true;
        // One coerced value used everywhere below — verifying one string and
        // seating the raw, uncoerced payload is how type confusion starts.
        const wallet = String(msg.wallet ?? "");
        if (!verify(wallet, nonce, String(msg.sig ?? ""))) {
          send({ t: "error", message: "signature rejected" });
          return;
        }
        // One signature mints a session token; every later connection
        // resumes with it instead of re-prompting Phantom.
        const token = randomBytes(24).toString("hex");
        db.setAuthToken(wallet, token);
        seat(wallet, false, token);
        return;
      }

      case "resume": {
        // Bearer resume: same trust level as a guest id. Namespaced wallets
        // (guests, bots) can never be resumed into — they have no signature
        // ceremony, so nothing may claim them by token either.
        const wallet = String(msg.wallet ?? "");
        const offered = String(msg.token ?? "");
        const stored = wallet.includes(":") ? null : db.authTokenOf(wallet);
        const a = Buffer.from(offered);
        const b = Buffer.from(stored ?? "");
        if (!stored || a.length !== b.length || !timingSafeEqual(a, b)) {
          send({ t: "error", message: "session expired" });
          return;
        }
        seat(wallet, false);
        return;
      }

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

      case "unjoin": {
        if (!session) return;
        const err = game.unjoin(session);
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
        const rawPlates = Number(msg.plates);
        const plates = Number.isFinite(rawPlates)
          ? Math.min(CONFIG.maxPlatesPerWallet, Math.max(1, Math.round(rawPlates)))
          : 1;
        db.setAuto(session.wallet, Boolean(msg.enabled), target, plates);
        return;
      }

      case "chat": {
        if (!session) return;
        // React escapes markup, so HTML is not the threat here — invisible
        // and direction-flipping codepoints are: a zero-width or RTL-override
        // payload is aimed at every other reader's screen. Strip control
        // characters and the bidi/zero-width ranges, cap the length, and an
        // empty result simply never happened.
        const text = String(msg.text ?? "")
          .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .trim()
          .slice(0, 160);
        if (!text) return;
        if (chatBudget <= 0) {
          // Prefixed so the client can route it into the chat feed itself
          // rather than a console nobody reads.
          send({ t: "error", message: "chat: slow down" });
          return;
        }
        chatBudget--;
        game.chat(session, text);
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
        // No house = play-money server = nothing to deposit into.
        if (!session || session.guest || !house) return;
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
        if (!session || session.guest || !house) return;
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
    clearInterval(chatRefill);
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left <= 0) perIp.delete(ip);
    else perIp.set(ip, left);
    if (session) {
      // Stamp the departure: "while you were away" measures from here.
      db.touch(session.wallet);
      game.detach(session);
    }
  });
});

http.listen(CONFIG.port, () => {
  console.log(`THIN ICE server on :${CONFIG.port}`);
  console.log(`  db     ${CONFIG.dbPath}`);
  if (house) {
    console.log(`  rpc    ${RPC_URL}`);
    console.log(`  house  ${house.publicKey.toBase58()}`);
    const h = house;
    void houseBalance(h).then((l) =>
      console.log(`  house balance ${(l / 1e9).toFixed(4)} SOL`),
    );
  } else {
    console.log(`  banking OFF — play-money mode, no chain, no house wallet`);
  }
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
