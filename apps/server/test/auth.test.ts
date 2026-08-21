import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import bs58 from "bs58";
import nacl from "tweetnacl";

// The wire layer is where every untested fix used to live, so these tests boot
// the actual server process and speak the actual protocol: nothing here can
// pass against a mock.

const ORIGIN_OK = "http://good.example";
const SITE = "https://thinice.example";

interface Msg {
  t: string;
  [k: string]: unknown;
}

class Client {
  ws: WebSocket;
  inbox: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  #waiters: ((m: Msg) => void)[] = [];
  #closedWaiters: ((c: { code: number; reason: string }) => void)[] = [];

  constructor(origin?: string, xff?: string) {
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.origin = origin;
    if (xff !== undefined) headers["x-forwarded-for"] = xff;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers });
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)) as Msg;
        const w = this.#waiters.shift();
        // A message goes to EITHER a waiter or the inbox, never both: a
        // waiter-consumed frame must not be scannable twice.
        if (w) w(m);
        else this.inbox.push(m);
      } catch {
      }
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      const w = this.#closedWaiters.shift();
      if (w) w(this.closed);
    });
  }

  static open(origin?: string, xff?: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const c = new Client(origin, xff);
      const bail = setTimeout(() => reject(new Error("socket never opened")), 5000);
      c.ws.on("open", () => {
        clearTimeout(bail);
        resolve(c);
      });
      c.ws.on("error", (err) => {
        clearTimeout(bail);
        reject(err);
      });
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  sendRaw(buf: Buffer): void {
    this.ws.send(buf);
  }

  next(timeoutMs = 4000): Promise<Msg> {
    const found = this.inbox.shift();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const bail = setTimeout(() => reject(new Error(`timed out waiting for a message (had ${this.inbox.length} queued)`)), timeoutMs);
      this.#waiters.push((m) => {
        clearTimeout(bail);
        resolve(m);
      });
    });
  }

  async until(pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.inbox.findIndex(pred);
      if (idx >= 0) return this.inbox.splice(idx, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for matching message");
      const m = await this.next(left);
      if (!pred(m)) continue;
      return m;
    }
  }

  closedAs(): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve) => this.#closedWaiters.push(resolve));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function keypair(): { wallet: string; sign(text: string): string } {
  const keys = nacl.sign.keyPair();
  return {
    wallet: bs58.encode(keys.publicKey),
    sign(text: string): string {
      return Buffer.from(
        nacl.sign.detached(new TextEncoder().encode(text), keys.secretKey),
      ).toString("base64");
    },
  };
}

let PORT = 0;
let dir = "";
let child: ReturnType<typeof spawn> | null = null;

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok: boolean; ledger: boolean };
        assert.equal(body.ok, true);
        assert.equal(body.ledger, false, "these tests run with the ledger closed");
        return;
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server never became healthy");
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "thinice-auth-"));
  PORT = 20000 + Math.floor(Math.random() * 20000);
  child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/index.ts"],
    {
      cwd: path.resolve(import.meta.dirname, "..", "..", ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: path.join(dir, "auth.db"),
        PUBLIC_ORIGIN: SITE,
        ALLOWED_ORIGINS: ORIGIN_OK,
        LEDGER_KEY: "",
        LEDGER_KEY_FILE: "",
        // The direct-exposure posture: nothing upstream is trusted, so no
        // connection may vote itself a different address through
        // X-Forwarded-For. This is the exact configuration whose bypass was
        // the finding.
        TRUSTED_PROXIES: "10.99.99.99",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitHealthy();
});

after(async () => {
  child?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  child?.kill("SIGKILL");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
});

test("a page from an origin that is not allowlisted never reaches the protocol", async () => {
  const c = await Client.open("http://evil.example");
  const closed = await c.closedAs();
  assert.equal(closed.code, 1008);
});

test("a page with no origin header is refused while the allowlist is set", async () => {
  const c = await Client.open(undefined);
  const closed = await c.closedAs();
  assert.equal(closed.code, 1008);
});

