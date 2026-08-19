/*
 * The arcade's books, reached over HTTP — and the three ways that goes wrong.
 *
 * This game may hold a stake, settle it, and give it back. It cannot credit,
 * debit or mint, and it holds no key material, so the worst bug reachable from
 * this file is a mispriced round rather than a signed transfer. What is left
 * is still worth guarding closely, because all three failure modes are silent:
 *
 *   THE KEY LEAVING THE BOX. LEDGER_KEY is the whole authority to move
 *   anybody's money on this machine. Pointed at a public origin it would be
 *   posted to a stranger, and the mistake would look like a config typo.
 *
 *   FAILING OPEN. If the ledger cannot be reached, the stake was NOT taken.
 *   Seating a player anyway is how a game ends up owing a settlement it never
 *   took payment for -- and it would only show up in a solvency sweep.
 *
 *   PAYING TWICE. Every mutating call carries a ref the caller chooses, and
 *   asking twice with the same ref returns the first answer instead of moving
 *   money again. That ref is what makes retries and crash replays safe, so its
 *   shape is load-bearing rather than cosmetic.
 *
 * Everything here runs against an injected `fetchImpl`. No server, no sockets.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createArcadeLedger, LedgerError } from "../src/arcade.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake ledger that records what it was asked and answers however told. */
function fakeFetch(reply: { status?: number; body?: unknown; text?: string } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as typeof globalThis.fetch;
  return { impl, calls };
}

const ledgerWith = (reply?: Parameters<typeof fakeFetch>[0], opts: Record<string, unknown> = {}) => {
  const f = fakeFetch(reply);
  return {
    calls: f.calls,
    ledger: createArcadeLedger({ url: "http://127.0.0.1:8080", key: "test-key", fetchImpl: f.impl, ...opts }),
  };
};

/* ---- the key never leaves the loopback ---- */

test("a service key is refused any destination that is not the loopback", () => {
  for (const url of [
    "https://voidsolana.com",
    "http://10.0.0.5:8080",
    "http://ledger.internal",
    "http://127.0.0.1.evil.com",
    "http://[::2]:8080",
  ]) {
    assert.throws(() => createArcadeLedger({ url, key: "secret" }), /may only travel over the loopback/,
      `accepted ${url}`);
  }
});

test("the loopback spellings a config file actually uses are all accepted", () => {
  for (const url of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080", "http://localhost"]) {
    assert.doesNotThrow(() => createArcadeLedger({ url, key: "secret" }), `rejected ${url}`);
  }
});

test("with no key there is nothing to leak, so the destination is not policed", () => {
  // A box with no LEDGER_KEY cannot take stakes at all -- see below -- so the
  // guard has nothing to protect and must not block a dev pointing elsewhere.
  assert.doesNotThrow(() => createArcadeLedger({ url: "https://example.com", key: "" }));
  assert.equal(createArcadeLedger({ url: "https://example.com", key: "" }).enabled, false);
});

test("a malformed URL is treated as not-loopback rather than waved through", () => {
  assert.throws(() => createArcadeLedger({ url: "not a url", key: "secret" }), /loopback/);
});

