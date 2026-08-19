import { useRef, type JSX } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PlayerView, Snapshot } from "@/game/client";
import { CharHead } from "@/ui/Chars";

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
  const byOwner = new Map<string, { rep: PlayerView; count: number }>();
  for (const p of snap.players) {
    const g = byOwner.get(p.name);
    if (!g) {
      byOwner.set(p.name, { rep: p, count: 1 });
      continue;
    }
    g.count++;
    const better =
      rank(p) < rank(g.rep) ||
      (rank(p) === rank(g.rep) && p.multiple > g.rep.multiple);
    if (better) g.rep = p;
  }
  const rows = [...byOwner.values()].sort(
    (a, b) => rank(a.rep) - rank(b.rep) || b.rep.multiple - a.rep.multiple,
  );

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 10,
    paddingStart: 12,
  });

  return (
    <div ref={parentRef} className="scroll-fade h-full overflow-y-auto">
      <div className="relative w-full" style={{ height: virt.getTotalSize() }}>
        {virt.getVirtualItems().map((item) => {
          const { rep: p, count } = rows[item.index]!;
          const color =
            p.outcome === "dead"
              ? "var(--color-danger)"
              : p.outcome === "cashed"
                ? "var(--color-profit)"
                : p.you
                  ? "var(--color-cyan)"
                  : "var(--color-text)";
          return (
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
              {count > 1 && (
                <span
                  className="tnum shrink-0 text-[10px] font-semibold text-[var(--color-dim)]"
                  style={{ opacity: p.outcome === "dead" ? 0.45 : 1 }}
                >
                  ×{count}
                </span>
              )}
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
