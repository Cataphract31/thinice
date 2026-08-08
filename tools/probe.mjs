/**
 * End-to-end check against a running server.
 *
 * Seats two independent players, watches a full round, and asserts the things
 * that must be true of an authoritative multiplayer casino: both players are
 * in the SAME round, money moves exactly once, the fairness commitment covers
 * the seed and the rules, and a client cannot set fields the server owns.
 *
 *   node probe.mjs [ws://127.0.0.1:8787]
 */
import { WebSocket } from "ws";
import { createHash } from "node:crypto";

const URL = process.argv[2] ?? "ws://127.0.0.1:8787";
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { console.log("  FAIL " + m); bad++; };

function player(name, id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const p = {
      name, ws, states: [], history: [], errors: [], chats: [], ready: null,
      send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "challenge") p.send({ t: "guest", id });
      else if (m.t === "ready") { p.ready = m; resolve(p); }
      else if (m.t === "state") p.states.push(m.state);
      else if (m.t === "history") p.history = m.history;
      else if (m.t === "chat") p.chats.push(...m.msgs);
      else if (m.t === "error") p.errors.push(m.message);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (p) => p.states[p.states.length - 1];
const waitFor = async (p, pred, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (p.states.length && pred(last(p))) return last(p);
    await sleep(60);
  }
  return null;
};

console.log(`\n  THIN ICE server probe -> ${URL}\n`);

// Three clients, not two. The server runs no bots, so with two seats the
// first elimination instantly makes the other player a sole survivor and the
// round ends — after which the cash-out and payout assertions below were
// skipped by their own guards, silently, and the probe reported all-pass
// while never once exercising a payout.
const stamp = Date.now().toString(16);
const alice = await player("alice", "probealice" + stamp);
const bob = await player("bob", "probebob" + stamp);
const carol = await player("carol", "probecarol" + stamp);
ok(`three clients authenticated (${alice.ready.wallet.slice(0, 18)}…, guest=${alice.ready.guest})`);

await waitFor(alice, (s) => s.phase === "lobby");
await waitFor(bob, (s) => s.phase === "lobby");
await waitFor(carol, (s) => s.phase === "lobby");

const startA = last(alice).wallet;
const startB = last(bob).wallet;
const entry = last(alice).entry;
ok(`starting balances: alice ${startA} ◎, bob ${startB} ◎, entry ${entry} ◎`);

// ---------------------------------------------------------------- rejections
bob.send({ t: "setChar", charId: "<img src=x onerror=alert(1)>" });
await sleep(300);
if (bob.errors.some((e) => /unknown character/i.test(e))) {
  ok("server rejected an arbitrary charId instead of echoing it to everyone");
} else fail("arbitrary charId was accepted");

// ------------------------------------------------------------------- chat
// Unique text per run: chat history survives in server memory between probe
// runs, so a fixed string could match a stale line from a previous probe.
const shortAddr = (a) => (a.length <= 10 ? a : a.slice(0, 4) + "…" + a.slice(-4));
const line = `gm from the probe ${stamp}`;
alice.send({ t: "chat", text: line });
await sleep(500);

const heard = bob.chats.find((c) => c.text === line);
if (heard && heard.name === shortAddr(alice.ready.wallet) && !heard.you) {
  ok(`chat relayed to the other player as "${heard.name}"`);
} else fail(`chat not relayed (${heard ? "identity wrong" : "never arrived"})`);

const echo = alice.chats.find((c) => c.text === line);
if (echo && echo.you === true) ok("sender's own echo comes back marked as you");
else fail("sender never received their own line back");

alice.send({ t: "chat", text: "x".repeat(400) + stamp });
await sleep(500);
const long = bob.chats.find((c) => c.text.startsWith("xxx"));
if (long && long.text.length <= 160) ok(`oversized message truncated to ${long.text.length} chars`);
else fail(long ? `oversized message arrived at ${long.text.length} chars` : "truncated message never arrived");

// The burst has to hit the chat limiter, not just the global one: every line
// is a broadcast to the whole room, so gameplay-rate chat is a DoS on every
// other player's screen.
const before = bob.chats.length;
for (let i = 0; i < 8; i++) alice.send({ t: "chat", text: `flood ${i} ${stamp}` });
await sleep(700);
const flooded = bob.chats.length - before;
if (alice.errors.some((e) => /chat/i.test(e)) && flooded < 8) {
  ok(`chat flood limited: ${flooded}/8 delivered, sender told to slow down`);
} else fail(`chat flood not limited (${flooded}/8 delivered, error=${alice.errors.some((e) => /chat/i.test(e))})`);

// ------------------------------------------------------------------ join
const lobby = await waitFor(alice, (s) => s.phase === "lobby" && s.msToPhaseEnd > 2500);
alice.send({ t: "join" });
bob.send({ t: "join" });
carol.send({ t: "join" });
await sleep(700);

const a1 = last(alice), b1 = last(bob);
if (a1.you.joined && b1.you.joined) ok("both players seated");
else fail(`join failed (alice ${a1.you.joined}, bob ${b1.you.joined})`);

if (a1.roundId === b1.roundId) ok(`same round for both: #${a1.roundId} (shared game, not two simulations)`);
else fail(`different rounds: alice #${a1.roundId} vs bob #${b1.roundId}`);

const debited = +(startA - a1.wallet).toFixed(9);
if (Math.abs(debited - entry) < 1e-9) ok(`entry debited exactly once: -${debited} ◎`);
else fail(`entry debit wrong: expected ${entry}, got ${debited}`);