test("the key travels in the header, on every route, and never in the URL", () => {
  const { ledger, calls } = ledgerWith({ body: { ref: "r", amount: 1, state: "held" } });
  return Promise.all([
    ledger.hold("wallet", 100, 1, 2),
    ledger.settle(1, 2, 50),
    ledger.release(1, 2),
    ledger.sweep(),
    ledger.balanceOf("wallet"),
  ]).then(() => {
    assert.equal(calls.length, 5);
    for (const c of calls) {
      assert.equal(c.headers["x-ledger-key"], "test-key", `${c.url} sent no key`);
      assert.doesNotMatch(c.url, /test-key/, "the key must not reach a URL, which gets logged");
      assert.match(c.url, /^http:\/\/127\.0\.0\.1:8080\/api\/ledger\//);
    }
  });
});

/* ---- a box that cannot take money says so ---- */

test("without a key every money call fails closed", async () => {
  const ledger = createArcadeLedger({ url: "http://127.0.0.1:8080", key: "" });
  assert.equal(ledger.enabled, false);
  for (const call of [
    () => ledger.hold("w", 1, 1, 1),
    () => ledger.settle(1, 1, 1),
    () => ledger.release(1, 1),
    () => ledger.sweep(),
    () => ledger.balanceOf("w"),
  ]) {
    const err = await call().then(() => null, (e: LedgerError) => e);
    assert.ok(err instanceof LedgerError, "expected a LedgerError");
    assert.equal(err.code, "LEDGER_CLOSED");
    assert.equal(err.status, 503);
  }
});

test("an unreachable ledger does not sell the seat", async () => {
  // The bargain this refuses is "seat now, reconcile later".
  const impl = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof globalThis.fetch;
  const ledger = createArcadeLedger({ url: "http://127.0.0.1:8080", key: "k", fetchImpl: impl });
  const err = await ledger.hold("w", 100, 1, 1).then(() => null, (e: LedgerError) => e);
  assert.equal(err?.code, "LEDGER_UNREACHABLE");
  assert.equal(err?.status, 503);
  assert.match(err!.message, /ECONNREFUSED/, "the cause survives into the log");
});

test("a ledger answering with something that is not JSON is an error, not an empty result", async () => {
  // An HTML error page from a proxy parses as nothing. Reading that as `{}`
  // would turn a failed hold into a successful one with an undefined ref.
  const { ledger } = ledgerWith({ status: 502, text: "<html>Bad Gateway</html>" });
  const err = await ledger.hold("w", 100, 1, 1).then(() => null, (e: LedgerError) => e);
  assert.equal(err?.code, "LEDGER_GARBAGE");
  assert.equal(err?.status, 502);
});

test("the ledger's own refusal is passed through with its code and status", async () => {
  const { ledger } = ledgerWith({
    status: 402,
    body: { error: { code: "INSUFFICIENT_FUNDS", message: "wallet is short" } },
  });
  const err = await ledger.hold("w", 100, 1, 1).then(() => null, (e: LedgerError) => e);
  assert.equal(err?.code, "INSUFFICIENT_FUNDS");
  assert.equal(err?.status, 402);
  assert.equal(err?.message, "wallet is short");
  // The one failure a caller acts on differently: a normal answer, not a fault.
  assert.equal(err?.isBroke, true);
});

test("any other refusal is not mistaken for the player being broke", async () => {
  const { ledger } = ledgerWith({ status: 500, body: { error: { code: "LEDGER_BUG", message: "boom" } } });
  const err = await ledger.hold("w", 100, 1, 1).then(() => null, (e: LedgerError) => e);
  assert.equal(err?.isBroke, false);
  // A refusal with no code at all still becomes a refusal, not a success.
  const bare = ledgerWith({ status: 400, body: {} });
  const err2 = await bare.ledger.hold("w", 1, 1, 1).then(() => null, (e: LedgerError) => e);
  assert.equal(err2?.code, "LEDGER_REFUSED");
  assert.equal(err2?.isBroke, false);
});

/* ---- the ref is what makes retries safe ---- */

test("one seat's money has one ref, forever", () => {
  const { ledger } = ledgerWith();
  assert.equal(ledger.refFor(12, 3), "thin-ice:r12:s3");
  // Round and seat both have to be in it, and they must not run together: with
  // a plain concatenation, round 1 seat 23 and round 12 seat 3 are one ref, and
  // the second stake silently replays the first.
  assert.notEqual(ledger.refFor(1, 23), ledger.refFor(12, 3));
  assert.equal(ledger.refFor(12, 3), ledger.refFor(12, 3), "stable across calls");
});

test("hold, settle and release all name the same ref for the same seat", async () => {
  const { ledger, calls } = ledgerWith({ body: { ref: "thin-ice:r7:s2", amount: 100, state: "held" } });
  await ledger.hold("wallet", 100, 7, 2);
  await ledger.settle(7, 2, 250);
  await ledger.release(7, 2);
  const refs = calls.map((c) => (c.body as { ref: string }).ref);
  assert.deepEqual(refs, ["thin-ice:r7:s2", "thin-ice:r7:s2", "thin-ice:r7:s2"]);
  // A retry of the settle is the same request, which is what makes the deferred
  // flush at round close safe to run as many times as it takes.
  await ledger.settle(7, 2, 250);
  assert.deepEqual(calls[3]!.body, calls[1]!.body);
});

test("a hold names the game and the amount it is taking", async () => {
  const { ledger, calls } = ledgerWith({ body: { ref: "r", amount: 100, state: "held", balance: 900, held: 100 } });
  const res = await ledger.hold("WalletAddr", 100_000_000, 7, 2);
  assert.match(calls[0]!.url, /\/api\/ledger\/hold$/);
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, {
    wallet: "WalletAddr",
    amount: 100_000_000,
    ref: "thin-ice:r7:s2",
    game: "thin-ice",
    memo: "round 7 seat 2",
  });
  assert.equal(res.freeLamports, 900);
  assert.equal(res.heldLamports, 100);
  assert.equal(res.replayed, false);
});

