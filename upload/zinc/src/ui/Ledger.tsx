import { useRef, type JSX } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PlayerView, Snapshot } from "@/game/client";
import { CharHead } from "@/ui/Chars";

/**
 * Who is still in, who got out, who did not. Sorted so the action is on top.
 *
 * This replaced a separate event feed — the roster already carries the same
 * information as live state rather than as scrolling history, and one dense
 * panel beats two half-height ones.
 */
export function Roster({
  snap,
  onSelect,
}: {
  snap: Snapshot;
  onSelect?: (id: number) => void;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const rank = (p: PlayerView): number =>
    p.you ? 0 : p.outcome === "in" ? 1 : p.outcome === "cashed" ? 2 : 3;
  const rows = [...snap.players].sort(
    (a, b) => rank(a) - rank(b) || b.multiple - a.multiple,
  );

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 10,
    // Clears the scroll container's top fade, so the first row is never
    // half-swallowed by it under the tab header.
    paddingStart: 12,
  });

  return (
    <div ref={parentRef} className="scroll-fade h-full overflow-y-auto">
      <div className="relative w-full" style={{ height: virt.getTotalSize() }}>
        {virt.getVirtualItems().map((item) => {
          const p = rows[item.index]!;
          const color =
            p.outcome === "dead"
              ? "var(--color-danger)"
              : p.outcome === "cashed"
                ? "var(--color-profit)"
                : p.you
                  ? "var(--color-cyan)"
                  : "var(--color-text)";
          return (
            /* A real button, not a clickable div: this is the only way to open
               a player card, and as a bare div it was unreachable by keyboard
               and invisible to a screen reader. */
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect?.(p.id)}
              aria-label={`Open ${p.name}`}
              className="absolute left-0 flex w-full cursor-pointer items-center gap-2 px-1 text-left text-[11.5px] hover:bg-[var(--color-panel2)] focus-visible:bg-[var(--color-panel2)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-cyan)]"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <CharHead charId={p.charId} outcome={p.outcome} />
              <span
                className="truncate"
                style={{
                  color: p.you ? "var(--color-cyan)" : "var(--color-text)",
                  opacity: p.outcome === "dead" ? 0.45 : 1,
                  fontWeight: p.you ? 600 : 400,
                }}
              >
                {p.name}
              </span>
              <span
                className="tnum ml-auto shrink-0"
                style={{
                  color,
                  opacity: p.outcome === "dead" ? 0.5 : 1,
                  textDecoration: p.outcome === "dead" ? "line-through" : "none",
                }}
              >
                {p.outcome === "dead" ? "0.00×" : `${p.multiple.toFixed(2)}×`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
