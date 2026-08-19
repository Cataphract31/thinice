import { type JSX } from "react";
import type { Snapshot } from "@/game/client";
import { bandColor, bandLabel, riskBand } from "@/game/risk";

export function TickRing({ snap, tickMs }: { snap: Snapshot; tickMs: number }): JSX.Element {
  const live = snap.phase === "live";
  const band = riskBand(snap.hazard, snap.grace);
  const color = live ? bandColor(band) : "var(--color-edge2)";

  return (
    <div className="flex w-[88px] shrink-0 flex-col items-center justify-center p-2 sm:w-[118px]">
      <div className="relative aspect-square w-full max-w-[102px]">
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90">
          <circle
            cx="50"
            cy="50"
            r="44"
            fill="none"
            stroke="var(--color-panel2)"
            strokeWidth="6"
          />
          {live && (
            <circle
              key={snap.tick}
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke={color}
              strokeWidth="6"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray="100"
              strokeDashoffset="100"
              style={{ animation: `ring-charge ${tickMs}ms linear forwards` }}
            />
          )}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div
            className="tnum leading-none"
            style={{
              fontSize: 21,
              fontWeight: 700,
              color: live ? color : "var(--color-dim)",
            }}
          >
            {live ? (snap.hazard * 100).toFixed(1) : "-"}
            {live && <span style={{ fontSize: 11, opacity: 0.7 }}>%</span>}
          </div>
          <div className="label mt-1" style={{ color: live ? color : undefined }}>
            {live
              ? snap.grace
                ? `safe · ${snap.graceRemaining}`
                : bandLabel(band)
              : "danger"}
          </div>
        </div>
      </div>
      <div className="label tnum h-3" style={{ fontSize: 8.5, opacity: 0.75 }}>
        {live ? `tick ${snap.tick}` : ""}
      </div>
    </div>
  );
}
