import { useEffect, useRef, type JSX } from "react";
import { LatticeRenderer } from "@/render/lattice";
import type { Snapshot } from "@/game/client";
import type { CellState } from "@/render/cells";

/** Canvas host. React owns nothing inside here — the renderer runs its own loop. */
export function Shaft({
  snap,
  onSelectCell,
}: {
  snap: Snapshot;
  onSelectCell?: (id: number | null) => void;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<LatticeRenderer | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const r = new LatticeRenderer(canvas);
    renderer.current = r;
    // Value flows up out of the lattice toward the multiplier sitting above it.
    r.setSinkPoint(0.5, -0.08);
    r.start();

    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      r.stop();
      renderer.current = null;
    };
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const r = renderer.current;
    const canvas = ref.current;
    if (!r || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    onSelectCell?.(r.hitTest(e.clientX - rect.left, e.clientY - rect.top));
  };

  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    // Everyone's plates group by owner, not just yours: multi-betting is only
    // legible if a wallet holding four plates LOOKS like a wallet holding four
    // plates. Sorting by (name, id) is deterministic for a fixed roster, and
    // the layout packs adjacent array entries into adjacent slots. Your own
    // plates are position-independent here — the layout pins anything marked
    // `you` to the centre slots regardless of where it sits in this array.
    const ordered = [...snap.players].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id,
    );
    // Multi-plate owners get a rim tint hashed from the wallet name: stable
    // for the whole round, needs no palette bookkeeping, and steers clear of
    // the cyan band so nobody's stack masquerades as "you".
    const counts = new Map<string, number>();
    for (const p of ordered) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const hueOf = (name: string): number => {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
      const hue = h % 360;
      return hue > 150 && hue < 210 ? (hue + 70) % 360 : hue;
    };
    r.update({
      cells: ordered.map((p) => ({
        id: p.id,
        you: p.you,
        hue: !p.you && (counts.get(p.name) ?? 0) > 1 ? hueOf(p.name) : undefined,
        state: (p.outcome === "dead"
          ? "dying"
          : p.outcome === "cashed"
            ? "cashed"
            : p.you
              ? "you"
              : "live") as CellState,
      })),
      hazard: snap.hazard,
      grace: snap.grace,
      phase: snap.phase,
      bonanzaAt: snap.bonanza?.at ?? null,
      youOutcome: snap.you.joined ? snap.you.outcome : "out",
    });
  }, [snap]);

  return (
    <canvas
      ref={ref}
      onClick={handleClick}
      className="absolute inset-0 h-full w-full cursor-pointer"
    />
  );
}
