// Reproduces the between-rounds board corruption at phone size.
//
// The trigger in the wild: the TV power cycle puts transform:scaleY(0.004) on
// the lattice container for 700ms, and inside that window a phase change
// resizes the mobile action bar, firing the canvas ResizeObserver. Anything
// that measures with a client rect reads a two-pixel-tall board.
//
// Here the same two events are staged deliberately: apply the transform, then
// change the container's height so the observer fires, then take the transform
// off and read what the canvas committed to.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const url = process.argv[2] ?? "http://localhost:5173/";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9700 + Math.floor(Math.random() * 200);
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
  "--remote-debugging-port=" + port,
  "--user-data-dir=" + join(tmpdir(), "edge-tvbug-" + Date.now()),
  "about:blank",
], { stdio: "ignore" });

const done = (code) => { try { edge.kill(); } catch {} process.exit(code); };
setTimeout(() => { console.error("TIMEOUT"); done(3); }, 90000).unref();

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
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  screenWidth: 390, screenHeight: 844,
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try{localStorage.setItem('zinc.introSeen','1')}catch(e){}",
});
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, 9000));

const result = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const canvas = document.querySelector("canvas.cursor-pointer");
  if (!canvas) return { error: "no lattice canvas found" };
  const host = canvas.parentElement;

  const before = { w: canvas.width, h: canvas.height, cssH: Math.round(canvas.clientHeight) };

  // 1. The TV power cycle collapses the container.
  host.style.transform = "scaleY(0.004)";
  // 2. Inside that window the bottom chrome changes height, so the board's
  //    layout box changes and the observer fires.
  const originalFlex = host.style.flex;
  host.style.flex = "0 0 " + (canvas.clientHeight - 60) + "px";
  await sleep(300);
  const during = { w: canvas.width, h: canvas.height, cssH: Math.round(canvas.clientHeight) };

  // 3. The animation ends. Reverting a transform does NOT re-fire the observer.
  host.style.transform = "";
  host.style.flex = originalFlex;
  await sleep(600);
  const after = { w: canvas.width, h: canvas.height, cssH: Math.round(canvas.clientHeight) };

  return { before, during, after, dpr: window.devicePixelRatio };
})()`);

console.log(JSON.stringify(result, null, 2));
if (result.error) done(2);

// The defect is what the canvas commits to AT THE MOMENT the observer fires,
// while the collapse transform is on. Judging the end state would pass either
// way here: this harness restores the container's height, which changes the
// layout box and so fires the observer a second time. Nothing does that in the
// wild, which is exactly why the corruption used to persist for a whole round.
const { during, dpr } = result;
const ratio = during.h / Math.max(1, during.cssH * dpr);
console.log(`
backing store / layout box, during the collapse = ${ratio.toFixed(3)}  (1.000 is correct)`);
const ok = ratio > 0.9 && ratio < 1.1;
console.log(ok ? "PASS: the board measured its layout box, not the transform" 
              : `FAIL: board collapsed to ${during.h}px under a ${during.cssH}px box`);
done(ok ? 0 : 1);
