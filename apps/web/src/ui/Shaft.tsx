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
    // Your plates cluster: the layout packs cells in array order, so putting
    // every "you" plate in a contiguous run at the middle of the array lands
    // them adjacent near the centre of the beehive instead of scattered
    // wherever join order happened to file them. Deterministic — the same
    // roster always yields the same order, so relayout never reshuffles.
    const yours = snap.players.filter((p) => p.you);
    const others = snap.players.filter((p) => !p.you);
    const mid = Math.floor(others.length / 2);
    const ordered = [...others.slice(0, mid), ...yours, ...others.slice(mid)];
    r.update({
      cells: ordered.map((p) => ({
        id: p.id,
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
