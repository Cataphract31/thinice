import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG } from "./config.ts";
import { Database } from "./db.ts";
import { createArcadeLedger } from "./arcade.ts";
import { reportVendoredMoney } from "./vendorcheck.ts";
import { CHARS, GameServer, roundSeedFrom, type Session } from "./game.ts";
import { DEFAULT_CONFIG } from "@zinc/engine";
import type { ClientMessage, NetChat, NetHistory, NetState, ServerMessage } from "./protocol.ts";

const db = new Database();

const ledger = createArcadeLedger();
if (!ledger.enabled) {
  console.warn(
    "NO LEDGER_KEY: this server cannot take a stake. Rounds will open and every join will be refused.",
  );
}

const moneyRule = reportVendoredMoney();

const refunded = db.refundOpenEntries();
if (refunded > 0) console.log(`rolled back ${refunded} entries from an unfinished round`);
const revealed = db.revealInterrupted(DEFAULT_CONFIG, roundSeedFrom);
if (revealed > 0) console.log(`revealed ${revealed} interrupted round(s) so they stay checkable`);
if (ledger.enabled) {
  try {
    const released = await ledger.sweep();
    if (released > 0) console.log(`released ${released} stranded holds back to their wallets`);
  } catch (err) {
    console.error(`COULD NOT SWEEP STRANDED HOLDS: ${(err as Error).message}`);
  }
  try {
    const dropped = await ledger.exposure.sweep();
    if (dropped > 0) console.log(`dropped ${dropped} stale exposure rows`);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (e.status === 404) {
      console.warn(
        "this arcade has no exposure register route, so this table is not in the box-wide total.",
      );
    } else if (e.status === 409) {
      console.error(
        "EXPOSURE ROWS LEFT STANDING: the arcade still sees stakes of ours in escrow, so the" +
          " hold sweep above is the thing that failed. Both clear on the next restart.",
      );
    } else {
      console.error(`COULD NOT DROP STALE EXPOSURE ROWS: ${e.message}`);
    }
  }
}

const game = new GameServer(db, ledger);
game.start();

function challengeText(nonce: string): string {
  return `THIN ICE login\nnonce: ${nonce}`;
}

const NONCE_TTL_MS = 120_000;

const AUTH_PATH = "/api/auth/me";

const ARCADE_AUTH = (() => {
  const raw = process.env.ARCADE_AUTH_URL;
  if (!raw) return `http://127.0.0.1:8080${AUTH_PATH}`;
  try {
    const u = new URL(raw);
    if (u.pathname === "/" || u.pathname === "") return new URL(AUTH_PATH, u).toString();
    return raw;
  } catch {
    return raw;
  }
})();

async function arcadeWallet(token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    const res = await fetch(ARCADE_AUTH, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    if (!/application\/json/i.test(res.headers.get("content-type") ?? "")) {
      console.warn(
        `arcade auth: ${ARCADE_AUTH} answered ${res.status} but not JSON ` +
          `(content-type: ${res.headers.get("content-type") ?? "none"}). ` +
          `ARCADE_AUTH_URL should be the arcade's origin, or its ${AUTH_PATH} endpoint.`,
      );
      return null;
    }
    const body = (await res.json()) as { wallet?: unknown };
    const wallet = String(body.wallet ?? "");
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) ? wallet : null;
  } catch {
    return null;
  }
}

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
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ledger: ledger.enabled, moneyRule }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: 8 * 1024,
  perMessageDeflate: {
    threshold: 512,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    zlibDeflateOptions: { level: 3 },
  },
});

const MAX_SOCKETS = 300;
const MAX_PER_IP = 6;
const perIp = new Map<string, number>();

const resumeTries = new Map<string, { n: number; at: number }>();
const RESUME_WINDOW_MS = 60_000;
setInterval(() => {
  const cutoff = Date.now() - RESUME_WINDOW_MS;
  for (const [ip, r] of resumeTries) if (r.at < cutoff) resumeTries.delete(ip);
}, RESUME_WINDOW_MS).unref();

function mayResume(ip: string): boolean {
  const now = Date.now();
  const r = resumeTries.get(ip);
  if (!r || now - r.at > RESUME_WINDOW_MS) {
    resumeTries.set(ip, { n: 1, at: now });
    return true;
  }
  r.n++;
  return r.n <= CONFIG.resumeTriesPerMin;
}

