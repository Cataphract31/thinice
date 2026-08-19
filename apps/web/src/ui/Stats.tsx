import { type JSX } from "react";
import type { Snapshot } from "@/game/client";

export function StatsPanel({ snap }: { snap: Snapshot }): JSX.Element {
  const s = snap.stats;
  const paid = s.returned;
  const net = paid - s.wagered;
  const rtp = s.wagered > 0 ? (paid / s.wagered) * 100 : 0;
  const hitRate = s.roundsPlayed > 0 ? (s.roundsWon / s.roundsPlayed) * 100 : 0;

  const row = (label: string, value: string, color?: string): JSX.Element => (
    <div className="flex items-baseline justify-between gap-2 px-1.5 py-[3px]">
      <span className="label">{label}</span>
      <span
        className="tnum text-[11.5px] font-semibold"
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </div>
  );

  return (
    <div className="scroll-fade h-full overflow-y-auto pt-2.5">
      <div className="mx-1 rounded-sm bg-[var(--color-panel2)] p-1.5 text-center">
        <div className="label">net result</div>
        <div
          className="tnum text-[19px] font-bold"
          style={{ color: net >= 0 ? "var(--color-profit)" : "var(--color-danger)" }}
        >
          {net >= 0 ? "+" : ""}
          {net.toFixed(4)} ◎
        </div>
        <div className="label">{rtp.toFixed(1)}% returned on {s.wagered.toFixed(2)} ◎ wagered</div>
      </div>

      <div className="mt-1.5">
        {row(
          "session p/l",
          `${snap.session >= 0 ? "+" : ""}${snap.session.toFixed(3)} ◎`,
          snap.session >= 0 ? "var(--color-profit)" : "var(--color-danger)",
        )}
        {row("total wagered", `${s.wagered.toFixed(3)} ◎`)}
        {row("total returned", `${s.returned.toFixed(3)} ◎`)}
        {row("plates bought", String(s.roundsPlayed))}
        {row(
          "plates in profit",
          `${s.roundsWon} · ${hitRate.toFixed(0)}%`,
        )}
        {row(
          "best multiple",
          s.bestMultiple > 0 ? `${s.bestMultiple.toFixed(2)}×` : "-",
          s.bestMultiple >= 2 ? "var(--color-gold)" : undefined,
        )}
      </div>

      <div className="label px-1.5 py-2 leading-relaxed">
        {snap.connected
          ? `${snap.online} online`
          : "offline · reconnecting"}
      </div>
    </div>
  );
}
