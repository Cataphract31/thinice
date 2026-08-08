import { hexPath } from "./cells";

/**
 * Hand-drawn ice plate faces.
 *
 * Four stills live in `public/tiles/`, each the same hexagon at a different
 * stage of failure. They are baked once per layout into hex-clipped canvases
 * at the exact plate size, so the per-frame cost is a plain blit — the same as
 * the procedural sprites they sit on top of.
 *
 *     base      pristine ice
 *     hairline  first fractures
 *     heavy     failing
 *     crack     coming apart (death)
 *
 * Missing files simply leave the procedural plates in place, so the lattice
 * never depends on art existing.
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

const NAMES: TileName[] = ["base", "hairline", "heavy", "crack"];
const images = new Map<TileName, HTMLImageElement>();
let probed = false;
/** Bumped as art arrives, so a built atlas knows it is stale. */
export let tileVersion = 0;

export function initTileAssets(): void {
  if (probed) return;
  probed = true;
  const base = import.meta.env.BASE_URL || "/";
  for (const name of NAMES) {
    const img = new Image();
    img.onload = () => {
      images.set(name, img);
      tileVersion++;
    };
    img.src = `${base}tiles/${name}.png`;
  }
}

export function tilesReady(): boolean {
  return images.has("base");
}

/** Plate faces baked to one radius. Rebuilt whenever the layout changes. */
export class TileAtlas {
  readonly version: number;
  readonly w: number;
  readonly h: number;
  private baked = new Map<TileName, HTMLCanvasElement>();

  constructor(r: number, dpr: number) {
    this.version = tileVersion;
    this.w = r * 2;
    this.h = r * Math.sqrt(3);

    for (const name of NAMES) {
      const img = images.get(name);
      if (!img) continue;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(this.w * dpr);
      canvas.height = Math.ceil(this.h * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);

      // Cover-fit: the art is drawn as the same flat-top hexagon, so this is
      // near enough an exact overlay; the mask below absorbs any overhang.
      const s = Math.max(this.w / img.width, this.h / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      // Always filtered, at the best quality the browser offers. This used to
      // switch to nearest-neighbour whenever the art was enlarged, which on a
      // 4K display (large plates, 384px source art) blew the faces up into
      // visible pixel blocks — soft beats blocky at every scale.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (this.w - dw) / 2, (this.h - dh) / 2, dw, dh);

      // Cut the hex boundary with a composited fill, not ctx.clip():
      // Chromium applies clip paths without anti-aliasing, which is exactly
      // the stair-stepped plate edge reported on 4K. A destination-in fill
      // masks through the fill rasteriser, which IS anti-aliased, so the
      // silhouette comes out with a clean feathered edge at any DPR.
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