test("the challenge binds the site's own name into the text to sign", async () => {
  const c = await Client.open(ORIGIN_OK);
  try {
    const ch = await c.until((m) => m.t === "challenge");
    const text = String(ch.text ?? "");
    assert.match(text, /^THIN ICE login\n/);
    assert.match(text, new RegExp(`site: ${SITE.replace(/\./g, "\\.")}\n`));
    assert.equal(text.endsWith(`nonce: ${ch.nonce}`), true);
  } finally {
    await c.close();
  }
});

test("an anonymous visitor may watch, and may do nothing else", async () => {
  const c = await Client.open(ORIGIN_OK);
  try {
    await c.until((m) => m.t === "challenge");
    c.send({ t: "spectate" });
    const ready = await c.until((m) => m.t === "ready");
    assert.equal(ready.spectator, true);
    assert.ok(String(ready.wallet).startsWith("~spec:"), "the server names the spectator");
    assert.equal(ready.token, undefined, "spectators are issued no bearer credential");

    // A seat means live state arrives.
    await c.until((m) => m.t === "state");

    c.send({ t: "join" });
    const joinErr = await c.until((m) => m.t === "error");
    assert.match(String(joinErr.message), /connect a wallet/);

    c.send({ t: "chat", text: "hello from nowhere" });
    const chatErr = await c.until((m) => m.t === "error");
    assert.match(String(chatErr.message), /chat: connect a wallet/);

    c.send({ t: "setChar", charId: "pepe" });
    c.send({ t: "setAuto", enabled: true, target: 2, plates: 1 });

    // The old guest door is gone: an id buys nothing at all.
    c.send({ t: "guest", id: "aaaaaaaaaaaaaaaa" });
    await new Promise((r) => setTimeout(r, 250));
    const late = c.inbox.find((m) => m.t === "ready" && m.spectator !== true);
    assert.equal(late, undefined, "no seat was issued for a client-chosen id");
  } finally {
    await c.close();
  }
});

test("a signed challenge seats the wallet and hands back a resume token", async () => {
  const k = keypair();
  const c = await Client.open(ORIGIN_OK);
  try {
    const ch = await c.until((m) => m.t === "challenge");
    c.send({ t: "auth", wallet: k.wallet, sig: k.sign(String(ch.text)) });
    const ready = await c.until((m) => m.t === "ready");
    assert.equal(ready.wallet, k.wallet);
    assert.equal(ready.spectator, false);
    assert.match(String(ready.token), /^[0-9a-f]{48}$/);
    await c.until((m) => m.t === "state");

    // The spent nonce cannot be replayed, even re-signed honestly.
    c.send({ t: "auth", wallet: k.wallet, sig: k.sign(String(ch.text)) });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.inbox.find((m) => m.t === "ready"), undefined, "one nonce, one seat");
  } finally {
    await c.close();
  }
});

test("a signature over any other text is rejected", async () => {
  const k = keypair();
  const c = await Client.open(ORIGIN_OK);
  try {
    const ch = await c.until((m) => m.t === "challenge");
    c.send({ t: "auth", wallet: k.wallet, sig: k.sign(`THIN ICE login\nnonce: ${ch.nonce}`) });
    const err = await c.until((m) => m.t === "error");
    assert.equal(err.message, "signature rejected");
  } finally {
    await c.close();
  }
});

test("a challenge minted for another socket does not seat this one", async () => {
  const k = keypair();
  const a = await Client.open(ORIGIN_OK);
  const chA = await a.until((m) => m.t === "challenge");
  await a.close();

  const b = await Client.open(ORIGIN_OK);
  try {
    await b.until((m) => m.t === "challenge");
    b.send({ t: "auth", wallet: k.wallet, sig: k.sign(String(chA.text)) });
    const err = await b.until((m) => m.t === "error");
    assert.equal(err.message, "signature rejected");
  } finally {
    await b.close();
  }
});

test("resume turns a held token back into the same seat", async () => {
  const k = keypair();
  const first = await Client.open(ORIGIN_OK);
  const ch = await first.until((m) => m.t === "challenge");
  first.send({ t: "auth", wallet: k.wallet, sig: k.sign(String(ch.text)) });
  const ready = await first.until((m) => m.t === "ready");
  const token = String(ready.token);
  await first.close();

  const second = await Client.open(ORIGIN_OK);
  try {
    await second.until((m) => m.t === "challenge");
    second.send({ t: "resume", wallet: k.wallet, token });
    const again = await second.until((m) => m.t === "ready");
    assert.equal(again.wallet, k.wallet);
    assert.equal(again.token, undefined, "resume does not re-mint");
  } finally {
    await second.close();
  }
});

