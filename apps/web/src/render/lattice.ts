import { CellAtlas, hexPath, type CellState } from "./cells";
import { TILE_TURN, TileAtlas, tileVersion, type TileName } from "./tiles";
import { riskScale } from "@/game/risk";
import { charImage } from "@/game/chars";
import { crtOn } from "@/ui/fx";
import { sfxStatic } from "@/audio/sound";

export interface CellInput {
  id: number;
  state: CellState;
  you?: boolean;
  hue?: number;
  group?: string;
  multiple?: number;
  charId?: string;
}

export interface ChatPopMsg {
  id: number;
  name: string;
  charId: string;
  text: string;
  at: number;
  system?: boolean;
}

export interface LatticeSnapshot {
  cells: CellInput[];
  hazard: number;
  grace: boolean;
  phase: "lobby" | "live" | "result";
  youOutcome: "out" | "in" | "cashed" | "dead";
  youCharId: string;
  chat: ChatPopMsg[];
}

interface Cell {
  id: number;
  x: number;
  y: number;
  state: CellState;
  t: number;
  seed: number;
  born: number;
  hue?: number;
  multiple?: number;
  group?: string;
  charId?: string;
}

interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  size: number;
  life: number;
  maxLife: number;
  kind: "ore" | "value";
}

const COLD = [115, 180, 220] as const;
const WARM = [150, 110, 235] as const;
const HOT = [255, 45, 111] as const;

function lerp3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
}

function seamColor(t: number): [number, number, number] {
  return t < 0.5 ? lerp3(COLD, WARM, t / 0.5) : lerp3(WARM, HOT, (t - 0.5) / 0.5);
}

export class LatticeRenderer {
  private ctx: CanvasRenderingContext2D;
  private atlas: CellAtlas | null = null;
  private tiles: TileAtlas | null = null;
  private cells = new Map<number, Cell>();
  private shards: Shard[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private time = 0;
  private heat = 0;
  private heatTarget = 0;
  private stressS = 0;
  private stressTarget = 0;
  private frost = 0;
  private shake = 0;
  private raf = 0;
  private last = 0;
  private snap: LatticeSnapshot = {
    cells: [],
    hazard: 0,
    grace: false,
    phase: "lobby",
    youOutcome: "out",
    youCharId: "",
    chat: [],
  };
  private pops: { group: string; charId: string; text: string; shownAt: number }[] = [];
  private lastChatId = -1;
  private youWas: LatticeSnapshot["youOutcome"] = "out";
  private finaleT = -1;
  private finaleQuiet = false;
  private keepIds = new Set<number>();
  private crownBearer: number | null = null;
  private sealIds = new Set<number>();
  private sealBearer = new Map<string, number>();
  private focus = { x: 0, y: 0 };

  private fxBuf: HTMLCanvasElement | null = null;
  private glitch = 0;
  private roll = -1;
  private strayIn = 4;
  private readonly calmSignal =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  private hit = 0;
  private hitKind: "dead" | "cashed" = "dead";
  private layoutKey = "";
  private radius = 20;
  private bounds = { x: 0, y: 0, w: 0, h: 0 };
  private sink = { x: 0.5, y: 0.13 };
  private grain: HTMLCanvasElement | null = null;
  private grainPattern: CanvasPattern | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.resize();
  }

  private rockG: CanvasGradient | null = null;
  private keyG: CanvasGradient | null = null;
  private atmosG: CanvasGradient | null = null;