wss.on("error", (err) => console.error("wss error", err));

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
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
  let nonceSpent = false;
  let session: Session | null = null;
  let alive = true;

  ws.on("error", (err) => {
    console.error("socket error", err);
    ws.terminate();
  });

  const send = (m: ServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(m));
  };

  send({ t: "challenge", nonce });

  const seat = (wallet: string, guest: boolean, token?: string): void => {
    if (session) return;
    if (guest) {
      session = {
        wallet,
        guest,
        session: 0,
        send: (state: NetState) => send({ t: "state", state }),
        sendHistory: (history: NetHistory[]) => send({ t: "history", history }),
        sendChat: (msgs: NetChat[]) => send({ t: "chat", msgs }),
      };
      send({ t: "ready", wallet, guest });
      game.attach(session);
      return;
    }
    const before = db.player(wallet);
    const awayMs = Date.now() - before.seenAt;
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
      ...(token ? { token } : {}),
    });
    game.attach(session);
  };

  let budget = 40;
  const refill = setInterval(() => {
    budget = Math.min(40, budget + 20);
  }, 1000);

  let chatBudget = 4;
  const chatRefill = setInterval(() => {
    chatBudget = Math.min(4, chatBudget + 1);
  }, 1500);

  let syncBudget = 2;
  const syncRefill = setInterval(() => {
    syncBudget = Math.min(2, syncBudget + 1);
  }, 3000);

  let joinBudget = 6;
  const joinRefill = setInterval(() => {
    joinBudget = Math.min(6, joinBudget + 1);
  }, 2000);

  ws.on("message", (raw) => {
    if (budget <= 0) {
      send({ t: "error", message: "rate limited" });
      return;
    }
    budget--;
    if (typeof raw === "object" && "byteLength" in raw && raw.byteLength > 8192) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    void handle(msg).catch((err) => {
      console.error("message failed", msg.t, err);
      send({ t: "error", message: "server error" });
    });
  });

  async function handle(msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case "auth": {
        if (session) return;
        if (nonceSpent || Date.now() - nonceAt > NONCE_TTL_MS) {
          send({ t: "error", message: "challenge expired" });
          return;
        }
        nonceSpent = true;
        const wallet = String(msg.wallet ?? "");
        if (!verify(wallet, nonce, String(msg.sig ?? ""))) {
          send({ t: "error", message: "signature rejected" });
          return;
        }
        const token = randomBytes(24).toString("hex");
        db.setAuthToken(wallet, token);
        seat(wallet, false, token);
        return;
      }

      case "arcade": {
        if (session) return;
        const offered = String(msg.token ?? "");
        void (async () => {
          const wallet = await arcadeWallet(offered);
          if (!wallet) {
            send({ t: "error", message: "arcade session rejected" });
            return;
          }
          if (session) return;
          const token = randomBytes(24).toString("hex");
          db.setAuthToken(wallet, token);
          seat(wallet, false, token);
        })();
        return;
      }

      case "resume": {
        if (session) return;
        if (!mayResume(ip)) {
          send({ t: "error", message: "too many attempts" });
          return;
        }
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

      case "logout": {
        if (!session || session.guest) return;
        db.clearAuthToken(session.wallet);
        return;
      }

      case "guest": {
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
        if (session.guest) {
          send({ t: "error", message: "connect a wallet to play for real" });
          return;
        }
        if (joinBudget <= 0) {
          send({ t: "error", message: "slow down" });
          return;
        }
        joinBudget--;
        const err = await game.join(session);
        if (err) send({ t: "error", message: err });
        return;
      }

      case "unjoin": {
        if (!session) return;
        const err = await game.unjoin(session);
        if (err) send({ t: "error", message: err });
        return;
      }

      case "cashout":
        if (session) game.cashOut(session);
        return;

      case "sync": {
        if (!session || session.guest) return;
        if (syncBudget <= 0) return;
        syncBudget--;
        game.refresh(session);
        return;
      }

      case "setAuto": {
        if (!session) return;
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
        const text = String(msg.text ?? "")
          .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .trim()
          .slice(0, 160);
        if (!text) return;
        if (chatBudget <= 0) {
          send({ t: "error", message: "chat: slow down" });
          return;
        }
        chatBudget--;
        game.chat(session, text);
        return;
      }

      case "setChar":
        if (!session) return;
        if (!CHARS.includes(String(msg.charId))) {
          send({ t: "error", message: "unknown character" });
          return;
        }
        db.setChar(session.wallet, String(msg.charId));

    }
  }

  ws.on("pong", () => {
    alive = true;
  });

  const ping = setInterval(() => {
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
    clearInterval(syncRefill);
    clearInterval(joinRefill);
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left <= 0) perIp.delete(ip);
    else perIp.set(ip, left);
    if (session) {
      db.touch(session.wallet);
      game.detach(session);
    }
  });
});

http.listen(CONFIG.port, () => {
  console.log(`THIN ICE server on :${CONFIG.port}`);
  console.log(`  db     ${CONFIG.dbPath}`);
});

process.on("uncaughtException", (err) => console.error("uncaught", err));
process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    game.shutdown();
    db.close();
    process.exit(0);
  });
}
