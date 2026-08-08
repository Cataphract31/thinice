import { CellAtlas, hexPath, type CellState } from "./cells";
import { TILE_TURN, TileAtlas, tileVersion, type TileName } from "./tiles";
import { riskScale } from "@/game/risk";

/**
 * The seam.
 *
 * The shaft is a hexagonal lattice of ore, one plate per player. Danger is not
 * drawn as weather sitting on top of the scene — it comes from *between* the
 * plates. As the hazard climbs, the seams behind the lattice heat from cold
 * zinc blue through violet to crimson, so the room is lit by the thing that is
 * about to kill you.
 *
 * Plates hold fixed positions for the whole round. Nothing reflows when a
 * player dies, so the lattice erodes into voids and the emptying grid is what
 * explains the multiplier climbing.
 */

export interface CellInput {
  id: number;
  state: CellState;
  /**
   * Marks the viewer's own plates, whatever their state. Ownership must ride
   * separately from `state` — a dead plate stops being state "you" but is
   * still yours, and a relayout that forgets that ejects it from your cluster.
   */
  you?: boolean;
  /**
   * Rim tint (0-360) shared by a multi-plate owner's cluster, so a stack
   * reads as one holding at a glance. Undefined = no rim (singles, and the
   * viewer's own plates, which already carry the cyan "you" treatment).
   */
  hue?: number;
  /**
   * Owner key (the wallet's display name). Cells sharing a group are laid
   * out as one contiguous blob of adjacent hexes — the layout does the
   * clustering itself, spatially, because any ordering-based scheme tears
   * groups apart at column boundaries.
   */
  group?: string;
}

export interface LatticeSnapshot {
  cells: CellInput[];
  hazard: number;
  grace: boolean;
  phase: "lobby" | "live" | "result";
  /** Timestamp the jackpot fired, or null. Drives the gold flood. */
  bonanzaAt: number | null;
  /** Your own standing. Drives the personal hit when your round ends. */
  youOutcome: "out" | "in" | "cashed" | "dead";
}

interface Cell {
  id: number;
  x: number;
  y: number;
  state: CellState;
  /** Seconds since the state last changed. */
  t: number;
  /** Per-cell phase offset so the lattice never shimmers in unison. */
  seed: number;
  /** Spawn-in progress, 0-1. */
  born: number;
  /** Owner rim tint for multi-plate clusters. See CellInput.hue. */
  hue?: number;
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
  kind: "ore" | "value" | "gold";
}

const COLD = [115, 180, 220] as const;
const WARM = [150, 110, 235] as const;
const HOT = [255, 45, 111] as const;

function lerp3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
}

