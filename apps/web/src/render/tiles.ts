import { hexPath } from "./cells";

/**
 * Ice plate faces, drawn in code.
 *
 * These were hand-drawn pixel-art PNGs once, and they were the one layer of
 * the product that lived at a different resolution from everything around it:
 * chunky 16-bit texels, upscaled with smoothing into soft mush, wearing a
 * baked-in stair-stepped bevel that fought the vector rims drawn over it, in
 * a baby-blue that predated the neutral chrome. Every other layer — sprites,
 * rims, glows, shards, text — is resolution-independent. Now the faces are
 * too: baked per layout at device resolution, so they are crisp on a phone
 * and crisp on a 4K panel, and their palette is mixed here, next to the code
 * that draws the world they sit in. (The meme characters stay pixel art on
 * purpose: they are game pieces, small and framed; the ice is the whole
 * table.)
 *
 * Four faces, same contract as the drawn set they replace:
 *
 *     base      pristine ice
 *     hairline  first fractures
 *     heavy     failing
 *     crack     coming apart (death)
 *
 * drawTileFace cross-fades hairline over base and heavy over hairline as
 * stress climbs, so every stage shares an IDENTICAL body — same seed, same
 * veins, same bubbles — and only the fractures differ. A body that varied
 * between stages would shimmer during the fade.
 */

export type TileName = "base" | "hairline" | "heavy" | "crack";

/**
 * A regular hexagon maps exactly onto itself every sixth of a turn, so a plate
 * can be drawn at any multiple of 60 degrees and still fit its slot perfectly.
 * That gives six faces out of every one drawn: the ice stops looking stamped
 * out of a single mould while every plate still carries the identical amount
 * of damage, which is the part that must never vary between players.
 */
export const TILE_TURN = Math.PI / 3;

/** Procedural faces never arrive over the network, so the version is fixed. */
export const tileVersion = 1;

