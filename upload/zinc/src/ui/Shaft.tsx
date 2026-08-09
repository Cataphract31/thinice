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
    // The layout clusters spatially by `group`, so array order carries no
    // meaning here any more — the renderer grows each owner a contiguous
    // blob of hexes itself, with yours pinned to the centre.
    //
    // Rim colours come from a palette ORDERED FOR CONTRAST, not from a name
    // hash: the first clusters get far-apart colours (red, then green, then
    // gold, then violet...), never neighbouring shades, so two stacks side
    // by side cannot wear lookalike rims. Assignment is by each cluster's
    // lowest plate id — stable for the whole round, reshuffled naturally
    // between rounds by join order. No light blues or cyans anywhere: the
    // ice itself is pale blue and cyan is YOU. No black either; the pit
    // behind the lattice is near-black and the rim would vanish into it.
    // Overflow past the palette walks the golden angle, skipping that band.
    const counts = new Map<string, number>();
    for (const p of snap.players) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    // Orange sits near the back: it is only 22 degrees from gold, and with
    // both near the front a busy board wore the palette's one weak pair.
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
        // Only exits carry their banked multiple onto the board; the state
        // mapping below keeps a last-stander out of "cashed", so the print
        // lands on leavers alone.
        multiple: p.outcome === "cashed" ? p.multiple : undefined,
        // "Cashed" states two different endings: LEAVING mid-round, or being
        // auto-banked as the one who outlasted everyone. The board must not
        // conflate them — on the end screen the leavers ghost out and the
        // stander keeps standing, so the picture matches the verdict.
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
      bonanzaAt: snap.bonanza?.at ?? null,
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
