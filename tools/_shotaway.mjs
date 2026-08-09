import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";
const OUT = process.argv[2], CDP = 9231, APP = "http://localhost:4188/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(OUT, { recursive: true });
const edge = spawn(EDGE, ["--headless=new","--disable-gpu","--no-first-run",`--remote-debugging-port=${CDP}`,
  `--user-data-dir=${process.env.TEMP}\zinc-away-${Date.now()}`,"--window-size=1280,900","about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let list=null; for(let i=0;i<60&&!list;i++){try{list=await(await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()}catch{await sleep(250)}}
const ws=new WebSocket(list.find(t=>t.type==="page").webSocketDebuggerUrl,{maxPayload:64*1024*1024});
await new Promise((r,j)=>((ws.onopen=r),(ws.onerror=j)));
let seq=0; const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}};
const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,m=>m.error?rej(new Error(method+": "+JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id,method,params}))});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true})).result?.value;
const shot=async n=>{const r=await send("Page.captureScreenshot",{format:"png"});writeFileSync(`${OUT}/${n}`,Buffer.from(r.data,"base64"));console.log("shot "+n)};
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate",{url:APP}); await sleep(1500);
await ev(`localStorage.setItem("zinc.introSeen","1")`);
await send("Page.navigate",{url:APP}); await sleep(2500);
// Build rev-share weight: bond into a few rounds so the save carries tickets.
for (let round=0; round<3; round++){
  for(let i=0;i<40;i++){
    const r=await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>/^Bond (in|another)/.test(x.textContent.trim()));if(!b||b.disabled)return"no";b.click();return"bonded"})()`);
    if(r==="bonded") break; await sleep(500);
  }
  for(let i=0;i<80;i++){ if(await ev(`document.body.innerText.includes("Next round in")`)) break; await sleep(500); }
  await sleep(1500);
}
console.log("save present:", await ev(`!!localStorage.getItem("zinc.save.v1")`));
// Rewind the save clock an hour and reload: that is the whole trick.
console.log("rewind:", await ev(`(()=>{const k="zinc.save.v1";const s=JSON.parse(localStorage.getItem(k));s.at=Date.now()-3600e3;localStorage.setItem(k,JSON.stringify(s));return "at rewound 1h"})()`));
await send("Page.navigate",{url:APP}); await sleep(3000);
console.log("recap on screen:", await ev(`document.body.innerText.toLowerCase().includes("while you were away")`));
await shot("away_recap.png");
await sleep(1500); await shot("away_recap_settled.png");
ws.close(); edge.kill(); process.exit(0);