/** Deterministic noise. Fixed seeds, so every bake of the ice is the same ice. */
function rnd(s: number): number {
  const x = Math.sin(s * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The glacier palette. Light plates on dark water is the game's figure-ground
 * — the plate is where you stand, the gaps are what takes you — so the faces
 * stay bright, but desaturated toward real glacial ice: white with cold depth,
 * not cartoon baby-blue.
 */
const TOP = "#eff8fd";
const MID = "#d6eaf4";
const DEEP = "#accbe0";

/**
 * Frost: a tiny deterministic noise tile, patterned over the face at whisper
 * alpha so the glass has tooth instead of reading as blank plastic. Built
 * once for the module — bake-time cost only.
 */
let frostTile: HTMLCanvasElement | null = null;
function frost(): HTMLCanvasElement {
  if (frostTile) return frostTile;
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const x = c.getContext("2d")!;
  const img = x.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 190 + rnd(i * 0.37) * 65;
    img.data[i] = v;
    img.data[i + 1] = v + 6;
    img.data[i + 2] = 255;
    img.data[i + 3] = rnd(i * 0.91) * 26;
  }
  x.putImageData(img, 0, 0);
  frostTile = c;
  return c;
}
const VEIN = "47, 96, 128";
const CRACK_CORE = "rgba(252, 254, 255, 0.92)";
const CRACK_SHADOW = "rgba(43, 80, 105, 0.42)";
const GAP = "rgba(13, 27, 38, 0.55)";

/** One crack: a jagged walk from the rim toward the centre, shadow then core. */
function crack(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  seed: number,
  grow: number,
  branch: boolean,
  wide = 1,
): void {
  const a0 = rnd(seed * 31.7) * Math.PI * 2;
  const pts: [number, number][] = [];
  const steps = 4;
  pts.push([cx + Math.cos(a0) * r * 0.96, cy + Math.sin(a0) * r * 0.96]);
  for (let s = 1; s <= steps; s++) {
    const frac = (s / steps) * grow;
    const jag = (rnd(seed * 13.1 + s) - 0.5) * r * 0.42;
    pts.push([
      cx + Math.cos(a0) * r * 0.96 * (1 - frac) - Math.sin(a0) * jag,
      cy + Math.sin(a0) * r * 0.96 * (1 - frac) + Math.cos(a0) * jag,
    ]);
  }
  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
    ctx.stroke();
  };
  // Shadow first, offset toward the light's far side, then the bright core —
  // a real crack in ice scatters light along its lip and darkens inside.
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = CRACK_SHADOW;
  ctx.lineWidth = Math.max(1.2, r * 0.075) * wide;
  ctx.translate(r * 0.018, r * 0.024);
  trace();
  ctx.restore();
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = CRACK_CORE;
  ctx.lineWidth = Math.max(0.7, r * 0.038) * wide;
  trace();
  // A fork partway along, at the 60 degrees ice actually breaks at.
  if (branch && pts.length > 2) {
    const [bx, by] = pts[2]!;
    const ba = a0 + Math.PI + (rnd(seed * 7.7) > 0.5 ? 1 : -1) * (Math.PI / 3);
    const len = r * 0.3 * grow;
    ctx.lineWidth = Math.max(0.6, r * 0.028) * wide;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(
      bx + Math.cos(ba) * len - Math.sin(ba) * (rnd(seed * 3.3) - 0.5) * r * 0.16,
      by + Math.sin(ba) * len + Math.cos(ba) * (rnd(seed * 3.3) - 0.5) * r * 0.16,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The shared body: frosted glass, lit from the top-left like every other
 * surface in the scene. Painted identically for all four stages (fixed seeds),
 * so the cross-fade only ever fades fractures in, never shifts the ice.
 */
function body(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  // Slab fill, cold and slightly deeper toward the lower-right.
  const g = ctx.createLinearGradient(cx - r * 0.9, cy - r * 0.9, cx + r * 0.9, cy + r * 0.9);
  g.addColorStop(0, TOP);
  g.addColorStop(0.55, MID);
  g.addColorStop(1, DEEP);
  hexPath(ctx, cx, cy, r);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  hexPath(ctx, cx, cy, r);
  ctx.clip();

  // Subsurface structure: several THIN cool veins plus two bright internal
  // planes, all soft-blurred — depth inside the ice. The first cut used three
  // wide smudges and every plate came out wearing one grey wiper streak.
  ctx.lineCap = "round";
  for (let i = 0; i < 5; i++) {
    const s = 11 + i * 17;
    const x0 = cx + (rnd(s) - 0.5) * r * 1.8;
    const y0 = cy + (rnd(s + 1) - 0.5) * r * 1.8;
    const x1 = cx + (rnd(s + 2) - 0.5) * r * 1.8;
    const y1 = cy + (rnd(s + 3) - 0.5) * r * 1.8;
    ctx.strokeStyle = `rgba(${VEIN}, ${0.05 + rnd(s + 6) * 0.03})`;
    ctx.lineWidth = r * (0.03 + rnd(s + 7) * 0.04);
    ctx.shadowColor = `rgba(${VEIN}, 0.25)`;
    ctx.shadowBlur = r * 0.08;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(
      cx + (rnd(s + 4) - 0.5) * r,
      cy + (rnd(s + 5) - 0.5) * r,
      x1,
      y1,
    );
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  // The bright planes: hairline refractions catching the key light.
  for (let i = 0; i < 2; i++) {
    const s = 71 + i * 23;
    const a = Math.PI * (0.6 + rnd(s) * 0.25);
    const px = cx + (rnd(s + 1) - 0.5) * r * 0.9;
    const py = cy + (rnd(s + 2) - 0.5) * r * 0.9;
    const len = r * (0.5 + rnd(s + 3) * 0.5);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = Math.max(0.5, r * 0.018);
    ctx.beginPath();
    ctx.moveTo(px - Math.cos(a) * len, py - Math.sin(a) * len);
    ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
    ctx.stroke();
  }

  // Frost tooth over the whole face.
  const pat = ctx.createPattern(frost(), "repeat");
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Frozen bubbles, drifting toward the low side the way they freeze in.
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  for (let i = 0; i < 14; i++) {
    const s = 101 + i * 13;
    ctx.globalAlpha = 0.05 + rnd(s) * 0.07;
    ctx.beginPath();
    ctx.arc(
      cx + (rnd(s + 1) - 0.5) * r * 1.5,
      cy + (rnd(s + 2) - 0.35) * r * 1.4,
      r * (0.015 + rnd(s + 3) * 0.03),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // One diagonal sheet of light across the face.
  const sheen = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  sheen.addColorStop(0.12, "rgba(255,255,255,0)");
  sheen.addColorStop(0.28, "rgba(255,255,255,0.16)");
  sheen.addColorStop(0.45, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  // Dish: a whisper of inner shadow at the rim, so the slab has thickness.
  const dish = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
  dish.addColorStop(0, "rgba(40, 72, 96, 0)");
  dish.addColorStop(1, "rgba(40, 72, 96, 0.14)");
  ctx.fillStyle = dish;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  // Edge light where the sun catches, edge shade where it cannot: the same
  // single top-left key light the sprite layer and the shards already obey.
  const edge = (from: number, to: number, style: string, width: number): void => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const a = (Math.PI / 3) * i;
      const x = cx + r * 0.94 * Math.cos(a);
      const y = cy + r * 0.94 * Math.sin(a);
      if (i === from) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  edge(3, 5, "rgba(255, 255, 255, 0.55)", Math.max(0.8, r * 0.06));
  edge(0, 2, "rgba(46, 82, 108, 0.28)", Math.max(0.8, r * 0.06));

  ctx.restore();
}

/** Small dark nicks at the rim, for a plate that has started losing pieces. */
function chips(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number): void {
  ctx.save();
  hexPath(ctx, cx, cy, r);
  ctx.clip();
  ctx.fillStyle = "rgba(30, 58, 78, 0.3)";
  for (let i = 0; i < n; i++) {
    const s = 211 + i * 29;
    const a = rnd(s) * Math.PI * 2;
    const bx = cx + Math.cos(a) * r * 0.97;
    const by = cy + Math.sin(a) * r * 0.97;
    const k = r * (0.08 + rnd(s + 1) * 0.08);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - k + rnd(s + 2) * k, by - k * 0.6);
    ctx.lineTo(bx + k * 0.6, by + k - rnd(s + 3) * k);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The death face: a star of open fractures through the centre, dark water in
 * the gaps, drawn wider and louder than any stress stage — this is the frame
 * the fracture debris erupts from, and it must read as GONE, not as damaged.
 */
function shattered(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  hexPath(ctx, cx, cy, r);
  ctx.clip();
  // The plate loses its light the instant it gives.
  ctx.fillStyle = "rgba(20, 40, 56, 0.22)";
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  const arms = 6;
  for (let i = 0; i < arms; i++) {
    const s = 307 + i * 31;
    const a = (Math.PI * 2 * i) / arms + (rnd(s) - 0.5) * 0.7;
    // Open gap first — the water showing through — then the bright lip.
    for (const [style, width] of [
      [GAP, r * 0.11],
      [CRACK_CORE, r * 0.035],
    ] as const) {
      ctx.strokeStyle = style;
      ctx.lineWidth = Math.max(1, width);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx + (rnd(s + 9) - 0.5) * r * 0.14, cy + (rnd(s + 8) - 0.5) * r * 0.14);
      const steps = 3;
      for (let k = 1; k <= steps; k++) {
        const frac = k / steps;
        const jag = (rnd(s + k) - 0.5) * r * 0.34;
        ctx.lineTo(
          cx + Math.cos(a) * r * frac - Math.sin(a) * jag,
          cy + Math.sin(a) * r * frac + Math.cos(a) * jag,
        );
      }
      ctx.stroke();
    }
  }
  // A partial ring fracture, where the sheet sheared around the impact.
  ctx.strokeStyle = CRACK_SHADOW;
  ctx.lineWidth = Math.max(0.8, r * 0.05);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.52, rnd(401) * Math.PI * 2, rnd(401) * Math.PI * 2 + Math.PI * 1.3);
  ctx.stroke();
  ctx.restore();
}

/** Plate faces baked to one radius. Rebuilt whenever the layout changes. */
export class TileAtlas {
  readonly version: number = tileVersion;
  readonly w: number;
  readonly h: number;
  private baked = new Map<TileName, HTMLCanvasElement>();

  constructor(r: number, dpr: number) {
    this.w = r * 2;
    this.h = r * Math.sqrt(3);

    const stages: [TileName, (ctx: CanvasRenderingContext2D) => void][] = [
      ["base", () => {}],
      [
        "hairline",
        (ctx) => {
          for (let i = 0; i < 3; i++) crack(ctx, this.w / 2, this.h / 2, r, 3 + i * 7, 0.5, i === 0);
        },
      ],
      [
        "heavy",
        (ctx) => {
          for (let i = 0; i < 6; i++)
            crack(ctx, this.w / 2, this.h / 2, r, 53 + i * 11, 0.62 + rnd(i * 5) * 0.28, i % 2 === 0, 1.15);
          chips(ctx, this.w / 2, this.h / 2, r, 3);
        },
      ],
      ["crack", (ctx) => shattered(ctx, this.w / 2, this.h / 2, r)],
    ];

    for (const [name, fractures] of stages) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(this.w * dpr);
      canvas.height = Math.ceil(this.h * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);

      body(ctx, this.w / 2, this.h / 2, r);
      ctx.save();
      hexPath(ctx, this.w / 2, this.h / 2, r);
      ctx.clip();
      fractures(ctx);
      ctx.restore();

      // Cut the silhouette with a composited fill, not ctx.clip():
      // Chromium applies clip paths without anti-aliasing, and the masked
      // fill rasteriser IS anti-aliased — clean feathered edge at any DPR.
      ctx.globalCompositeOperation = "destination-in";
      hexPath(ctx, this.w / 2, this.h / 2, r);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      this.baked.set(name, canvas);
    }
  }

  get(name: TileName): HTMLCanvasElement | null {
    return this.baked.get(name) ?? null;
  }

  get usable(): boolean {
    return this.baked.has("base");
  }
}
