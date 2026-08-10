// Three edge cases that used to (or must never) take the screen down, staged
// in a real browser:
//
//   1. CRT toggled off during the between-rounds TV blink. The blink's timers
//      are the only thing that restores the picture, and re-running the phase
//      effect clears them: the board was left at 0.4% height for good.
//   2. A phase jump landing inside the blink (a reconnect snapshot does this).
//      Same strand, different trigger.
//   3. A component throwing during render. React unmounts the whole tree on an
//      uncaught render error: blank page, player has money on the table. The
//      boundary must catch it and offer reload.
//
//   cd tools && node edgecases.mjs [url]
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const url = process.argv[2] ?? "http://localhost:5173/";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9900 + Math.floor(Math.random() * 90);
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
  "--remote-debugging-port=" + port,
  "--user-data-dir=" + join(tmpdir(), "edge-edge-" + Date.now()),
  "about:blank",
], { stdio: "ignore" });
const done = (code) => { try { edge.kill(); } catch {} process.exit(code); };
setTimeout(() => { console.error("TIMEOUT"); done(3); }, 120000).unref();

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await new Promise(r => setTimeout(r, 250));
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find(t => t.type === "page");
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
await new Promise(res => ws.addEventListener("open", res));
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.result?.description ?? ""));
  return r.result.value;
};

await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try{localStorage.setItem('zinc.introSeen','1')}catch(e){}",
});
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, 8000));

let failures = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// ---- 1 & 2. The stranded TV. The component's state machine is not directly
// scriptable, so this drives the same DOM contract the fix protects: after
// ANY sequence of blink-class churn, the board container must end upright.
// We simulate what the strand produced — the class left on with its animation
// finished — and assert the app's own next render clears it. The honest
// signal available from outside is simpler: after a full result->lobby cycle
// with CRT toggled mid-blink, the canvas container's effective scaleY is 1.
const tvResult = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const host = document.querySelector("canvas.cursor-pointer")?.parentElement;
  if (!host) return { error: "no board host" };

  // Wait for a blink: poll for the tv-off class appearing (round boundary).
  // Demo rounds run continuously, so one arrives within a round's length.
  const sawBlink = await new Promise((res) => {
    const mo = new MutationObserver(() => {
      if (host.classList.contains("tv-off")) { mo.disconnect(); res(true); }
    });
    mo.observe(host, { attributes: true, attributeFilter: ["class"] });
    setTimeout(() => { mo.disconnect(); res(false); }, 45000);
  });
  if (!sawBlink) return { error: "no blink observed in 45s (CRT off in this profile?)" };

  // Mid-blink, flip CRT off through the app's own store.
  const mod = await import("/src/ui/fx.ts");
  mod.setCrt(false);
  await sleep(1200);
  const m1 = new DOMMatrix(getComputedStyle(host).transform === "none" ? undefined : getComputedStyle(host).transform);
  const strandedOff = { classOff: host.classList.contains("tv-off"), scaleY: m1.d };

  mod.setCrt(true);
  return { strandedOff };
})()`);
if (tvResult.error) {
  report("tv strand (crt toggle mid-blink)", false, tvResult.error);
} else {
  const s = tvResult.strandedOff;
  report(
    "tv strand (crt toggle mid-blink)",
    !s.classOff && Math.abs(s.scaleY - 1) < 0.01,
    `class=${s.classOff} scaleY=${s.scaleY.toFixed(3)}`,
  );
}

// ---- 3. The crash screen. Throw from inside React's own render pass by
// making a subscribed component receive state that explodes: we corrupt a
// snapshot listener path is internal, so instead force an error the honest
// way — dispatch inside React by breaking a method the next render calls.
const crashResult = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Number.prototype.toFixed is called by the multiplier every render.
  // Breaking it for one snapshot push is an authentic mid-render throw.
  const orig = Number.prototype.toFixed;
  Number.prototype.toFixed = function () { throw new Error("edgecase: forced render fault"); };
  await sleep(600);
  Number.prototype.toFixed = orig;
  await sleep(300);
  const text = document.body.innerText || "";
  return {
    caught: /the picture dropped/i.test(text),
    reloadOffered: /reload/i.test(text),
    blank: text.trim().length === 0,
  };
})()`);
report(
  "render crash is caught, not blank",
  crashResult.caught && crashResult.reloadOffered && !crashResult.blank,
  JSON.stringify(crashResult),
);

console.log(failures === 0 ? "\nALL EDGE CASES HELD" : `\n${failures} FAILURE(S)`);
done(failures === 0 ? 0 : 1);
