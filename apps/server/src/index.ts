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

/*
 * THE BOOKS, AND THE SWEEP THAT MAKES A CRASH SURVIVABLE.
 *
 * A round interrupted by a crash left stakes held and never settled. The local
 * rollback marks those entries refunded; `ledger.sweep()` gives the money back,
 * releasing every hold this game still has open. Money that silently evaporates
 * on restart is the one bug a ledger may never have.
 *
 * The sweep runs BEFORE the first lobby opens, so no new stake can be taken
 * while the old ones are still in flight -- and it is idempotent, so a restart
 * loop cannot refund anything twice.
 */
const ledger = createArcadeLedger();
if (!ledger.enabled) {
  console.warn(
    "NO LEDGER_KEY: this server cannot take a stake. Rounds will open and every join will be refused.",
  );
}

/*
 * ASKED ONCE, AT BOOT, ON THE MACHINE THAT CAN ALWAYS ANSWER IT.
 *
 * config.ts converts every SOL figure through the arcade's own money.js, which
 * lives here as a byte-for-byte copy. Nothing else in this repository checks
 * that the copy is still honest -- there is no unit suite, and itest-ledger.mjs
 * needs two live servers -- so the server checks itself.
 */
const moneyRule = reportVendoredMoney();

const refunded = db.refundOpenEntries();
if (refunded > 0) console.log(`rolled back ${refunded} entries from an unfinished round`);
/*
 * AND THE ROUND ITSELF IS REVEALED RATHER THAN LEFT HANGING.
 *
 * A round the last process died inside published a commitment, took real SOL,
 * and then never got a seed written -- and `historyFor` excludes a round with
 * no `endedAt`, so it became one nobody could ever ask the operator to prove.
 * Every crash and every deploy restart minted one. The secret was recorded
 * when the lobby opened for exactly this moment.
 */