// double join must not double charge
const balBefore = last(alice).wallet;
alice.send({ t: "join" });
await sleep(400);
if (Math.abs(last(alice).wallet - balBefore) < 1e-9) ok("double join did not charge twice");
else fail("double join charged a second entry");

const commit = a1.nextCommit;
if (/^[0-9a-f]{64}$/.test(commit)) ok(`commitment published before seal: ${commit.slice(0, 20)}…`);
else fail(`no commitment during lobby (got "${commit}")`);

// ------------------------------------------------------------------- live
const liveS = await waitFor(alice, (s) => s.phase === "live");
if (!liveS) fail("round never sealed");
else ok(`round sealed with ${liveS.totalCount} plates`);

if (last(alice).nextCommit === commit) ok("commitment unchanged from lobby through seal");
else fail("commitment changed after players were sealed in");

// bob extracts as soon as the round is genuinely live; alice rides it out.
// No profit threshold to wait for: with three seats the multiplier only moves
// on a death, and waiting for one is what made this check skippable.
await waitFor(bob, (s) => s.phase !== "live" || s.you.outcome !== "in" || s.tick >= 1, 40000);
let bobCashed = false;
if (last(bob).phase === "live" && last(bob).you.outcome === "in") {
  bob.send({ t: "cashout" });
  await sleep(600);
  const b = last(bob);
  if (b.you.outcome === "cashed") {
    bobCashed = true;
    ok(`bob extracted at ${b.you.multiple.toFixed(2)}×`);
  } else fail("cashout did not register");
} else {
  // Not a skip. If the probe cannot reach a cash-out it has not tested the
  // payout path, and a run that tested nothing must not report success.
  fail(
    `bob never reached a cashable state (phase=${last(bob).phase}, outcome=${last(bob).you.outcome}) — payout path untested`,
  );
}

const done = await waitFor(alice, (s) => s.phase === "result", 90000);
if (!done) fail("round never resolved");
else ok(`round #${done.roundId} resolved after ${done.tick} ticks, winner ${done.winner?.charId ?? "-"}`);

await sleep(1200);

// ------------------------------------------------------------- settlement
const bEnd = last(bob);
if (bobCashed) {
  const expect = +(startB - entry + bEnd.you.multiple * entry).toFixed(6);
  const actual = +bEnd.wallet.toFixed(6);
  // rakeback streams in on top, so the balance must be at least the payout
  if (actual + 1e-9 >= expect) ok(`bob paid out: ${actual} ◎ (>= ${expect} staked+won)`);
  else fail(`bob underpaid: ${actual} ◎ < ${expect} ◎`);
} else {
  fail("settlement never checked — bob did not cash out");
}

const aEnd = last(alice);
if (aEnd.stats.wagered >= entry) ok(`stats recorded: wagered ${aEnd.stats.wagered} ◎, rounds ${aEnd.stats.roundsPlayed}`);
else fail(`stats not recorded (wagered ${aEnd.stats.wagered})`);

if (aEnd.online >= 2) ok(`online count reflects both players: ${aEnd.online}`);
else fail(`online count wrong: ${aEnd.online}`);

// -------------------------------------------------------------- fairness
await sleep(600);
const row = alice.history.find((h) => h.roundId === done.roundId);
if (!row) fail("finished round did not reach history");
else {
  const rec = JSON.parse(row.record);
  if (typeof rec.seedHex === "string" && rec.seedHex.length >= 32) {
    ok(`seed is ${rec.seedHex.length * 4} bits (${rec.seedHex.slice(0, 12)}…) — not brute-forceable`);
  } else fail(`seed too small for commit-reveal: ${JSON.stringify(rec.seedHex ?? rec.seed)}`);

  if (rec.config && rec.config.entry) ok("record carries the rules the round ran under");
  else fail("record has no config — a replay cannot know the rules");

  const rulesHash = createHash("sha256")
    .update(canonical(rec.config)).digest("hex");
  const recomputed = createHash("sha256")
    .update(`thinice:${row.roundId}:${rec.seedHex}:${rulesHash}`).digest("hex");
  if (recomputed === row.commit) ok("revealed seed + rules hash to the pre-published commitment");
  else fail(`commitment mismatch\n         published  ${row.commit}\n         recomputed ${recomputed}`);

  // The seed the round was REPLAYED on must be the seed that was COMMITTED to.
  // Without this the two can differ and a rigged round still verifies.
  if (rec.seedHex === row.seedHex) ok("record seed and revealed seed are the same seed");
  else fail(`seed split: record ${rec.seedHex} vs row ${row.seedHex}`);

  // The commitment must not have changed between the lobby and the record.
  if (row.commit === commit) ok("finished round reports the commitment published in its lobby");
  else fail(`commitment rewritten after the round: lobby ${commit} vs history ${row.commit}`);

  if (rec.bonanza && typeof rec.bonanza.fire === "number") {
    ok(`jackpot draw recorded (fire ${rec.bonanza.fire.toFixed(6)}) — checkable from the seed`);
  } else fail("no jackpot draw in the record: the biggest payout is unverifiable");

  // Your own seat, so the payout line can be checked against the replay.
  if (typeof row.yourSeat === "number" && row.yourSeat > 0) {
    ok(`history carries your seat (#${row.yourSeat}) so your payout is checkable`);
  } else fail(`history has no seat id: your own result cannot be verified`);
}

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

alice.close();
bob.close();
carol.close();
console.log(bad === 0 ? "\n  ALL SERVER CHECKS PASS\n" : `\n  ${bad} SERVER CHECK(S) FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
