// Drives the BUILT web client in headless Edge over the DevTools protocol
// and screenshots the moments that matter: the live board (corner seals +
// your own cluster), a chat message popping over its sender, and the endgame
// sequence. The demo needs no server — bots carry the round.
//
//   cd apps/web && npx vite preview --port 4173     (serves dist/)
//   node tools/uitest.mjs [outDir]
//
// Purely a looking-glass: it changes nothing, it photographs.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";

const OUT = process.argv[2] ?? "shots";
const CDP = 9223;
const APP = "http://localhost:4173/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(OUT, { recursive: true });

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${process.env.TEMP}\\zinc-uitest-${Date.now()}`,
    "--window-size=1280,800",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP plumbing
let list = null;
for (let i = 0; i < 60 && !list; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  } catch {
    await sleep(250);
  }
}
if (!list) throw new Error("Edge debug port never came up");
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) =>
      m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result),
    );
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaljs = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, "base64"));
  console.log(`  shot ${OUT}/${name}`);
};
// Case-insensitive: the UI uppercases most copy with CSS, and innerText
// reports the TRANSFORMED text.
const bodyHas = (s) =>
  evaljs(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`);
const waitFor = async (s, tries, gap = 500) => {
  for (let i = 0; i < tries; i++) {
    if (await bodyHas(s)) return true;
    await sleep(gap);
  }
  return false;
};

// ---------------------------------------------------------------- the session
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: APP });
await sleep(1800);
await evaljs(`localStorage.setItem("zinc.introSeen", "1")`);
await send("Page.navigate", { url: APP });
await sleep(2000);

// Bond three plates during the lobby, so the board has OUR cluster on it.
if (!(await waitFor("Bond in", 90))) console.log("  ! never saw a lobby");
for (let i = 0; i < 3; i++) {
  console.log(
    "  bond:",
    await evaljs(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /^Bond (in|another)/.test(x.textContent.trim()));
      if (!b || b.disabled) return "unavailable";
      b.click();
      return b.textContent.trim();
    })()`),
  );
  await sleep(350);
}

// Live phase: give the round a few ticks so exits and deaths dress the board.
if (!(await waitFor("Extract", 40))) console.log("  ! never saw the live phase");
await sleep(3500);
await shot("board_live.png");

// Say something; the bubble should ride over our own cluster.
console.log(
  "  chat:",
  await evaljs(`(() => {
    const inp = document.querySelector('input[placeholder="say something"]');
    if (!inp) return "no chat input";
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(inp, "gm, this ice is THIN");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.form.requestSubmit();
    return "sent";
  })()`),
);
await sleep(700);
await shot("chat_pop.png");

// The ending: result phase flips the action bar to "Next round in". Shoot
// early (slow-mo, lean-in) and at the crown beat, then the winner card.
if (await waitFor("Next round in", 140)) {
  await sleep(500);
  await shot("finale_slowmo.png");
  await sleep(1600);
  await shot("finale_crown.png");
  await sleep(1500);
  await shot("winner_card.png");
} else {
  console.log("  ! round never ended while watching");
}

ws.close();
edge.kill();
console.log("  done");
process.exit(0);