const revealed = db.revealInterrupted(DEFAULT_CONFIG, roundSeedFrom);
if (revealed > 0) console.log(`revealed ${revealed} interrupted round(s) so they stay checkable`);
if (ledger.enabled) {
  try {
    const released = await ledger.sweep();
    if (released > 0) console.log(`released ${released} stranded holds back to their wallets`);
  } catch (err) {
    // Refusing to boot would leave the table down for a ledger hiccup; the
    // holds stay open and the next restart sweeps them. Loud, because money
    // sitting in escrow with no round behind it is a thing somebody must see.
    console.error(`COULD NOT SWEEP STRANDED HOLDS: ${(err as Error).message}`);
  }
  /*
   * AND THE ROOM THIS GAME WAS HOLDING IN THE BOX-WIDE REGISTER, AFTER THE
   * HOLDS AND NEVER BEFORE THEM.
   *
   * Our exposure rows sit in the arcade's process, which keeps running when
   * this one dies, so without this a crash leaves the box believing it owes
   * payouts for rounds that no longer exist -- shrinking every other table's
   * headroom with nothing alive to put it back. The arcade refuses this while
   * a stake of ours is still in escrow (409 ROUNDS_IN_FLIGHT): one shared
   * service key means no caller can prove who it is, so a live hold stands in
   * as proof of a live round. Hence the order.
   */
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
      // The hold sweep above did not land, so the arcade still sees a stake of
      // ours in escrow and reads that as a live round. Worth saying plainly:
      // the two failures are one failure, and the second is only the symptom.
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

/**
 * THE ARCADE'S SIGN-IN, TRUSTED OVER THE LOOPBACK AND NOWHERE ELSE.
 *
 * One issuer signs the player in once and every game verifies the token that
 * comes out of it; the alternative is six games issuing six challenges and a
 * player signing six times to walk around one building. This asks that issuer
 * who a token belongs to.
 *
 * IT MUST STAY A LOCAL ADDRESS. This function converts "holds a token" into
 * "is this wallet", so whoever answers it can seat anybody. Pointed at a host
 * someone else controls, that is the whole ledger handed over. It defaults to
 * the loopback for that reason, and an override belongs in the unit file next
 * to the database path, not in a client.
 */
const AUTH_PATH = "/api/auth/me";

/*
 * A BASE URL OR A WHOLE ONE, BECAUSE THE BOX SETS A BASE AND THIS WANTED AN
 * ENDPOINT -- AND THE DISAGREEMENT COST THIS GAME ITS ARCADE SIGN-IN ENTIRELY.
 *
 * /etc/arcade/arcade.env carries the two together:
 *
 *     ARCADE_LEDGER_URL=http://127.0.0.1:8080
 *     ARCADE_AUTH_URL=http://127.0.0.1:8080
 *
 * and the first genuinely IS a base -- arcade.ts appends its own paths to it.
 * This one was read as a complete endpoint, so it fetched the arcade's ROOT,
 * which answers the portal's HTML with a 200. `res.ok` passed, `res.json()`
 * threw on `<!doctype html>`, and the throw landed in the catch below whose
 * comment says "issuer unreachable or slow". It was neither. arcadeWallet()
 * simply returned null on every call ever made.
 *
 * What a player saw: every arcade session refused, a guest seat every time,
 * and a chip that said RE-SIGN and did nothing when pressed -- no wallet
 * prompt, because there was nothing wrong with the wallet. Reported as "it
 * still doesnt get the same session or cookie from main arcade", which is
 * exactly what was happening.
 *
 * So both forms are accepted and the base is the one the box is actually
 * configured with. A value naming a path is used as given, which keeps the
 * default above and anything already written down working.
 */
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
  // Shape-checked before it leaves this process: a token is 64 hex characters
  // and anything else is not worth a round trip, let alone a header.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    const res = await fetch(ARCADE_AUTH, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    /*
     * JSON BECAUSE THE HEADER SAYS SO, and it is worth the two lines. When
     * this pointed at the arcade's root it got the portal's HTML with a 200:
     * res.ok passed, res.json() threw, and the throw was reported by the catch
     * below as an unreachable issuer. A wrong URL wore the costume of a slow
     * network for as long as nobody looked. Saying which one it is out loud is
     * the difference between a five-second diagnosis and a field report.
     */
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
    // Base58, 32-44 characters: an address and never a namespaced id. Guests
    // and bots live behind a colon here, and nothing may seat one by token.
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) ? wallet : null;
  } catch {
    // Issuer unreachable or slow. The client still has its own signature
    // ceremony to fall back on, so silence is the right answer.
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
  // A trivial health endpoint, so "is the server up" never needs a websocket.
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    // `moneyRule` is "matches", "DRIFTED", or "unchecked" -- see vendorcheck.ts.
    // On a machine with no arcade checkout the honest answer is that nobody
    // asked, which is not the same as an answer of yes.
    res.end(JSON.stringify({ ok: true, ledger: ledger.enabled, moneyRule }));
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

/*
 * RESUME ATTEMPTS PER IP, ACROSS SOCKETS.
 *
 * Every other bucket in this file is per socket, which is the right shape for
 * flood control and the wrong shape for guessing at a credential: a caller
 * that has used up one socket's budget opens another. `resume` is the message
 * that turns a bearer string into a seat, and a seat is a money primitive --
 * so its budget follows the IP, and reconnecting does not refill it.
 *
 * Swept on a timer rather than on use, so the map cannot grow with every
 * address that ever knocked.
 */
const resumeTries = new Map<string, { n: number; at: number }>();
const RESUME_WINDOW_MS = 60_000;
setInterval(() => {
  const cutoff = Date.now() - RESUME_WINDOW_MS;
  for (const [ip, r] of resumeTries) if (r.at < cutoff) resumeTries.delete(ip);
}, RESUME_WINDOW_MS).unref();

/** True if this address may try `resume` again right now. */
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
    /*
     * A SPECTATOR IS NOT A PLAYER RECORD.
     *
     * Watching used to mint a `players` row, auto-play settings and all, for an
     * id that can never stake -- the ledger has no account for `guest:` and
     * refuses. Those rows accumulated forever and turned up in every query
     * about who plays this game. Nothing is written for a spectator now; the
     * screen gets a face and a set of zeroes from Database.spectatorRow.
     */
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
      // Minted only on a fresh signature. The client stores it and resumes
      // with it, so one Phantom prompt covers every future connection.
      ...(token ? { token } : {}),
    });
    game.attach(session);
  };

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

  // And a bucket of its own for `sync`, tighter still. That message is the one
  // in this protocol that costs an HTTP round trip to the arcade's ledger, so
  // a socket in a loop on it does not stall this process, it leans on the
  // books every other game on the box is also reading. Two now, one back every
  // three seconds: a bank panel watching a deposit land asks a handful of
  // times over a minute and never notices this exists.
  let syncBudget = 2;
  const syncRefill = setInterval(() => {
    syncBudget = Math.min(2, syncBudget + 1);
  }, 3000);

  /*
   * AND ONE FOR `join`, WHICH COSTS EVERYTHING `sync` COSTS PLUS A WRITE.
   *
   * `sync` was given a bucket of its own because it is "the one message in
   * this protocol that costs an HTTP round trip to the arcade's ledger". That
   * was true of `join` as well, and `join` also asks the books to WRITE -- a
   * hold, inside a SQLite IMMEDIATE transaction that every game on this box
   * shares. It had no bucket at all, so the global budget of 40 with 20/s
   * refill, times MAX_PER_IP of 6, was roughly 120 ledger writes a second from
   * one machine, free: `{t:"guest"}` needs no signature, and a caller that
   * never gets a seat never trips a plate cap, so every message issued a fresh
   * POST. (`game.join` turns a guest away before the round trip now, which
   * closes the free half; this bounds the paid half.)
   *
   * Six now, one back every two seconds. Bonding five plates in one lobby is
   * five messages and a round lasts about twenty seconds, so a player at the
   * cap every single round never reaches this.
   */
  let joinBudget = 6;
  const joinRefill = setInterval(() => {
    joinBudget = Math.min(6, joinBudget + 1);
  }, 2000);

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
    // `handle` is async because two of its cases move money and money is an
    // HTTP call away. The catch has to become a rejection handler with it, or
    // a throw inside one of those awaits unwinds past this try to the
    // process-level handler -- which is the one thing this block exists to
    // prevent: everyone else is mid-round and would lose their stake to a
    // restart.
    void handle(msg).catch((err) => {
      console.error("message failed", msg.t, err);
      send({ t: "error", message: "server error" });
    });
  });

  async function handle(msg: ClientMessage): Promise<void> {
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

      case "arcade": {
        // Same guard as auth: a late arrival must not rotate a token out from
        // under sessions already resuming on it.
        if (session) return;
        const offered = String(msg.token ?? "");
        void (async () => {
          const wallet = await arcadeWallet(offered);
          if (!wallet) {
            send({ t: "error", message: "arcade session rejected" });
            return;
          }
          // Re-checked after the await: seating twice on one socket is the
          // same bug the auth case above is commented for.
          if (session) return;
          // The arcade proved who this is; the seat is still ours to mint, so
          // every later connection resumes down the ordinary path and nothing
          // else in this file has to know the arcade exists.
          const token = randomBytes(24).toString("hex");
          db.setAuthToken(wallet, token);
          seat(wallet, false, token);
        })();
        return;
      }

      case "resume": {
        // Bearer resume, and the one message that turns a string into a seat.
        // Namespaced wallets (guests, bots) can never be resumed into — they
        // have no signature ceremony, so nothing may claim them by token
        // either. The token itself now expires; see db.authTokenOf.
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
        /*
         * REVOCATION, WHICH THIS PROTOCOL DID NOT HAVE.
         *
         * Disconnecting a wallet cleared the browser's copy of the token and
         * nothing else, so the row on this server stayed valid until the heat
         * death of the box -- and that row is a seat, and a seat is a money
         * primitive: whoever holds one can bond the victim's five plates, sit
         * in the same lobby under their own wallet, extract theirs and let the
         * victim's die. "Disconnect" has to mean the seat is gone, not that
         * this device forgot it.
         *
         * Only ever the SESSION's own wallet. Taking one from the message
         * would make this a button for logging strangers out.
         */
        if (!session || session.guest) return;
        db.clearAuthToken(session.wallet);
        return;
      }

      case "guest": {
        /*
         * WATCHING, WHICH IS ALL THIS IS NOW.
         *
         * It was "play without a wallet under a local id", and it cannot be
         * that any more: money is keyed by wallet across this whole arcade and
         * a `guest:` id has no account in the books, so every join is refused
         * with a message saying exactly that.
         *
         * KEPT ANYWAY, because removing it would leave a visitor staring at
         * nothing until they connected a wallet -- there is no state on this
         * socket before a session exists, so this is the only way to see the
         * table at all. Being asked for a wallet before you have seen what the
         * game IS is the wrong order.
         *
         * Namespaced so it can never collide with, or impersonate, a real
         * address, and now persisted nowhere.
         */
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
        // Guests have no account in the books, so a join from one can only
        // ever be refused -- the same guard `sync` has had, for the same
        // reason, on a message that costs strictly more. `game.join` says so
        // again on its own side; this stops the message before it is dispatched.
        if (session.guest) {
          send({ t: "error", message: "connect a wallet to play for real" });
          return;
        }
        if (joinBudget <= 0) {
          send({ t: "error", message: "slow down" });
          return;
        }
        joinBudget--;
        // Awaited now: buying a plate moves money, and money is an HTTP call
        // away. The socket handler is already async, so the only change is
        // that the refusal arrives when the books have actually answered.
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
        // Guests have no books to read: their balance is this box's own row,
        // and nothing at the custody edge can move it.
        if (!session || session.guest) return;
        if (syncBudget <= 0) return;
        syncBudget--;
        game.refresh(session);
        return;
      }

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
    clearInterval(syncRefill);
    clearInterval(joinRefill);
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
});

// Last line of defence. Everything money-related is committed transactionally
// and an unfinished round is refunded at startup, so staying up on an
// unexpected throw is strictly better than dropping every player mid-round.
process.on("uncaughtException", (err) => console.error("uncaught", err));
process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Closes the open round rather than only stopping the clock: a deploy
    // restart otherwise left a published commitment with no reveal, which the
    // startup sweep can rescue the MONEY from but not the proof.
    game.shutdown();
    db.close();
    process.exit(0);
  });
}
