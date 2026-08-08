import { type JSX } from "react";
import type { Snapshot } from "@/game/client";

/**
 * Your record.
 *
 * Every number here is an accumulated fact rather than a snapshot of the
 * moment: what you have staked in total, what has come back, and therefore
 * what the game has actually cost or paid you. In networked play these come
 * from the server's database, so they survive refreshes, reconnects and
 * restarts, and cannot be edited by the browser showing them.
 */
export function StatsPanel({ snap }: { snap: Snapshot }): JSX.Element {
  const s = snap.stats;
  // Jackpot wins are booked to the balance, never to `returned` — so this
  // panel used to leave them out of "net result" and RTP entirely while the
  // top bar's session counter included them. After a fire the two disagreed
  // by the whole pool, permanently. Counted here as their own line.
  const bonanzaWon = s.bonanzaWon ?? 0;
  const paid = s.returned + s.revEarned + bonanzaWon;
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
        {/* Return over everything ever staked. Converges on the advertised
            number over a long enough run and says nothing about a short one. */}
        <div className="label">{rtp.toFixed(1)}% returned on {s.wagered.toFixed(2)} ◎ wagered</div>
      </div>

      <div className="mt-1.5">
        {/* The phone top row dropped the session counter to stay thin, so
            this tab is where it lives — same number desktop shows up top. */}
        {row(
          "session p/l",
          `${snap.session >= 0 ? "+" : ""}${snap.session.toFixed(3)} ◎`,
          snap.session >= 0 ? "var(--color-profit)" : "var(--color-danger)",
        )}
        {row("total wagered", `${s.wagered.toFixed(3)} ◎`)}
        {row("total returned", `${s.returned.toFixed(3)} ◎`)}
        {row("rakeback earned", `+${s.revEarned.toFixed(4)} ◎`, "var(--color-cyan)")}
        {bonanzaWon > 0 &&
          row("bonanza won", `+${bonanzaWon.toFixed(3)} ◎`, "var(--color-gold)")}
        {/* Plates, not rounds: with multi-betting one round can hold several
            of your entries, and every counter here ticks once per plate. */}
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

      <div className="mt-1.5 border-t border-[var(--color-panel2)] pt-1.5">
        {row("bonanza tickets", snap.tickets.bonYours.toLocaleString(), "var(--color-gold)")}
        {row(
          "bonanza odds",
          snap.tickets.bonShare > 0 ? `${(snap.tickets.bonShare * 100).toFixed(2)}%` : "-",
        )}
        {row(
          "rev share slice",
          snap.tickets.revShare > 0 ? `${(snap.tickets.revShare * 100).toFixed(2)}%` : "-",
          "var(--color-cyan)",
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