test("resume refuses a wrong token, and refuses wallets that smell like guests", async () => {
  const k = keypair();
  const c = await Client.open(ORIGIN_OK);
  try {
    await c.until((m) => m.t === "challenge");
    c.send({ t: "resume", wallet: k.wallet, token: "deadbeef".repeat(6) });
    let err = await c.until((m) => m.t === "error");
    assert.equal(err.message, "session expired");

    c.send({ t: "resume", wallet: "guest:somebodys-id", token: "whatever" });
    err = await c.until((m) => m.t === "error");
    assert.equal(err.message, "session expired", "colon-carrying wallets never reach the token table");
  } finally {
    await c.close();
  }
});

test("an expired token is not a seat", async () => {
  const k = keypair();
  const first = await Client.open(ORIGIN_OK);
  const ch = await first.until((m) => m.t === "challenge");
  first.send({ t: "auth", wallet: k.wallet, sig: k.sign(String(ch.text)) });
  await first.until((m) => m.t === "ready");
  await first.close();

  const dbPath = path.join(dir, "auth.db");
  const raw = new DatabaseSync(dbPath);
  const row = raw
    .prepare("SELECT token FROM wallet_tokens WHERE wallet = ?")
    .get(k.wallet) as { token: string } | undefined;
  assert.ok(row, "the token row exists");
  raw
    .prepare("UPDATE wallet_tokens SET at = ? WHERE wallet = ?")
    .run(Date.now() - 31 * 86_400_000, k.wallet);
  raw.close();

  const second = await Client.open(ORIGIN_OK);
  try {
    await second.until((m) => m.t === "challenge");
    second.send({ t: "resume", wallet: k.wallet, token: row.token });
    const err = await second.until((m) => m.t === "error");
    assert.equal(err.message, "session expired");
  } finally {
    await second.close();
  }
});

test("forty messages is the budget; the forty-first is told so", async () => {
  const c = await Client.open(ORIGIN_OK);
  try {
    await c.until((m) => m.t === "challenge");
    for (let i = 0; i < 41; i++) c.send({ t: "bogus" });
    const err = await c.until((m) => m.t === "error");
    assert.equal(err.message, "rate limited");
  } finally {
    await c.close();
  }
});

test("an oversized frame is dropped without taking the server down", async () => {
  const c = await Client.open(ORIGIN_OK);
  try {
    await c.until((m) => m.t === "challenge");
    c.sendRaw(Buffer.alloc(9000, 0x61));
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(res.ok, true, "the server is still alive");
  } finally {
    await c.close();
  }
});

test("resume guessing is capped per address ACROSS sockets, and a spoofed X-Forwarded-For does not buy a fresh bucket", async () => {
  const k = keypair();
  const burn = async (): Promise<void> => {
    const c = await Client.open(ORIGIN_OK);
    try {
      await c.until((m) => m.t === "challenge");
      c.send({ t: "resume", wallet: k.wallet, token: "000000000000000000000000000000000000000000000000" });
      await c.until((m) => m.t === "error");
    } finally {
      await c.close();
    }
  };

  // Ten guesses are allowed inside the window...
  for (let i = 0; i < 10; i++) await burn();

  // ...and they were counted against THIS machine's address: the server runs
  // with no trusted proxy, so a fresh socket claiming someone else's IP in
  // X-Forwarded-For lands in the same exhausted bucket.
  const sneaky = await Client.open(ORIGIN_OK, "9.9.9.9");
  try {
    await sneaky.until((m) => m.t === "challenge");
    sneaky.send({ t: "resume", wallet: k.wallet, token: "000000000000000000000000000000000000000000000000" });
    const err = await sneaky.until((m) => m.t === "error");
    assert.equal(err.message, "too many attempts");
  } finally {
    await sneaky.close();
  }
});
