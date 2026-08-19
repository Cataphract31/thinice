import { useEffect, useRef, useState, type JSX } from "react";
import type { Snapshot } from "@/game/client";

export function Multiplier({ snap }: { snap: Snapshot }): JSX.Element {
  const [jolt, setJolt] = useState(0);
  const prev = useRef(snap.multiplier);
  const [delta, setDelta] = useState<number | null>(null);

  useEffect(() => {
    if (snap.phase !== "live") {
      setDelta(null);
      prev.current = snap.multiplier;
      return;
    }
    const d = snap.multiplier - prev.current;
    if (d > 0.0005) {
      setJolt((j) => j + 1);
      setDelta(d);
      const t = setTimeout(() => setDelta(null), 900);
      prev.current = snap.multiplier;
      return () => clearTimeout(t);
    }
    prev.current = snap.multiplier;
  }, [snap.multiplier, snap.phase]);

  const locked = snap.you.lockedMultiple;
  const live = snap.phase === "live";
  const inProfit = snap.multiplier >= 1;
  const youIn = snap.you.outcome === "in";

  const color = !live
    ? "var(--color-dim)"
    : inProfit
      ? "var(--color-profit)"
      : "var(--color-zinc-hi)";

  return (
    <div className="relative flex flex-col items-center justify-center select-none">
      <div className="relative">
        <div
          key={jolt}
          className={`tnum leading-none ${live ? "jolt" : ""}`}
          style={{
            fontSize: "clamp(40px, 12vw, 112px)",
            fontWeight: 700,
            color,
            textShadow: live
              ? `0 0 42px ${inProfit ? "rgba(63,232,192,0.30)" : "rgba(143,179,199,0.18)"}`
              : "none",
            letterSpacing: "-0.03em",
          }}
        >
          {snap.multiplier.toFixed(2)}
          <span style={{ fontSize: "0.44em", marginLeft: "0.04em", opacity: 0.75 }}>×</span>
        </div>

        {delta !== null && (
          <div
            className="tnum absolute left-full top-1 ml-1 whitespace-nowrap text-[var(--color-profit)]"
            style={{ fontSize: "clamp(12px,3vw,18px)", fontWeight: 600 }}
          >
            +{delta.toFixed(2)}
          </div>
        )}
      </div>

      <div className="mt-1 h-4 text-center">
        {live && youIn && !inProfit && (
          <span className="label text-[var(--color-zinc-hi)]">
            {((1 - snap.multiplier) * 100).toFixed(0)}% to break even
          </span>
        )}
        {live && youIn && inProfit && (
          <span className="label text-[var(--color-profit)]">
            in profit · {((snap.multiplier - 1) * 100).toFixed(0)}% up
          </span>
        )}
        {live && snap.you.outcome === "dead" && (
          <span className="label text-[var(--color-danger)]">you shattered</span>
        )}
        {!live && snap.phase === "result" && (
          <span className="label">best this round</span>
        )}
      </div>

      {locked !== null && (
        <div className="mt-2 flex items-center gap-2 rounded-sm bg-[var(--color-cyan)]/12 px-3 py-1">
          <span className="label text-[var(--color-cyan)]">you banked</span>
          <span className="tnum text-[15px] font-semibold text-[var(--color-cyan)]">
            {locked.toFixed(2)}×
          </span>
        </div>
      )}
    </div>
  );
}