test("a replayed hold is reported as replayed rather than as a fresh stake", async () => {
  // What a crash-and-retry looks like from here. The money did not move again.
  const { ledger } = ledgerWith({ body: { ref: "r", amount: 100, state: "held", replayed: true } });
  assert.equal((await ledger.hold("w", 100, 1, 1)).replayed, true);
});

test("a total loss settles at zero instead of releasing the stake", async () => {
  // A payout of 0 means "played and lost", and the books should say so. A
  // release would say the round never happened and hand the stake back.
  const { ledger, calls } = ledgerWith();
  await ledger.settle(3, 1, 0);
  assert.match(calls[0]!.url, /\/settle$/);
  assert.equal((calls[0]!.body as { payout: number }).payout, 0);
  assert.doesNotMatch(calls[0]!.url, /release/);
});

test("a release says why, for whoever reads the books later", async () => {
  const { ledger, calls } = ledgerWith();
  await ledger.release(3, 1);
  assert.equal((calls[0]!.body as { memo: string }).memo, "round abandoned");
  await ledger.release(3, 1, "lobby never sealed");
  assert.equal((calls[1]!.body as { memo: string }).memo, "lobby never sealed");
});

test("the crash sweep asks only for this game's holds", async () => {
  // Holds outlive the process that made them -- that is the point of holds --
  // and money in flight is the only money a crash can lose. It must not
  // release another game's.
  const { ledger, calls } = ledgerWith({ body: { released: 4 } });
  assert.equal(await ledger.sweep(), 4);
  assert.deepEqual(calls[0]!.body, { game: "thin-ice" });
  const none = ledgerWith({ body: {} });
  assert.equal(await none.ledger.sweep(), 0, "a missing count reads as none, not NaN");
});

test("a balance is read for the screen and coerced to numbers", async () => {
  // Nothing decides anything from this -- `hold` is the check, atomically,
  // where the money is. It still must not hand the state frame a string or
  // undefined, which would render as NaN in front of a player.
  const { ledger, calls } = ledgerWith({ body: { balance: "900", held: "100" } });
  assert.deepEqual(await ledger.balanceOf("w"), { freeLamports: 900, heldLamports: 100 });
  assert.match(calls[0]!.url, /\/balance\?wallet=w$/);
  assert.equal(calls[0]!.method, "GET");
  const empty = ledgerWith({ body: {} });
  assert.deepEqual(await empty.ledger.balanceOf("w"), { freeLamports: 0, heldLamports: 0 });
});

test("a trailing slash in the configured URL does not double up in the path", async () => {
  const f = fakeFetch({ body: {} });
  const ledger = createArcadeLedger({ url: "http://127.0.0.1:8080///", key: "k", fetchImpl: f.impl });
  await ledger.sweep();
  assert.equal(f.calls[0]!.url, "http://127.0.0.1:8080/api/ledger/sweep");
});
