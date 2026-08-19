import { useEffect, useRef, type JSX } from "react";
import { LatticeRenderer } from "@/render/lattice";
import type { Snapshot } from "@/game/client";
import type { CellState } from "@/render/cells";

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
    r.setSinkPoint(0.5, -0.08);
    r.start();

    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      r.resize(box ? { width: box.width, height: box.height } : undefined);
    });
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
    const counts = new Map<string, number>();
    for (const p of snap.players) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const PALETTE = [348, 130, 48, 270, 224, 312, 26, 84];
    const firstId = new Map<string, number>();
    for (const p of snap.players) {
      if (p.you || (counts.get(p.name) ?? 0) < 2) continue;
      const cur = firstId.get(p.name);
      if (cur === undefined || p.id < cur) firstId.set(p.name, p.id);
    }
    const hueByGroup = new Map<string, number>();
    [...firstId.entries()]
      .sort((a, b) => a[1] - b[1])
      .forEach(([name], i) => {
        let hue =
          i < PALETTE.length
            ? PALETTE[i]!
            : Math.round(PALETTE[i % PALETTE.length]! + 137.5 * Math.floor(i / PALETTE.length)) %
              360;
        if (hue > 150 && hue < 210) hue = (hue + 70) % 360;
        hueByGroup.set(name, hue);
      });
    r.update({
      cells: snap.players.map((p) => ({
        id: p.id,
        you: p.you,
        group: p.name,
        charId: p.charId,
        hue: hueByGroup.get(p.name),
        multiple: p.outcome === "cashed" ? p.multiple : undefined,
        state: (p.outcome === "dead"
          ? "dying"
          : p.outcome === "cashed"
            ? p.lastStanding
              ? p.you
                ? "you"
                : "live"
              : "cashed"
            : p.you
              ? "you"
              : "live") as CellState,
      })),
      hazard: snap.hazard,
      grace: snap.grace,
      phase: snap.phase,
      youOutcome: snap.you.joined ? snap.you.outcome : "out",
      youCharId: snap.charId,
      chat: snap.chat,
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