  resize(box?: { width: number; height: number }): void {
    const w = box?.width ?? this.canvas.clientWidth;
    const h = box?.height ?? this.canvas.clientHeight;
    if (w < 8 || h < 8) return;
    const rect = { width: w, height: h };
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.ceil(this.w * this.dpr);
    this.canvas.height = Math.ceil(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.layoutKey = "";
    this.rockG = null;
    this.keyG = null;
    this.atmosG = null;
    if (this.snap.cells.length > 0) this.layout(this.snap.cells);
  }

  setSinkPoint(x: number, y: number): void {
    this.sink = { x, y };
  }

  private glow: HTMLCanvasElement | null = null;

  private glowSprite(): HTMLCanvasElement {
    if (this.glow) return this.glow;
    const size = 64;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,120,170,1)");
    grad.addColorStop(1, "rgba(255,45,111,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    this.glow = c;
    return c;
  }

  private buildGrain(): HTMLCanvasElement {
    const size = 180;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 36;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 12;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  hitTest(px: number, py: number): number | null {
    let best: number | null = null;
    let bestD = this.radius * this.radius * 1.25;
    for (const c of this.cells.values()) {
      const dx = px - c.x;
      const dy = py - c.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  }

  update(snap: LatticeSnapshot): void {
    const wasPhase = this.snap.phase;
    this.snap = snap;
    this.heatTarget =
      snap.grace || snap.phase !== "live" ? 0.05 : riskScale(snap.hazard);
    this.stressTarget = snap.grace || snap.phase !== "live" ? 0 : riskScale(snap.hazard);

    let sig = 0;
    for (const c of snap.cells) sig = (sig * 31 + c.id) >>> 0;
    const key = `${snap.cells.length}:${sig}:${this.w | 0}:${this.h | 0}`;
    const relayout = key !== this.layoutKey;
    if (relayout) {
      this.layout(snap.cells);
      this.layoutKey = key;
    }

    if (snap.youOutcome !== this.youWas) {
      if (this.youWas === "in" && (snap.youOutcome === "dead" || snap.youOutcome === "cashed")) {
        this.hit = 1;
        this.hitKind = snap.youOutcome;
        if (snap.youOutcome === "dead" && crtOn()) {
          this.glitch = 1;
          this.roll = 0;
          if (!this.calmSignal) sfxStatic(1);
        }
      }
      this.youWas = snap.youOutcome;
    }

    if (snap.phase === "lobby" && this.finaleT >= 0) {
      this.finaleT = -1;
      this.finaleQuiet = false;
      this.keepIds.clear();
      this.crownBearer = null;
    }

    const owners = new Set<string>();
    for (const c of snap.cells)
      if (c.state === "live" || c.state === "you") owners.add(c.group ?? `#${c.id}`);
    const finale = owners.size <= 1;

    let deaths = 0;
    for (const input of snap.cells) {
      const cell = this.cells.get(input.id);
      if (!cell) continue;
      cell.hue = input.hue;
      cell.multiple = input.multiple;
      cell.group = input.group;
      cell.charId = input.charId;
      if (cell.state === input.state) continue;
      cell.state = input.state;
      cell.t = 0;
      if (input.state === "dying") {
        deaths++;
        this.fracture(cell, finale ? 2 : 1);
        if (finale) this.focus = { x: cell.x, y: cell.y };
      } else if (input.state === "cashed") {
        this.release(cell);
      }
    }
    if (deaths > 0) {
      this.shake = finale
        ? 1.5
        : Math.min(1, this.shake + 0.14 + deaths * 0.04);
      if (crtOn()) {
        this.glitch = Math.min(1, this.glitch + 0.4 + deaths * 0.12);
        if (!this.calmSignal) sfxStatic(Math.min(0.55, 0.3 + deaths * 0.05));
      }
    }

    if (deaths > 0 && finale && this.finaleT < 0) {
      this.finaleT = 0;
      this.finaleQuiet = false;
      this.keepIds.clear();
      this.crownBearer = null;
      let cx = 0;
      let cy = 0;
      for (const c of snap.cells)
        if (c.state === "live" || c.state === "you") {
          this.keepIds.add(c.id);
          const cell = this.cells.get(c.id);
          if (cell) {
            cx += cell.x;
            cy += cell.y;
          }
        }
      if (this.keepIds.size > 0) {
        cx /= this.keepIds.size;
        cy /= this.keepIds.size;
        let bd = Infinity;
        for (const id of this.keepIds) {
          const cell = this.cells.get(id);
          if (!cell) continue;
          const d = (cell.x - cx) ** 2 + (cell.y - cy) ** 2;
          if (d < bd) {
            bd = d;
            this.crownBearer = id;
          }
        }
      }
    }

    if (wasPhase === "live" && snap.phase === "result" && this.finaleT < 0) {
      this.finaleT = 0;
      this.finaleQuiet = true;
      this.keepIds.clear();
      this.crownBearer = null;
      const standingOwners = new Set<string>();
      for (const c of snap.cells)
        if (c.state === "live" || c.state === "you")
          standingOwners.add(c.group ?? `#${c.id}`);
      if (standingOwners.size === 1) {
        let cx = 0;
        let cy = 0;
        for (const c of snap.cells)
          if (c.state === "live" || c.state === "you") {
            this.keepIds.add(c.id);
            const cell = this.cells.get(c.id);
            if (cell) {
              cx += cell.x;
              cy += cell.y;
            }
          }
        cx /= this.keepIds.size;
        cy /= this.keepIds.size;
        let bd = Infinity;
        for (const id of this.keepIds) {
          const cell = this.cells.get(id);
          if (!cell) continue;
          const d = (cell.x - cx) ** 2 + (cell.y - cy) ** 2;
          if (d < bd) {
            bd = d;
            this.crownBearer = id;
          }
        }
      }
    }

    this.sealIds.clear();
    const clusters = new Map<string, Cell[]>();
    for (const c of this.cells.values()) {
      if (c.state === "dying" || c.state === "you" || c.charId === undefined) continue;
      const key = c.group ?? `#${c.id}`;
      let arr = clusters.get(key);
      if (!arr) clusters.set(key, (arr = []));
      arr.push(c);
    }
    for (const [key, arr] of clusters) {
      const held = this.sealBearer.get(key);
      if (held !== undefined && arr.some((c) => c.id === held)) {
        this.sealIds.add(held);
        continue;
      }
      let cx = 0;
      let cy = 0;
      for (const c of arr) {
        cx += c.x;
        cy += c.y;
      }
      cx /= arr.length;
      cy /= arr.length;
      let best = arr[0]!;
      let bd = Infinity;
      for (const c of arr) {
        const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      this.sealBearer.set(key, best.id);
      this.sealIds.add(best.id);
    }
    for (const key of this.sealBearer.keys())
      if (!clusters.has(key)) this.sealBearer.delete(key);

    if (this.lastChatId < 0) {
      this.lastChatId = 0;
      for (const m of snap.chat) if (m.id > this.lastChatId) this.lastChatId = m.id;
    } else {
      const now = Date.now();
      for (const m of snap.chat) {
        if (m.id <= this.lastChatId) continue;
        this.lastChatId = m.id;
        if (m.system || Math.abs(now - m.at) > 6000) continue;
        this.pops = this.pops.filter((p) => p.group !== m.name);
        this.pops.push({ group: m.name, charId: m.charId, text: m.text, shownAt: now });
        if (this.pops.length > 4) this.pops.shift();
      }
    }
  }

  private layout(inputs: CellInput[]): void {
    const n = inputs.length;
    if (n === 0) {
      this.cells.clear();
      return;
    }

    const padX = this.w * 0.045;
    const top = this.h * 0.03;
    const bottom = this.h * 0.05;
    const availW = this.w - padX * 2;
    const availH = Math.max(40, this.h - top - bottom);

    const hexH = Math.sqrt(3);
    let r = Math.sqrt((availW * availH) / (2.6 * n));
    const fillShare = n <= 4 ? 0.34 : n <= 9 ? 0.28 : n <= 16 ? 0.22 : 0.18;
    const roomy = Math.max(70, Math.min(availW, availH) * fillShare);
    r = Math.min(r, roomy, availW / 2.4, availH / (hexH * 1.6));
    let cols = 0;
    let rows = 0;
    for (let guard = 0; guard < 400; guard++) {
      cols = Math.max(1, Math.floor((availW - r * 0.5) / (r * 1.5)));
      rows = Math.max(1, Math.floor((availH - (r * hexH) / 2) / (r * hexH)));
      if (cols * rows >= n || r <= 1.5) break;
      r *= 0.95;
    }
    r = Math.max(1.5, r);
    this.radius = r;
    this.atlas = new CellAtlas(r, this.dpr);
    this.tiles = new TileAtlas(r, this.dpr);

    const aspect = (availW * hexH) / (availH * 1.5);
    let usedRows = Math.max(
      1,
      Math.min(rows, Math.round(Math.sqrt(n / Math.max(0.1, aspect)))),
    );
    let usedCols = Math.ceil(n / usedRows);
    if (usedCols > cols) {
      usedCols = cols;
      usedRows = Math.min(rows, Math.ceil(n / usedCols));
    }

    const gridW = usedCols * r * 1.5 + r * 0.5;
    const gridH = usedRows * r * hexH + (r * hexH) / 2;
    const startX = (this.w - gridW) / 2 + r;
    const startY = top + (availH - gridH) / 2 + (r * hexH) / 2;

    this.bounds = { x: startX - r * 1.2, y: startY - r, w: gridW + r * 0.4, h: gridH + r };

    const slots: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const col = Math.floor(i / usedRows);
      const row = i % usedRows;
      slots.push({
        x: startX + col * r * 1.5,
        y: startY + row * r * hexH + (col % 2 ? (r * hexH) / 2 : 0),
      });
    }

    const cx = slots.reduce((a, s) => a + s.x, 0) / n;
    const cy = slots.reduce((a, s) => a + s.y, 0) / n;
    const YOU_KEY = "<you>";
    const groupsMap = new Map<string, CellInput[]>();
    for (const input of inputs) {
      const key = input.you ? YOU_KEY : (input.group ?? `solo:${input.id}`);
      const members = groupsMap.get(key);
      if (members) members.push(input);
      else groupsMap.set(key, [input]);
    }
    const groups = [...groupsMap.entries()].sort((a, b) => {
      if ((a[0] === YOU_KEY) !== (b[0] === YOU_KEY)) return a[0] === YOU_KEY ? -1 : 1;
      if (a[1].length !== b[1].length) return b[1].length - a[1].length;
      return a[0] < b[0] ? -1 : 1;
    });

    const adj: number[][] = slots.map(() => []);
    const adjLimit = 3.2 * r * r;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const dx = slots[a]!.x - slots[b]!.x;
        const dy = slots[a]!.y - slots[b]!.y;
        if (dx * dx + dy * dy <= adjLimit) {
          adj[a]!.push(b);
          adj[b]!.push(a);
        }
      }
    }

    const unassigned = new Set<number>(slots.map((_, i) => i));
    const slotOfCell = new Map<number, number>();

    const components = (): number[][] => {
      const seen = new Set<number>();
      const out: number[][] = [];
      for (const s of unassigned) {
        if (seen.has(s)) continue;
        const comp: number[] = [];
        const stack = [s];
        seen.add(s);
        while (stack.length > 0) {
          const c = stack.pop()!;
          comp.push(c);
          for (const nb of adj[c]!) {
            if (unassigned.has(nb) && !seen.has(nb)) {
              seen.add(nb);
              stack.push(nb);
            }
          }
        }
        out.push(comp);
      }
      return out;
    };

    for (const [key, members] of groups) {
      members.sort((a, b) => a.id - b.id);
      let need = members.length;
      let mi = 0;
      const first = unassigned.values().next().value;
      if (first === undefined) break;
      const anchor = key === YOU_KEY ? { x: cx, y: cy } : slots[first]!;
      while (need > 0 && unassigned.size > 0) {
        const comps = components();
        const fitting = comps.filter((c) => c.length >= need);
        const pool =
          fitting.length > 0
            ? fitting
            : [[...comps].sort((a, b) => b.length - a.length)[0]!];
        let comp = pool[0]!;
        let bestCompD = Infinity;
        for (const c of pool) {
          let d = Infinity;
          for (const s of c) {
            d = Math.min(d, (slots[s]!.x - anchor.x) ** 2 + (slots[s]!.y - anchor.y) ** 2);
          }
          if (d < bestCompD) {
            bestCompD = d;
            comp = c;
          }
        }
        const compSet = new Set(comp);

        const stillConnected = (removed: number): boolean => {
          let start = -1;
          for (const v of compSet) {
            if (v !== removed) {
              start = v;
              break;
            }
          }
          if (start < 0) return true;
          const seen = new Set([start]);
          const stack = [start];
          while (stack.length > 0) {
            const c = stack.pop()!;
            for (const nb of adj[c]!) {
              if (compSet.has(nb) && nb !== removed && !seen.has(nb)) {
                seen.add(nb);
                stack.push(nb);
              }
            }
          }
          return seen.size === compSet.size - 1;
        };

        const claim = (ranked: number[]): number => {
          const pick = ranked.find((s) => stillConnected(s)) ?? ranked[0]!;
          compSet.delete(pick);
          unassigned.delete(pick);
          return pick;
        };

        const byAnchor = [...compSet].sort(
          (a, b) =>
            (slots[a]!.x - anchor.x) ** 2 +
              (slots[a]!.y - anchor.y) ** 2 -
              ((slots[b]!.x - anchor.x) ** 2 + (slots[b]!.y - anchor.y) ** 2) || a - b,
        );
        const blob: number[] = [claim(byAnchor)];
        while (blob.length < Math.min(need, comp.length)) {
          const touch = (s: number): number => {
            let t = 0;
            for (const m of blob) if (adj[s]!.includes(m)) t++;
            return t;
          };
          const frontier = [...compSet]
            .filter((s) => touch(s) > 0)
            .sort((a, b) => touch(b) - touch(a) || a - b);
          if (frontier.length === 0) break;
          blob.push(claim(frontier));
        }
        for (const s of blob) slotOfCell.set(members[mi++]!.id, s);
        need -= blob.length;
      }
    }

    const kept = new Map<number, Cell>();
    for (const input of inputs) {
      const { x, y } = slots[slotOfCell.get(input.id)!]!;
      const prev = this.cells.get(input.id);
      kept.set(input.id, {
        id: input.id,
        x,
        y,
        state: prev?.state ?? input.state,
        t: prev?.t ?? 0,
        seed: ((input.id * 2654435761) >>> 0) / 4294967296,
        born: prev?.born ?? 0,
        hue: input.hue,
        multiple: input.multiple,
        group: input.group,
        charId: input.charId,
      });
    }
    this.cells = kept;
  }

  private fracture(cell: Cell, boost = 1): void {
    const r = this.radius;
    for (let i = 0; i < 7 * boost; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (40 + Math.random() * 130) * (boost > 1 ? 1.4 : 1);
      this.shards.push({
        x: cell.x,
        y: cell.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 30,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 9,
        size: r * (0.16 + Math.random() * 0.3),
        life: 0,
        maxLife: (0.7 + Math.random() * 0.5) * (boost > 1 ? 1.3 : 1),
        kind: i % 7 < 4 ? "value" : "ore",
      });
    }
  }

  private release(cell: Cell): void {
    const r = this.radius;
    for (let i = 0; i < 3; i++) {
      this.shards.push({
        x: cell.x + (Math.random() - 0.5) * r,
        y: cell.y,
        vx: (Math.random() - 0.5) * 25,
        vy: -50 - Math.random() * 40,
        rot: 0,
        vrot: (Math.random() - 0.5) * 2,
        size: r * 0.14,
        life: 0,
        maxLife: 0.8,
        kind: "ore",
      });
    }
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(dt: number): void {
    let timescale = 1;
    if (this.finaleT >= 0) {
      this.finaleT += dt;
      if (!this.finaleQuiet) {
        const f = this.finaleT;
        timescale = f < 1.4 ? 0.22 : f < 1.9 ? 0.22 + ((f - 1.4) / 0.5) * 0.78 : 1;
      }
    }
    const sdt = dt * timescale;

    this.time += sdt;
    this.heat += (this.heatTarget - this.heat) * Math.min(1, sdt * 3.5);
    this.stressS += (this.stressTarget - this.stressS) * Math.min(1, sdt * 4.5);
    const frostTarget = this.snap.phase === "live" && this.snap.grace ? 1 : 0;
    this.frost += (frostTarget - this.frost) * Math.min(1, sdt * (frostTarget > this.frost ? 3.2 : 1.6));
    this.shake *= Math.pow(0.002, sdt);
    if (this.hit > 0) this.hit = Math.max(0, this.hit - sdt / 1.1);

    if (crtOn()) {
      this.strayIn -= dt;
      if (this.strayIn <= 0) {
        this.glitch = Math.max(this.glitch, 0.28 + this.heat * 0.25);
        if (!this.calmSignal) sfxStatic(0.2 + this.heat * 0.3);
        this.strayIn = 3 + Math.random() * (9 - this.heat * 5);
      }
    }
    if (this.glitch > 0) this.glitch = Math.max(0, this.glitch - dt * 2.4);
    if (this.roll >= 0) {
      this.roll += dt * 2.2;
      if (this.roll >= 1) this.roll = -1;
    }

    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0.01) {
      const s = this.shake * 4.5;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    if (this.finaleT >= 0 && !this.finaleQuiet) {
      const f = this.finaleT;
      const zin = 1 - Math.pow(1 - Math.min(1, f / 0.35), 3);
      const zout = f < 1.9 ? 1 : Math.max(0, 1 - (f - 1.9) / 0.8);
      const z = 1 + 0.19 * zin * zout;
      if (z > 1.001) {
        ctx.translate(this.focus.x, this.focus.y);
        ctx.scale(z, z);
        ctx.translate(-this.focus.x, -this.focus.y);
      }
    }

    this.drawRock();
    this.drawSeams();
    this.drawCells(sdt);
    this.drawShards(sdt);
    this.drawAtmosphere();
    if (this.pops.length > 0) this.drawChatPops();
    if (this.finaleT >= 0 && this.crownBearer !== null) this.drawCrown();
    if (this.hit > 0) this.drawHit();
    this.drawGrain();

    ctx.restore();

    this.applySignal();
  }

  private applySignal(): void {
    if (!crtOn()) return;
    const cv = this.ctx.canvas;
    const W = cv.width;
    const H = cv.height;
    if (W === 0 || H === 0) return;
    if (!this.fxBuf || this.fxBuf.width !== W || this.fxBuf.height !== H) {
      this.fxBuf = document.createElement("canvas");
      this.fxBuf.width = W;
      this.fxBuf.height = H;
    }
    const b = this.fxBuf.getContext("2d")!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, W, H);
    b.drawImage(cv, 0, 0);

    const ctx = this.ctx;
    const g = this.calmSignal ? 0 : this.glitch;
    let yShift = 0;
    if (!this.calmSignal && this.roll >= 0) {
      const r = this.roll;
      const e = r < 0.5 ? 2 * r * r : 1 - Math.pow(-2 * r + 2, 2) / 2;
      yShift = Math.round(e * H) % H;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const bow = Math.min(14, W * 0.007);
    const bands = 24;
    const bh = Math.ceil(H / bands);
    const tbin = (this.time * 14) | 0;
    for (let i = 0; i < bands; i++) {
      const y = i * bh;
      const h = Math.min(bh, H - y);
      if (h <= 0) break;
      const v = ((y + h / 2) / H) * 2 - 1;
      const s = 1 + ((bow * 2) / W) * (1 - v * v);
      let dx = (W - W * s) / 2;
      if (g > 0.03 && LatticeRenderer.rnd(i * 7.31 + tbin * 0.173) < g * 0.4) {
        dx += (LatticeRenderer.rnd(i * 3.17 + tbin * 0.31) - 0.5) * g * W * 0.035;
      }
      const sy = (y + yShift) % H;
      const first = Math.min(h, H - sy);
      ctx.drawImage(this.fxBuf, 0, sy, W, first, dx, y, W * s, first);
      if (first < h) {
        ctx.drawImage(this.fxBuf, 0, 0, W, h - first, dx, y + first, W * s, h - first);
      }
    }
    if (g > 0.45) {
      ctx.globalAlpha = 0.14 * g;
      ctx.drawImage(this.fxBuf, g * W * 0.012, 0);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawChatPops(): void {
    const now = Date.now();
    this.pops = this.pops.filter((p) => now - p.shownAt < 2600);
    const { ctx } = this;
    const r = this.radius;
    for (const p of this.pops) {
      let sx = 0;
      let n = 0;
      let top = Infinity;
      for (const c of this.cells.values()) {
        if (c.group !== p.group || c.state === "dying") continue;
        sx += c.x;
        n++;
        if (c.y < top) top = c.y;
      }
      if (n === 0) continue;

      const k = (now - p.shownAt) / 2600;
      const fade = k < 0.08 ? k / 0.08 : k > 0.82 ? (1 - k) / 0.18 : 1;
      const text = p.text.length > 26 ? `${p.text.slice(0, 25)}…` : p.text;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.font = '600 11px "Chakra Petch", ui-sans-serif, system-ui, sans-serif';
      const head = 18;
      const padX = 6;
      const gap = 5;
      const bw = padX * 2 + head + gap + ctx.measureText(text).width;
      const bh = 26;
      const bx = Math.max(6, Math.min(this.w - bw - 6, sx / n - bw / 2));
      let by = top - r * 1.5 - bh - k * 5;
      if (by < 4) by = top + r * 1.45 + 8 + k * 5;

      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fillStyle = "rgba(9, 15, 21, 0.92)";
      ctx.fill();
      ctx.strokeStyle = "rgba(140, 200, 226, 0.28)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const face = charImage(p.charId, "head");
      if (face) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(face, bx + padX, by + (bh - head) / 2, head, head);
        ctx.imageSmoothingEnabled = true;
      }
      ctx.fillStyle = "#d4e8f4";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, bx + padX + head + gap, by + bh / 2 + 0.5);
      ctx.restore();
    }
  }

  private drawCrown(): void {
    const t = this.finaleT - (this.finaleQuiet ? 0.8 : 1.45);
    if (t < 0) return;
    const { ctx } = this;
    const r = this.radius;
    const halo = Math.min(1, t / 0.5);
    const breathe = 0.85 + 0.15 * Math.sin(t * 3.2);

    ctx.save();
    for (const id of this.keepIds) {
      const kc = this.cells.get(id);
      if (!kc) continue;
      const g = ctx.createRadialGradient(kc.x, kc.y, r * 0.2, kc.x, kc.y, r * 3.6);
      g.addColorStop(0, `rgba(255, 205, 110, ${0.38 * halo * breathe})`);
      g.addColorStop(1, "rgba(255, 205, 110, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(kc.x - r * 3.6, kc.y - r * 3.6, r * 7.2, r * 7.2);
    }
    ctx.restore();
  }

  private drawHit(): void {
    const { ctx, w, h } = this;
    const k = this.hit;
    const punch = k > 0.82 ? (k - 0.82) / 0.18 : 0;
    const body = Math.pow(k, 1.6);
    const rgb = this.hitKind === "dead" ? "255, 45, 111" : "63, 232, 192";

    const g = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.15,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72,
    );
    g.addColorStop(0, `rgba(${rgb}, 0)`);
    g.addColorStop(1, `rgba(${rgb}, ${0.46 * body})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    if (punch > 0) {
      ctx.fillStyle = `rgba(${rgb}, ${0.16 * punch})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private drawGrain(): void {
    const { ctx, w, h } = this;
    if (!this.grainPattern) {
      if (!this.grain) this.grain = this.buildGrain();
      this.grainPattern = ctx.createPattern(this.grain, "repeat");
    }
    if (!this.grainPattern) return;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  private drawRock(): void {
    const { ctx, w, h } = this;
    if (!this.rockG) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0a121a");
      g.addColorStop(0.5, "#112031");
      g.addColorStop(1, "#0a121a");
      this.rockG = g;
    }
    ctx.fillStyle = this.rockG;
    ctx.fillRect(0, 0, w, h);

    if (!this.keyG) {
      const key = ctx.createRadialGradient(w / 2, -h * 0.1, 0, w / 2, -h * 0.1, h * 0.95);
      key.addColorStop(0, "rgba(120,170,205,0.10)");
      key.addColorStop(0.55, "rgba(90,140,180,0.035)");
      key.addColorStop(1, "rgba(60,110,150,0)");
      this.keyG = key;
    }
    ctx.fillStyle = this.keyG;
    ctx.fillRect(0, 0, w, h);
  }

  private drawSeams(): void {
    const { ctx } = this;
    const b = this.bounds;
    if (b.w <= 0) return;
    const [r, g, bl] = seamColor(this.heat);
    const pulse = 0.82 + Math.sin(this.time * 2.1) * 0.06 + this.heat * 0.3;

    ctx.save();
    const midX = b.x + b.w / 2;
    const midY = b.y + b.h / 2;
    const reach = Math.max(b.w, b.h) * 0.72;
    const grad = ctx.createRadialGradient(midX, midY, 0, midX, midY, reach);
    const a = (0.16 + this.heat * 0.7) * pulse;
    grad.addColorStop(0, `rgba(${r | 0},${g | 0},${bl | 0},${a})`);
    grad.addColorStop(1, `rgba(${r | 0},${g | 0},${bl | 0},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(midX - reach, midY - reach, reach * 2, reach * 2);

    if (this.heat > 0.4) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (this.heat - 0.4) * 0.55;
      ctx.fillStyle = grad;
      ctx.fillRect(midX - reach, midY - reach, reach * 2, reach * 2);
    }
    ctx.restore();
  }

  private static rnd(s: number): number {
    const x = Math.sin(s * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  private drawStress(c: Cell, k: number, jx: number, jy: number): void {
    const { ctx } = this;
    const r = this.radius;
    const R = LatticeRenderer.rnd;

    ctx.save();
    ctx.strokeStyle = "#eaf6ff";
    ctx.lineWidth = Math.max(0.6, r * 0.06);
    ctx.lineCap = "round";
    ctx.globalAlpha = Math.min(1, k * 6) * (0.24 + 0.55 * k);
    const grow = 0.5 + 0.5 * k;
    const arms = 2 + (k > 0.4 ? 1 : 0) + (k > 0.75 ? 1 : 0);
    for (let arm = 0; arm < arms; arm++) {
      const a0 = R(c.seed * 31.7 + arm * 7.3) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c.x + jx + Math.cos(a0) * r * 0.85, c.y + jy + Math.sin(a0) * r * 0.85);
      const steps = 3;
      for (let s = 1; s <= steps; s++) {
        const frac = (s / steps) * grow;
        const jag = (R(c.seed * 13.1 + arm * 5.9 + s) - 0.5) * r * 0.45;
        const px = c.x + jx + Math.cos(a0) * r * 0.85 * (1 - frac) - Math.sin(a0) * jag;
        const py = c.y + jy + Math.sin(a0) * r * 0.85 * (1 - frac) + Math.cos(a0) * jag;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTileFace(
    c: Cell,
    tiles: TileAtlas,
    stress: number,
    alpha: number,
    scale: number,
    jx: number,
    jy: number,
  ): void {
    const { ctx } = this;
    const dw = tiles.w * scale;
    const dh = tiles.h * scale;
    const x = c.x - dw / 2 + jx;
    const y = c.y - dh / 2 + jy;
    const R = LatticeRenderer.rnd;
    const turn = Math.floor(R(c.seed * 5.31) * 6) * TILE_TURN;
    const tone = 0.94 + R(c.seed * 2.77) * 0.06;

    ctx.save();
    ctx.translate(c.x + jx, c.y + jy);
    ctx.rotate(turn);
    ctx.translate(-(c.x + jx), -(c.y + jy));

    const blit = (name: TileName, a: number): void => {
      const img = tiles.get(name);
      if (!img || a <= 0.01) return;
      ctx.globalAlpha = alpha * a * tone;
      ctx.drawImage(img, x, y, dw, dh);
    };

    if (c.state === "dying") {
      blit("crack", 1);
    } else {
      const t = stress * 2;
      const step = Math.min(1, Math.floor(t));
      blit(step === 0 ? "base" : "hairline", 1);
      blit(step === 0 ? "hairline" : "heavy", t - step);
    }
    ctx.restore();

    if (c.state === "you") {
      const pulse = 0.68 + 0.32 * Math.sin(this.time * 4.2);
      ctx.save();
      ctx.globalAlpha = alpha;
      hexPath(ctx, c.x + jx, c.y + jy, this.radius * scale * 0.97);
      ctx.fillStyle = `rgba(63, 224, 216, ${0.13 + 0.07 * pulse})`;
      ctx.fill();
      ctx.strokeStyle = "#3fe0d8";
      ctx.shadowColor = "#3fe0d8";
      ctx.shadowBlur = this.radius * 0.55 * pulse;
      ctx.lineWidth = Math.max(1.5, this.radius * 0.1);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = alpha;
  }

  private drawCells(dt: number): void {
    const { ctx } = this;
    const atlas = this.atlas;
    if (!atlas) return;
    if (this.tiles && this.tiles.version !== tileVersion && this.radius > 0) {
      this.tiles = new TileAtlas(this.radius, this.dpr);
    }
    const tiles = this.tiles?.usable ? this.tiles : null;

    const stress = Math.max(0, Math.min(1, (this.stressS - 0.35) / 0.65));
    const b = this.bounds;
    const midX = b.x + b.w / 2;
    const midY = b.y + b.h / 2;
    const span = Math.max(b.w, b.h) * 0.6 || 1;

    const sealDraws: { charId: string; x: number; y: number; scale: number; alpha: number }[] =
      [];

    for (const c of this.cells.values()) {
      c.t += dt;
      if (c.born < 1) c.born = Math.min(1, c.born + dt * 4);

      let alpha = 1;
      let scale = 1;
      let dy = 0;

      if (c.born < 1) {
        const k = c.born;
        alpha = k;
        scale = 0.55 + 0.45 * (1 - Math.pow(1 - k, 3));
      }

      const inPlay = c.state === "live" || c.state === "you";

      if (c.state === "dying") {
        const k = Math.max(0, Math.min(1, (c.t - 0.2) / 0.45));
        alpha *= 1 - k;
        scale *= 1 - k * 0.3;
        if (k >= 1) continue;
      } else if (c.state === "cashed") {
        const k = Math.min(1, c.t / 0.55);
        const fade = this.snap.phase === "result" ? 0.9 : 0.45;
        alpha *= 1 - k * fade;
        dy = -k * 3;
      } else if (c.state === "you") {
        scale *= 1 + Math.sin(this.time * 3 + c.seed * 6) * 0.018;
      }

      if (alpha <= 0.02) continue;

      let jx = 0;
      let jy = 0;
      if (stress > 0.02 && inPlay) {
        jx = Math.sin(this.time * 13 + c.seed * 43) * 1.2 * stress;
        jy = Math.cos(this.time * 11.3 + c.seed * 31) * 1.2 * stress;
      }

      if (this.finaleT >= 0 && !this.keepIds.has(c.id)) {
        const fs = this.finaleQuiet ? 0.15 : 1.0;
        const fe = this.finaleQuiet ? 0.75 : 2.2;
        alpha *= 1 - Math.min(1, Math.max(0, (this.finaleT - fs) / (fe - fs)));
        if (alpha <= 0.01) continue;
      }

      const sprite = atlas.get(c.state);
      ctx.globalAlpha = alpha;
      const dw = sprite.w * scale;
      const dh = sprite.h * scale;
      ctx.drawImage(sprite.canvas, c.x - dw / 2 + jx, c.y - dh / 2 + jy + dy, dw, dh);

      if (tiles && c.state !== "cashed") {
        this.drawTileFace(c, tiles, stress, alpha, scale, jx, jy + dy);
      } else if (tiles) {
        const ghost = tiles.get("base");
        if (ghost) {
          ctx.globalAlpha = alpha * 0.26;
          ctx.drawImage(
            ghost,
            c.x - (tiles.w * scale) / 2 + jx,
            c.y - (tiles.h * scale) / 2 + jy + dy,
            tiles.w * scale,
            tiles.h * scale,
          );
          ctx.globalAlpha = alpha;
        }
      }

      if (c.state === "you" && this.radius > 7) {
        const face = charImage(this.snap.youCharId, "head");
        if (face) {
          const side = this.radius * 1.16 * scale;
          ctx.save();
          ctx.globalAlpha = alpha * 0.95;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(face, c.x - side / 2 + jx, c.y - side / 2 + jy + dy, side, side);
          ctx.restore();
          ctx.globalAlpha = alpha;
        }
      }

      if (c.charId !== undefined && this.sealIds.has(c.id) && this.radius > 13) {
        sealDraws.push({
          charId: c.charId,
          x: c.x + jx,
          y: c.y + jy + dy,
          scale,
          alpha: alpha * (c.state === "cashed" ? 0.43 : 0.8),
        });
      }

      if (c.state === "cashed") {
        ctx.save();
        ctx.globalAlpha = alpha;
        hexPath(ctx, c.x + jx, c.y + jy + dy, this.radius * scale * 0.94);
        ctx.fillStyle = "rgba(255, 205, 110, 0.09)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 211, 107, 0.55)";
        ctx.lineWidth = Math.max(1, this.radius * 0.06);
        ctx.stroke();
        if (c.multiple !== undefined && this.radius > 8) {
          ctx.font = `600 ${Math.max(9, Math.round(this.radius * 0.42))}px "IBM Plex Mono", ui-monospace, monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#ffd36b";
          ctx.fillText(`${c.multiple.toFixed(2)}×`, c.x + jx, c.y + jy + dy);
        }
        ctx.restore();
      }

      if (c.hue !== undefined && c.state !== "cashed" && this.radius > 5) {
        hexPath(ctx, c.x + jx, c.y + jy + dy, this.radius * scale * 0.86);
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = "rgba(4, 8, 12, 0.9)";
        ctx.lineWidth = Math.max(1.5, this.radius * 0.12);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.95;
        ctx.strokeStyle = `hsl(${c.hue} 92% 58%)`;
        ctx.lineWidth = Math.max(1.2, this.radius * 0.072);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      if (this.frost > 0.02 && inPlay) {
        const dist = Math.hypot(c.x - midX, c.y - midY) / span;
        const f = Math.max(0, Math.min(1, this.frost * 1.7 - dist * 0.7));
        if (f > 0.01) {
          ctx.globalAlpha = alpha * f * 0.22;
          ctx.fillStyle = "#d8f0ff";
          hexPath(ctx, c.x + jx, c.y + jy, this.radius * 0.96);
          ctx.fill();
          ctx.globalAlpha = alpha;
        }
      }

      if (!tiles && stress > 0.03 && inPlay && this.radius > 6) {
        this.drawStress(c, stress, jx, jy);
      }

      if (c.state === "dying" && c.t < 0.26 && this.radius > 6) {
        const k = c.t / 0.26;
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.95;
        ctx.strokeStyle = "#ffd9e6";
        ctx.lineWidth = Math.max(0.7, this.radius * 0.06);
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = c.seed * 6.28 + (i * Math.PI * 2) / 3;
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(
            c.x + Math.cos(a) * this.radius * k * 1.1,
            c.y + Math.sin(a) * this.radius * k * 1.1,
          );
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    if (sealDraws.length > 0) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      for (const s of sealDraws) {
        const face = charImage(s.charId, "head");
        if (!face) continue;
        const side = this.radius * 0.55 * s.scale;
        ctx.globalAlpha = s.alpha;
        ctx.drawImage(
          face,
          s.x - side / 2,
          s.y + this.radius * 0.38 * s.scale - side / 2,
          side,
          side,
        );
      }
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  private drawShards(dt: number): void {
    const { ctx, w, h } = this;
    const sinkX = this.sink.x * w;
    const sinkY = this.sink.y * h;

    ctx.save();
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.life += dt;
      const k = s.life / s.maxLife;
      if (k >= 1) {
        this.shards.splice(i, 1);
        continue;
      }

      if (s.kind === "value") {
        const dx = sinkX - s.x;
        const dy = sinkY - s.y;
        const d = Math.hypot(dx, dy) || 1;
        const pull = 420 * Math.pow(k, 1.6);
        s.vx += (dx / d) * pull * dt;
        s.vy += (dy / d) * pull * dt;
      } else {
        s.vy += 180 * dt;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.vrot * dt;

      const a = (1 - k) * 0.95;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      if (s.kind === "value") {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a;
        const r = s.size * 3.2;
        ctx.drawImage(this.glowSprite(), -r, -r, r * 2, r * 2);
      }
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(0, -s.size);
      ctx.lineTo(s.size * 0.9, s.size * 0.7);
      ctx.lineTo(-s.size * 0.8, s.size * 0.6);
      ctx.closePath();
      ctx.fillStyle = s.kind === "value" ? "#ff9dbe" : "#a9d2e6";
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawAtmosphere(): void {
    const { ctx, w, h } = this;
    if (!this.atmosG) {
      const g = ctx.createRadialGradient(
        w / 2,
        h * 0.5,
        Math.min(w, h) * 0.45,
        w / 2,
        h * 0.5,
        Math.max(w, h) * 0.86,
      );
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(2,5,9,0.42)");
      this.atmosG = g;
    }
    ctx.fillStyle = this.atmosG;
    ctx.fillRect(0, 0, w, h);
  }
}
