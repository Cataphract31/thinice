/**
 * Ice cell sprites.
 *
 * Each player is a plate of ice in a frozen lattice — and snowflakes are
 * hexagonal, so the same geometry carries both readings: hexes tile without
 * gaps, stay legible from eight cells to a thousand, and a six-fold dendrite
 * etched into each face turns the plate into a snowflake without costing the
 * grid anything. Death gets something better to do than fade out: the ice
 * fractures.
 *
 * Sprites are rebuilt only when the layout changes, then blitted per frame.
 */

export type CellState = "live" | "you" | "dying" | "cashed";

export interface CellSprite {
  canvas: HTMLCanvasElement;
  /** Offset from the hex centre to the sprite's top-left corner. */
  ox: number;
  oy: number;
  w: number;
  h: number;
}

interface Tones {
  face: string;
  facetLight: string;
  facetDark: string;
  rim: string;
  spec: string;
  glow: string | null;
}

/** Glacial ice. */
const TONES: Record<CellState, Tones> = {
  live: {
    face: "#1f3a4d",
    facetLight: "#38617c",
    facetDark: "#152b3a",
    rim: "#5b93b4",
    spec: "#c9ecff",
    glow: null,
  },
  you: {
    face: "#104453",
    facetLight: "#1d7a8f",
    facetDark: "#0a2f3a",
    rim: "#3fe0d8",
    spec: "#c8fbff",
    glow: "#3fe0d8",
  },
  dying: {
    face: "#4a1024",
    facetLight: "#8a1c3c",
    facetDark: "#2c0a16",
    rim: "#ff2d6f",
    spec: "#ffd0e0",
    glow: "#ff2d6f",
  },
  cashed: {
    face: "#0b1219",
    facetLight: "#101c25",
    facetDark: "#080d12",
    rim: "#2e6f63",
    spec: "#3fe8c0",
    glow: null,
  },
};

/** Flat-top hexagon. Corner k sits at angle 60k degrees. */
export function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function buildSprite(state: CellState, r: number, dpr: number): CellSprite {
  const t = TONES[state];
  const pad = Math.max(3, r * 0.5);
  const w = r * 2 + pad * 2;
  const h = r * Math.sqrt(3) + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const cx = w / 2;
  const cy = h / 2;
  const hollow = state === "cashed";

  // Outer bloom for the states that should read across the whole lattice.
  if (t.glow) {
    const g = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r + pad);
    g.addColorStop(0, `${t.glow}55`);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Plate face
  hexPath(ctx, cx, cy, r);
  const face = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  face.addColorStop(0, t.facetLight);
  face.addColorStop(0.5, t.face);
  face.addColorStop(1, t.facetDark);
  ctx.fillStyle = face;
  ctx.globalAlpha = hollow ? 0.55 : 1;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Crystal facets: two wedges from the centre catch the light differently, so
  // the plate reads as a cut mineral rather than a flat polygon.
  if (!hollow && r > 7) {
    ctx.save();
    hexPath(ctx, cx, cy, r);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(Math.PI), cy + r * Math.sin(Math.PI));
    ctx.lineTo(cx + r * Math.cos((Math.PI / 3) * 4), cy + r * Math.sin((Math.PI / 3) * 4));
    ctx.closePath();
    ctx.fillStyle = t.facetLight;
    ctx.globalAlpha = 0.5;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(0), cy + r * Math.sin(0));
    ctx.lineTo(cx + r * Math.cos(Math.PI / 3), cy + r * Math.sin(Math.PI / 3));
    ctx.closePath();
    ctx.fillStyle = t.facetDark;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Dendrite etching: the six-fold branching that makes a hexagon read as a
  // snowflake. Etched *into* the ice — low alpha, clipped to the plate — not
  // drawn on top of it. Arms point at the corners, side branchlets fork at
  // 60° the way real dendrites grow, and a small hexagonal core anchors the
  // centre.
  if (!hollow && r > 8 && (state === "live" || state === "you")) {
    ctx.save();
    hexPath(ctx, cx, cy, r);
    ctx.clip();
    ctx.strokeStyle = t.spec;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = Math.max(0.5, r * 0.045);
    ctx.lineCap = "round";
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const arm = r * 0.78;
      ctx.beginPath();
      ctx.moveTo(cx + ux * r * 0.1, cy + uy * r * 0.1);
      ctx.lineTo(cx + ux * arm, cy + uy * arm);
      for (const s of [-1, 1]) {
        const bx = cx + ux * arm * 0.55;
        const by = cy + uy * arm * 0.55;
        const ba = a + (s * Math.PI) / 3;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(ba) * arm * 0.28, by + Math.sin(ba) * arm * 0.28);
      }
      ctx.stroke();
    }
    hexPath(ctx, cx, cy, r * 0.22);
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Rim
  hexPath(ctx, cx, cy, r * 0.985);
  ctx.strokeStyle = t.rim;
  ctx.lineWidth = Math.max(0.7, r * (state === "you" ? 0.1 : 0.05));
  ctx.globalAlpha = hollow ? 0.7 : 1;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Specular along the top-left edges only — a single light source keeps the
  // whole lattice looking lit rather than glowing.
  if (r > 5) {
    ctx.beginPath();
    const a1 = (Math.PI / 3) * 3;
    const a2 = (Math.PI / 3) * 4;
    const a3 = (Math.PI / 3) * 5;
    ctx.moveTo(cx + r * Math.cos(a1) * 0.94, cy + r * Math.sin(a1) * 0.94);
    ctx.lineTo(cx + r * Math.cos(a2) * 0.94, cy + r * Math.sin(a2) * 0.94);
    ctx.lineTo(cx + r * Math.cos(a3) * 0.94, cy + r * Math.sin(a3) * 0.94);
    ctx.strokeStyle = t.spec;
    ctx.globalAlpha = hollow ? 0.25 : 0.55;
    ctx.lineWidth = Math.max(0.6, r * 0.055);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  return { canvas, ox: -cx, oy: -cy, w, h };
}

export class CellAtlas {
  private sprites = new Map<CellState, CellSprite>();
  /** Fracture overlays, drawn over a plate as it breaks. */
  readonly radius: number;

  constructor(radius: number, dpr: number) {
    this.radius = radius;
    for (const s of ["live", "you", "dying", "cashed"] as CellState[]) {
      this.sprites.set(s, buildSprite(s, radius, dpr));
    }
  }

  get(state: CellState): CellSprite {
    return this.sprites.get(state) ?? this.sprites.get("live")!;
  }
}
