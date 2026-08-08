/**
 * Crash-recovery check.
 *
 * Joins a round, kills the server mid-round, restarts it, and asserts the
 * stake came back. A process that dies holding player money must return it on
 * restart — money that silently evaporates is the one failure a ledger may
 * never have.
 */
import { WebSocket } from "ws";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 8789;
const DB = "crashtest.db";
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { console.log("  FAIL " + m); bad++; };

for (const f of [DB, DB + "-wal", DB + "-shm"]) {
  try { rmSync(`../apps/server/${f}`); } catch {}
}

/**
 * Kill the whole tree, not just the shell.
 *
 * `shell: true` puts cmd.exe between us and node, and killing the shell leaves
 * the server orphaned still holding the port — after which the next boot
 * silently talks to the previous run's process with the previous run's config.
 */
function kill(p) {
  try { execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: "ignore" }); }
  catch { p.kill("SIGKILL"); }
}

function boot() {
  const p = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: "../apps/server",
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => {
    const s = String(d).trim();
    if (s.includes("refunded")) console.log("       server: " + s);
  });
  return p;
}

function connect(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const p = { ws, states: [], send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "challenge") p.send({ t: "guest", id });
      else if (m.t === "ready") resolve(p);
      else if (m.t === "state") p.states.push(m.state);
    });
    ws.on("error", () => {});
  });
}
const last = (p) => p.states[p.states.length - 1];
const waitFor = async (p, pred, ms = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (p.states.length && pred(last(p))) return last(p);
    await sleep(60);
  }
  return null;
};

console.log("\n  CRASH RECOVERY TEST\n");

// Every exit route goes through here, so no path can leave the spawned server
// alive holding the port and the database. An orphan does not just linger: the
// next run's cleanup silently fails, its own boot dies on EADDRINUSE, and the
// test then measures the PREVIOUS run's server against stale state while
// reporting on the current one.
let srv = null;
function done(code) {
  if (srv) kill(srv);
  console.log(code === 0 ? "\n  CRASH RECOVERY HOLDS\n" : `\n  ${bad || 1} FAILURE(S)\n`);
  process.exit(code);
}

srv = boot();
await sleep(6000);

// The server runs no bots, so a second human keeps the round from resolving
// into an instant sole-survivor payout before it can be interrupted.
const GUEST = "crashvictim00001";
let p = await connect(GUEST);
let buddy = await connect("crashbuddy00002");
await waitFor(p, (s) => s.phase === "lobby");
const before = last(p).wallet;
const entry = last(p).entry;
ok(`balance before joining: ${before} ◎`);

// Keep trying across lobbies: a round lasts tens of seconds, so a single shot
// at one lobby window just races the cycle.
let joined = null;
for (let attempt = 0; attempt < 8 && !joined; attempt++) {
  const window = await waitFor(p, (s) => s.phase === "lobby" && s.msToPhaseEnd > 2500, 90000);
  if (!window) break;
  p.send({ t: "join" });
  buddy.send({ t: "join" });
  joined = await waitFor(p, (s) => s.you.joined, 2500);
}
if (!joined) { fail("could not get seated in any lobby"); done(1); }

const afterJoin = last(p).wallet;
if (Math.abs(before - afterJoin - entry) < 1e-9) ok(`staked ${entry} ◎, balance now ${afterJoin} ◎`);
else fail(`stake not debited (${before} -> ${afterJoin})`);

// Wait for the round to be PAST the grace ticks with this player still alive.
//
// Killing at tick 1 only ever exercised the easy case: grace is 2 ticks, so
// no elimination had happened yet and the refund sweep had nothing to do but
// hand back untouched stakes. The interesting crash is one where somebody has
// already died and their stake has been redistributed into the survivors —
// that is where money actually goes missing.
const atRisk = await waitFor(
  p,
  (s) => s.phase === "live" && s.tick >= 3 && s.you.outcome === "in",
  40000,
);
if (!atRisk) {
  const s = last(p);
  fail(`never reached a live at-risk tick. last: phase=${s.phase} tick=${s.tick} ` +
    `you=${s.you.outcome} joined=${s.you.joined} round=${s.roundId} total=${s.totalCount}`);
  done(1);
}
ok(`round live at tick ${atRisk.tick} (past grace), player standing, stake unsettled`);
if (atRisk.deadCount > 0) {
  ok(`${atRisk.deadCount} already eliminated — redistributed money is in play`);
}

p.ws.close();
buddy.ws.close();
kill(srv);
console.log("       *** server killed mid-round ***");
await sleep(2500);

srv = boot();
await sleep(6500);

p = await connect(GUEST);
await waitFor(p, (s) => s.wallet !== undefined);
const after = last(p).wallet;
if (Math.abs(after - before) < 1e-9) {
  ok(`stake refunded on restart: ${after} ◎ (back to pre-join balance)`);
} else {
  fail(`money lost in the crash: ${before} ◎ before, ${after} ◎ after (${(before - after).toFixed(9)} ◎ gone)`);
}

const st = last(p).stats;
if (st.roundsPlayed === 0 && Math.abs(st.wagered) < 1e-9) {
  ok("the abandoned round was reversed out of lifetime stats too");
} else {
  fail(`stats still count the abandoned round: played ${st.roundsPlayed}, wagered ${st.wagered}`);
}

// The buddy is checked too: if they had already died, their stake must have
// come back as well, which is the conservation case a survivors-only refund
// silently fails.
const buddyBack = await connect("crashbuddy00002");
await waitFor(buddyBack, (s) => s.wallet !== undefined);
const bw = last(buddyBack).wallet;
if (Math.abs(bw - before) < 1e-9) ok(`the other player was made whole too: ${bw} ◎`);
else fail(`other player short by ${(before - bw).toFixed(9)} ◎ — the round did not fully roll back`);

p.ws.close();
buddyBack.ws.close();
await sleep(300);
done(bad === 0 ? 0 : 1);