/**
 * Takes the PERCEPTUAL risk scale (0-1), not a raw rate. On raw hazard the
 * seams barely moved through the 1-3% band where whole rounds are decided:
 * 3% of a 13% ceiling is a quarter of the ramp. On the log scale 1% is
 * already warming, ~2.2% is fully violet, and past 5% it runs toward
 * crimson, so the room visibly answers every step of real danger.
 */
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
  /**
   * Material stress on the perceptual risk scale, smoothed. Separate from
   * `heat` (which drives the seam glow on a linear scale) so the cracking can
   * respond across the whole band players actually see — from a hot mid-round
   * ~3% up through the endgame — instead of gating on rates that only occur
   * with two plates left.
   */
  private stressS = 0;
  private stressTarget = 0;
  /** Grace-period freeze-over, 0-1. Rises fast when grace starts, thaws slow. */
  private frost = 0;
  private shake = 0;
  private raf = 0;
  private last = 0;
  private snap: LatticeSnapshot = {
    cells: [],
    hazard: 0,
    grace: false,
    phase: "lobby",
    bonanzaAt: null,
    youOutcome: "out",
  };
  /** Your last known standing, so the moment it changes can be staged. */
  private youWas: LatticeSnapshot["youOutcome"] = "out";
  /** 1 to 0 over the beat after your own round ends. */
  private hit = 0;
  private hitKind: "dead" | "cashed" = "dead";
  private goldWave = 0;
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

  /** Static gradients rebuilt only on resize — not 240 times a second in frame(). */
  private rockG: CanvasGradient | null = null;
  private keyG: CanvasGradient | null = null;
  private atmosG: CanvasGradient | null = null;

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    // Re-read the pixel ratio here rather than trusting the one sampled at
    // construction: dragging the window to a display with a different density,
    // or zooming the browser, changes it, and a backing store rebuilt at the
    // stale ratio leaves the whole lattice blurry until a reload. Capped at 3
    // (was 2): a 4K display at 250% OS scaling reports 2.5, and rendering
    // under the cap upscales the whole scene — visibly soft on exactly the
    // screens with the most pixels to show off on.
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
  }

  setSinkPoint(x: number, y: number): void {
    this.sink = { x, y };
  }

  /**
   * One pre-baked radial glow per shard kind.
   *
   * These were built with createRadialGradient inside the per-shard draw loop,
   * i.e. once per glowing shard per frame. A jackpot on a full lattice throws
   * three shards from every plate — on a 400-plate field that is over a
   * thousand live shards allocating a thousand gradients sixty times a second,
   * so the one moment the game most needs to land is the one that stutters.
   * Baked once, then blitted.
   */
  private glow = new Map<string, HTMLCanvasElement>();

  private glowSprite(kind: "value" | "gold"): HTMLCanvasElement {
    const cached = this.glow.get(kind);
    if (cached) return cached;
    const size = 64;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    if (kind === "value") {
      grad.addColorStop(0, "rgba(255,120,170,1)");
      grad.addColorStop(1, "rgba(255,45,111,0)");
    } else {
      grad.addColorStop(0, "rgba(255,214,120,1)");
      grad.addColorStop(1, "rgba(255,150,40,0)");
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    this.glow.set(kind, c);
    return c;
  }

  /** Fine static grain. Costs one blit and stops large flat areas looking bare. */
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

  /** Nearest cell to a canvas-space point, if the click landed on one. */
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
    const wasBonanza = this.snap.bonanzaAt;
    this.snap = snap;
    if (snap.bonanzaAt && snap.bonanzaAt !== wasBonanza) {
      this.goldWave = 1;
      this.eruptGold();
    }
    // Both on the perceptual scale, so backdrop and material answer the same
    // curve the ring and the audio do.
    this.heatTarget =
      snap.grace || snap.phase !== "live" ? 0.05 : riskScale(snap.hazard);
    this.stressTarget = snap.grace || snap.phase !== "live" ? 0 : riskScale(snap.hazard);

    // The key must identify WHICH cells, not just how many: two consecutive
    // rounds can have the same population with different ids (join one round,
    // sit out the next), and a count-only key skipped relayout — leaving one
    // player never drawn and a stale plate from the previous round on screen.
    //
    // A cheap sum-and-count summary rather than first:last:count. The old key
    // relied on ids being sequential, which is a property of the local demo's
    // id allocator and nothing the server promises; two rosters that agreed on
    // count, first and last but differed in the middle would silently skip
    // relayout and reproduce exactly the bug this key exists to prevent.
    let sig = 0;
    for (const c of snap.cells) sig = (sig * 31 + c.id) >>> 0;
    const key = `${snap.cells.length}:${sig}:${this.w | 0}:${this.h | 0}`;
    const relayout = key !== this.layoutKey;
    if (relayout) {
      // Positions only. `layout` used to stamp the NEW state onto every cell
      // while keeping the old timer, so the diff below then found nothing
      // changed and skipped the fracture, the shards and the shake — while
      // the stale timer made drawCells treat the plate as already gone. The
      // result was a plate vanishing in one frame with the shatter sound
      // still playing, on exactly the snapshots where a death and a roster
      // change arrive together, which is most of them.
      this.layout(snap.cells);
      this.layoutKey = key;
    }

    // Your round ending is the one event worth taking over the screen. It
    // fires for you alone, so it stays a single beat whether the lobby holds
    // ten players or a thousand, and it needs no announcements of other
    // people's wallets to land.
    if (snap.youOutcome !== this.youWas) {
      if (this.youWas === "in" && (snap.youOutcome === "dead" || snap.youOutcome === "cashed")) {
        this.hit = 1;
        this.hitKind = snap.youOutcome;
      }
      this.youWas = snap.youOutcome;
    }

    let deaths = 0;
    for (const input of snap.cells) {
      const cell = this.cells.get(input.id);
      if (!cell) continue;
      // Rim tint refreshes every push, before the state short-circuit — it is
      // display-only and must never depend on a state change to arrive.
      cell.hue = input.hue;
      if (cell.state === input.state) continue;
      cell.state = input.state;
      cell.t = 0;
      if (input.state === "dying") {
        deaths++;
        this.fracture(cell);
      } else if (input.state === "cashed") {
        this.release(cell);
      }
    }
    if (deaths > 0) this.shake = Math.min(1, this.shake + 0.14 + deaths * 0.04);
  }

  /**
   * Packs flat-top hexes into the largest grid that fits the viewport. Cell
   * size falls out of the population, so a small lobby gets chunky plates and a
   * packed one gets fine ore.
   */
  private layout(inputs: CellInput[]): void {
    const n = inputs.length;
    if (n === 0) {
      this.cells.clear();
      return;
    }

    const padX = this.w * 0.05;
    const top = this.h * 0.03;
    const bottom = this.h * 0.05;
    const availW = this.w - padX * 2;
    const availH = Math.max(40, this.h - top - bottom);

    // Shrink until the grid genuinely holds every cell.
    //
    // Two clipping bugs lived here. The height budget ignored the half-hex
    // stagger that every other column carries, so the bottom plate of each odd
    // column hung past the frame. And the loop stopped shrinking at r=3 even
    // when the grid still had fewer slots than players, which sent the
    // overflow columns off the right edge. The stagger is now budgeted and
    // capacity is a hard requirement.
    const hexH = Math.sqrt(3);
    let r = Math.sqrt((availW * availH) / (2.6 * n));
    // Tiny fields used to zoom absurdly: with one or two players the capacity
    // check passes immediately and a lone hex could outgrow the canvas,
    // overflowing the frame on phones. The ceiling has to scale with the
    // viewport, not be a fixed pixel count — a flat cap sized for a phone
    // shrinks a full desktop field to a third of the space it should own.
    //
    // And the cap has to loosen as the field thins: at a flat 16% a 3-plate
    // beta lobby huddled in the middle of a frame four times its size. Small
    // fields own the frame; the capacity loop below still shrinks whatever
    // cannot actually fit, so overflow stays impossible.
    const fillShare = n <= 4 ? 0.3 : n <= 9 ? 0.24 : n <= 16 ? 0.19 : 0.16;
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

    // Shape the occupied block to the canvas, not to whatever the capacity
    // grid happens to be. Since the radius cap landed, a half-full desktop
    // lobby had far more rows than it needed and players stacked into one or
    // two tall columns; picking the row count so the block's aspect tracks
    // the canvas brings back the beehive cluster at every population.
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
    // Includes the stagger, so centring can never push plates out of frame.
    const gridH = usedRows * r * hexH + (r * hexH) / 2;
    const startX = (this.w - gridW) / 2 + r;
    const startY = top + (availH - gridH) / 2 + (r * hexH) / 2;

    this.bounds = { x: startX - r * 1.2, y: startY - r, w: gridW + r * 0.4, h: gridH + r };

    // Slot coordinates for the packed block, in column-major order.
    const slots: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const col = Math.floor(i / usedRows);
      const row = i % usedRows;
      slots.push({
        x: startX + col * r * 1.5,
        y: startY + row * r * hexH + (col % 2 ? (r * hexH) / 2 : 0),
      });
    }

    // ------------------------------------------------ owner-aware assignment
    //
    // The grid is a packed block; HOW cells map onto its slots decides
    // whether a wallet's plates look like a holding or like confetti. Two
    // failed schemes preceded this one, both ordering-based: array position
    // maps onto column-major slot order, so any group straddling a column
    // boundary tears — bottom of one column, top of the next — and the slots
    // reserved for the viewer punch holes in everyone else's runs. Ordinal
    // schemes cannot cluster a 2-D surface. So the mapping is spatial: each
    // owner grows a compact blob by repeatedly claiming the free slot nearest
    // to what it already holds. The viewer's blob grows from the block's
    // centre; other groups, largest first, grow from the tiling frontier;
    // singles fill whatever remains. Deterministic throughout — identical
    // roster, identical layout.
    const cx = slots.reduce((a, s) => a + s.x, 0) / n;
    const cy = slots.reduce((a, s) => a + s.y, 0) / n;
    const YOU_KEY = "<you>";
    const groupsMap = new Map<string, CellInput[]>();
    for (const input of inputs) {
      const key = input.you ? YOU_KEY : (input.group ?? `solo:${input.id}`);
      const members = groupsMap.get(key);
      if (members) members.push(input);
      else groupsMap.set(key, [input]);
    }
    const groups = [...groupsMap.entries()].sort((a, b) => {
      if ((a[0] === YOU_KEY) !== (b[0] === YOU_KEY)) return a[0] === YOU_KEY ? -1 : 1;
      if (a[1].length !== b[1].length) return b[1].length - a[1].length;
      return a[0] < b[0] ? -1 : 1;
    });

    // Every neighbour in this packing — same-column or diagonal — sits at
    // exactly sqrt(3)·r, so one distance threshold defines hex adjacency.
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

    /** Connected regions of the free slots, under hex adjacency. */
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
      // Desired anchor: the viewer at the block's centre; other groups at the
      // current scan-order frontier, so the tiling stays gap-free.
      const first = unassigned.values().next().value;
      if (first === undefined) break;
      const anchor = key === YOU_KEY ? { x: cx, y: cy } : slots[first]!;
      while (need > 0 && unassigned.size > 0) {
        // Grow inside ONE connected free region that fits the whole group —
        // a connected region always offers a free slot adjacent to the blob,
        // so growth provably cannot strand or jump. A naive greedy over all
        // free slots (the previous attempt) seeded into pockets smaller than
        // the group and split ~2.5% of clusters. When no region fits (free
        // space is all pockets), take the largest and spill the remainder —
        // geometrically unavoidable, and rare because big groups place first.
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

        // True when the region stays in one piece after `removed` leaves it.
        // Claiming an articulation slot is what fragments the free space into
        // pockets too small for the next group, so every claim prefers a
        // non-articulation candidate and cuts only when there is no choice.
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

        /** Claims the best-ranked slot that avoids cutting the region. */
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
          // Candidates are the blob's FRONTIER — free slots touching it —
          // because anything else would disconnect the blob itself. A
          // connected region always has one while slots remain. Ranked by
          // how many blob neighbours a slot touches (pocket-fillers first,
          // for compact shapes), then index; the articulation veto in
          // `claim` then keeps the leftover region whole when it can.
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
        // Carry the PREVIOUS state forward and let the transition diff apply
        // the new one, so a relayout never swallows a death or a cash-out.
        state: prev?.state ?? input.state,
        t: prev?.t ?? 0,
        seed: ((input.id * 2654435761) >>> 0) / 4294967296,
        born: prev?.born ?? 0,
        hue: input.hue,
      });
    }
    this.cells = kept;
  }

  /** A plate breaking apart. Shards carry its value toward the multiplier. */
  private fracture(cell: Cell): void {
    const r = this.radius;
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 130;
      this.shards.push({
        x: cell.x,
        y: cell.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 30,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 9,
        size: r * (0.16 + Math.random() * 0.3),
        life: 0,
        maxLife: 0.7 + Math.random() * 0.5,
        kind: i < 4 ? "value" : "ore",
      });
    }
  }

  /**
   * The jackpot. Every plate in the lattice throws gold at once — the one
   * moment the scene is allowed to be warm.
   */
  private eruptGold(): void {
    const r = this.radius;
    // Thinned out on a packed lattice: three shards from each of 400 plates is
    // 1200 additive glows a frame for nearly three seconds. The celebration
    // reads the same at a few hundred and actually holds its frame rate.
    const per = this.cells.size > 120 ? 1 : 3;
    for (const c of this.cells.values()) {
      for (let i = 0; i < per; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 90 + Math.random() * 260;
        this.shards.push({
          x: c.x,
          y: c.y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 120,
          rot: Math.random() * Math.PI,
          vrot: (Math.random() - 0.5) * 14,
          size: r * (0.2 + Math.random() * 0.35),
          life: 0,
          maxLife: 1.6 + Math.random() * 1.2,
          kind: "gold",
        });
      }
    }
  }

  /** A plate lifted out cleanly. Drifts up, no value released. */
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
    this.time += dt;
    this.heat += (this.heatTarget - this.heat) * Math.min(1, dt * 3.5);
    this.stressS += (this.stressTarget - this.stressS) * Math.min(1, dt * 4.5);
    // The lake freezes over during the grace ticks, then the frost lifts as
    // the first real roll arrives — freezing is quick, thawing is gradual.
    const frostTarget = this.snap.phase === "live" && this.snap.grace ? 1 : 0;
    this.frost += (frostTarget - this.frost) * Math.min(1, dt * (frostTarget > this.frost ? 3.2 : 1.6));
    this.shake *= Math.pow(0.002, dt);
    if (this.goldWave > 0) this.goldWave = Math.max(0, this.goldWave - dt / 6);
    if (this.hit > 0) this.hit = Math.max(0, this.hit - dt / 1.1);

    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0.01) {
      const s = this.shake * 4.5;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    this.drawRock();
    this.drawSeams();
    this.drawCells(dt);
    this.drawShards(dt);
    if (this.goldWave > 0) this.drawGoldFlood();
    this.drawAtmosphere();
    if (this.hit > 0) this.drawHit();
    this.drawGrain();

    ctx.restore();
  }

  /**
   * Your own ending, felt rather than announced: the room floods from the
   * edges, crimson when the ice takes you and mint when you get out. Fast in,
   * slow out, so it hits like an impact and then lets go of the screen.
   */
  private drawHit(): void {
    const { ctx, w, h } = this;
    const k = this.hit;
    // The first instant is the punch; the rest is the room settling.
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
      // One pattern fill instead of ~66 drawImage tiles per frame.
      this.grainPattern = ctx.createPattern(this.grain, "repeat");
    }
    if (!this.grainPattern) return;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** Jackpot wash. Warm light floods the cold lattice, then drains away. */
  private drawGoldFlood(): void {
    const { ctx, w, h } = this;
    const k = this.goldWave;
    const burst = Math.min(1, (1 - k) * 5);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(
      w / 2,
      h / 2,
      0,
      w / 2,
      h / 2,
      Math.max(w, h) * (0.35 + burst * 0.5),
    );
    const a = k * 0.7;
    g.addColorStop(0, `rgba(255,206,110,${a})`);
    g.addColorStop(0.5, `rgba(255,160,50,${a * 0.5})`);
    g.addColorStop(1, "rgba(255,120,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Expanding shock ring on the initial hit.
    if (burst < 1) {
      ctx.globalAlpha = (1 - burst) * 0.8;
      ctx.strokeStyle = "#ffe6a8";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, burst * Math.max(w, h) * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRock(): void {
    const { ctx, w, h } = this;
    // Lifted off near-black. The hues are unchanged — these are the same cold
    // blue-greys, just carrying enough luminance that the empty space around
    // the lattice reads as a room the grid is sitting in rather than as a void
    // pressing in on it.
    if (!this.rockG) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0a121a");
      g.addColorStop(0.5, "#112031");
      g.addColorStop(1, "#0a121a");
      this.rockG = g;
    }
    ctx.fillStyle = this.rockG;
    ctx.fillRect(0, 0, w, h);

    // A soft cold light from above the shaft. Costs almost nothing and does
    // most of the work of making the space feel open — a flat fill reads as a
    // wall, a gradient with a source reads as depth.
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

  /**
   * The heat behind the lattice. Plates are drawn opaque on top, so this shows
   * only through the gaps — the grid appears backlit along its seams.
   */
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
    // The fill must cover the gradient's whole falloff circle. Clipped at
    // bounds+40 the glow was cut while still visibly non-zero, printing a
    // hard-edged rectangle behind the lattice.
    ctx.fillRect(midX - reach, midY - reach, reach * 2, reach * 2);

    // A second tighter core so genuine danger reads as molten. On the
    // perceptual scale 0.4 is ~1.9% hazard, so this joins mid-band and grows.
    if (this.heat > 0.4) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (this.heat - 0.4) * 0.55;
      ctx.fillStyle = grad;
      ctx.fillRect(midX - reach, midY - reach, reach * 2, reach * 2);
    }
    ctx.restore();
  }

  /** Deterministic per-cell noise, so stress visuals never flicker frame to frame. */
  private static rnd(s: number): number {
    const x = Math.sin(s * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  /**
   * Hairline stress cracks — the frozen lake groaning before it gives.
   *
   * Uniform across the field: every live plate cracks at the same intensity,
   * because every live plate faces the same hazard. Per-plate stagger read as
   * differential risk — players took a clean neighbour to mean their own
   * plate was the weak one and cashed out on a signal that did not exist. The
   * seed only varies geometry (crack angles and jags), never how cracked a
   * plate is.
   */
  private drawStress(c: Cell, k: number, jx: number, jy: number): void {
    const { ctx } = this;
    const r = this.radius;
    const R = LatticeRenderer.rnd;

    ctx.save();
    ctx.strokeStyle = "#eaf6ff";
    ctx.lineWidth = Math.max(0.6, r * 0.06);
    ctx.lineCap = "round";
    // Short opacity ramp at the bottom of the band: the whole field's
    // hairlines emerge together, faint first, instead of popping in at once.
    ctx.globalAlpha = Math.min(1, k * 6) * (0.24 + 0.55 * k);
    const grow = 0.5 + 0.5 * k;
    // More fractures join as the plate gets deeper into trouble.
    const arms = 2 + (k > 0.4 ? 1 : 0) + (k > 0.75 ? 1 : 0);
    for (let arm = 0; arm < arms; arm++) {
      const a0 = R(c.seed * 31.7 + arm * 7.3) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c.x + jx + Math.cos(a0) * r * 0.85, c.y + jy + Math.sin(a0) * r * 0.85);
      // Walk inward from the edge with sideways jags; the drawn length grows
      // with stress. Points stay inside the plate by construction, so no clip.
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

  /**
   * The plate face for the current stress, cross-faded so the ice degrades
   * continuously instead of snapping between the four drawn stages. A plate
   * that is breaking jumps straight to the shattered face.
   */
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
    // Personality without dishonesty. Each plate gets a fixed sixth-turn and
    // a hair of tonal drift, so no two look stamped from the same mould —
    // but the DAMAGE on every plate is identical, because the field shares
    // one hazard and the ice must never imply otherwise.
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

    // Every plate is now the same sheet of ice, so "you" has to be marked
    // loudly: a cyan wash, a heavy breathing rim, and a glow that carries
    // across a full field. Finding yourself must never take a second look.
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
    // The faces decode after the first layout is already on screen, so the
    // atlas rebakes itself once whenever more art has arrived.
    if (this.tiles && this.tiles.version !== tileVersion && this.radius > 0) {
      this.tiles = new TileAtlas(this.radius, this.dpr);
    }
    const tiles = this.tiles?.usable ? this.tiles : null;

    // Material stress on the perceptual scale: first hairlines below 2%
    // hazard, half the field visibly cracked by ~3%, violent from 5% up. The
    // 3-6% band is where most rounds peak, so that is where the gradient
    // must live, not above it.
    const stress = Math.max(0, Math.min(1, (this.stressS - 0.35) / 0.65));
    const b = this.bounds;
    const midX = b.x + b.w / 2;
    const midY = b.y + b.h / 2;
    const span = Math.max(b.w, b.h) * 0.6 || 1;

    for (const c of this.cells.values()) {
      c.t += dt;
      if (c.born < 1) c.born = Math.min(1, c.born + dt * 4);

      let alpha = 1;
      let scale = 1;
      let dy = 0;

      if (c.born < 1) {
        // Crystallising in as a player joins the lobby.
        const k = c.born;
        alpha = k;
        scale = 0.55 + 0.45 * (1 - Math.pow(1 - k, 3));
      }

      const inPlay = c.state === "live" || c.state === "you";

      if (c.state === "dying") {
        // Hold the shattered face at full strength before the plate falls
        // away. Without the hold it faded from the first frame, so the
        // broken-ice art was on screen for about a tenth of a second and
        // players never actually saw the plate break.
        const k = Math.max(0, Math.min(1, (c.t - 0.2) / 0.45));
        alpha *= 1 - k;
        scale *= 1 - k * 0.3;
        if (k >= 1) continue;
      } else if (c.state === "cashed") {
        const k = Math.min(1, c.t / 0.55);
        // Mid-round a vacated plate stays a legible ghost — the sheet reads
        // as one surface with people missing. On the RESULT screen the same
        // ghost read as "still standing" under the dark overlay, flatly
        // contradicting the verdict beside it, so leavers all but vanish.
        const fade = this.snap.phase === "result" ? 0.9 : 0.45;
        alpha *= 1 - k * fade;
        dy = -k * 3;
      } else if (c.state === "you") {
        scale *= 1 + Math.sin(this.time * 3 + c.seed * 6) * 0.018;
      }

      if (alpha <= 0.02) continue;

      // Trembling under stress — each plate shivers on its own phase, so the
      // lattice shudders rather than sliding around as one rigid body.
      let jx = 0;
      let jy = 0;
      if (stress > 0.02 && inPlay) {
        jx = Math.sin(this.time * 13 + c.seed * 43) * 1.2 * stress;
        jy = Math.cos(this.time * 11.3 + c.seed * 31) * 1.2 * stress;
      }

      const sprite = atlas.get(c.state);
      ctx.globalAlpha = alpha;
      const dw = sprite.w * scale;
      const dh = sprite.h * scale;
      ctx.drawImage(sprite.canvas, c.x - dw / 2 + jx, c.y - dh / 2 + jy + dy, dw, dh);

      // The drawn plate face, laid over the procedural one so its glow and
      // rim still frame the plate. Everyone shows the same stage of failure:
      // the field shares one hazard, so it must read as one sheet of ice.
      if (tiles && c.state !== "cashed") {
        this.drawTileFace(c, tiles, stress, alpha, scale, jx, jy + dy);
      } else if (tiles) {
        // A vacated plate keeps its ice, drained of light: the lattice reads
        // as one sheet with people missing from it, not as black holes.
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

      // Owner rim: a multi-plate wallet's cluster shares one tinted outline,
      // so a stack reads as one holding instead of coincidentally similar
      // neighbours. Thin and dim on purpose — it labels, it does not compete
      // with the hazard glow. Dying plates keep theirs while they fade, so a
      // cluster visibly loses a member rather than a stranger.
      if (c.hue !== undefined && c.state !== "cashed" && this.radius > 5) {
        ctx.globalAlpha = alpha * 0.65;
        ctx.strokeStyle = `hsl(${c.hue} 65% 60%)`;
        ctx.lineWidth = Math.max(1, this.radius * 0.07);
        hexPath(ctx, c.x + jx, c.y + jy + dy, this.radius * scale * 0.88);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      // Grace freeze-over: frost sweeps outward from the centre of the lattice
      // and settles over every plate, then lifts as the first real roll lands.
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

      // Procedural fractures are the fallback only: when the drawn faces are
      // present they carry the whole cracking gradient, and running both
      // scribbles a second set of cracks over the art.
      if (!tiles && stress > 0.03 && inPlay && this.radius > 6) {
        this.drawStress(c, stress, jx, jy);
      }

      // Fracture lines race across the plate in the instant before it breaks.
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
    this.drawYouTag();
    ctx.globalAlpha = 1;
  }

  /**
   * One floating marker over your whole holding. The per-plate cyan rims say
   * "these plates are special"; this says WHOSE they are and how many, which
   * multi-buy made ambiguous — a two-plate stack next to an owner-rimmed bot
   * cluster read as just another cluster until you hunted for the cyan. The
   * count falls as your plates die, so the tag doubles as a live stack gauge.
   */
  private drawYouTag(): void {
    if (this.radius <= 5 || this.snap.phase === "result") return;
    const { ctx } = this;
    let n = 0;
    let sx = 0;
    let topY = Infinity;
    for (const c of this.cells.values()) {
      if (c.state !== "you") continue;
      n++;
      sx += c.x;
      if (c.y < topY) topY = c.y;
    }
    if (n === 0) return;

    const cx = sx / n;
    const fs = Math.max(11, Math.min(17, this.radius * 0.55));
    const bob = Math.sin(this.time * 2.6) * 1.6;
    // Above the topmost plate of the cluster, clamped so a top-row cluster
    // keeps the tag on screen instead of clipping it at the frame edge.
    const y = Math.max(fs + 10, topY - this.radius * 1.32) + bob;
    const label = n > 1 ? `YOU ×${n}` : "YOU";

    ctx.save();
    ctx.font = `700 ${fs}px "Chakra Petch", ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // Dark halo, not a chip: keeps the chrome boxless while staying legible
    // over pale ice and hot seams alike.
    ctx.shadowColor = "rgba(2, 12, 18, 0.95)";
    ctx.shadowBlur = 5;
    ctx.fillStyle = "#3fe0d8";
    ctx.fillText(label, cx, y - 4);
    // Chevron pointing down into the cluster.
    const cw = fs * 0.34;
    ctx.beginPath();
    ctx.moveTo(cx - cw, y);
    ctx.lineTo(cx + cw, y);
    ctx.lineTo(cx, y + cw * 1.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Broken ore in flight. Value shards home in on the multiplier. */
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
      } else if (s.kind === "gold") {
        s.vy += 220 * dt;
        s.vx *= 1 - 0.6 * dt;
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
      if (s.kind === "value" || s.kind === "gold") {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a;
        const r = s.size * (s.kind === "value" ? 3.2 : 4);
        ctx.drawImage(this.glowSprite(s.kind), -r, -r, r * 2, r * 2);
      }
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(0, -s.size);
      ctx.lineTo(s.size * 0.9, s.size * 0.7);
      ctx.lineTo(-s.size * 0.8, s.size * 0.6);
      ctx.closePath();
      ctx.fillStyle =
        s.kind === "value" ? "#ff9dbe" : s.kind === "gold" ? "#ffd36b" : "#a9d2e6";
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Depth haze and vignette.
   *
   * This was the single biggest source of the closed-in feeling: it crushed
   * the edges to 78% black, so however bright the backdrop was, the frame
   * always ended in darkness. It now starts further out and lands far
   * lighter — still enough to sit the lattice in space and pull the eye to
   * the middle, but no longer a tunnel.
   */
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
