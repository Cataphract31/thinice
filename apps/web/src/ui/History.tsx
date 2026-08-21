import { type JSX } from "react";
import type { HistoryEntry, Snapshot } from "@/game/client";

interface Verifier {
  verifyRound(roundId: number): void | Promise<void>;
}
import { CharArt } from "@/ui/Chars";

export function HistoryPanel({
  snap,
  client,
}: {
  snap: Snapshot;
  client: Verifier;
}): JSX.Element {
  if (snap.history.length === 0) {
    return (
      <div className="scroll-fade h-full overflow-y-auto px-2 pb-2 pt-3 text-center">
        <div className="label">no rounds yet</div>
        <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-dim)]">
          Every round is sealed to a sha256 hash before it starts. Finished
          rounds land here, and you can replay any of them.
        </div>
        {snap.nextCommit && (
          <div className="mt-2 rounded-sm bg-[var(--color-panel2)] p-2 text-left">
            <div className="label mb-1">next round commitment</div>
            <div className="tnum break-all text-[10px] text-[var(--color-dim)]">
              {snap.nextCommit}
            </div>
          </div>
        )}
      </div>
    );
  }

  const standings = Object.entries(snap.teamWins).sort((a, b) => b[1] - a[1]);

  return (
    <div className="scroll-fade h-full overflow-y-auto pt-2.5">
      {standings.length > 0 && (
        <div className="mx-1 rounded-sm bg-[var(--color-panel2)] p-1.5">
          <div className="label mb-1 text-center">team wins</div>
          <div className="flex items-center justify-center gap-2.5">
            {standings.slice(0, 5).map(([charId, wins]) => (
              <span key={charId} className="flex items-center gap-1">
                <CharArt charId={charId} pose="head" size={15} />
                <span className="tnum text-[10.5px] font-semibold">{wins}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {snap.nextCommit && (
        <div className="mx-1 mt-1 rounded-sm bg-[var(--color-panel2)] p-1.5">
          <span className="label">this round </span>
          <span className="tnum text-[10px] text-[var(--color-dim)]">
            {snap.nextCommit.slice(0, 18)}…
          </span>
        </div>
      )}
      {snap.history.map((h) => (
        <Row key={h.roundId} h={h} onVerify={() => void client.verifyRound(h.roundId)} />
      ))}
    </div>
  );
}

function Row({ h, onVerify }: { h: HistoryEntry; onVerify: () => void }): JSX.Element {
  const yourColor =
    h.yourOutcome === "cashed"
      ? (h.yourMultiple ?? 0) >= 1
        ? "var(--color-profit)"
        : "var(--color-warn)"
      : h.yourOutcome === "dead"
        ? "var(--color-danger)"
        : "var(--color-dim)";

  return (
    <div className="border-b border-[var(--color-panel2)] px-1.5 py-1.5 text-[11.5px]">
      <div className="flex items-center gap-2">
        <span className="tnum text-[var(--color-dim)]">#{h.roundId}</span>
        <span className="tnum" style={{ color: yourColor }}>
          {h.yourOutcome === "none"
            ? "sat out"
            : h.yourOutcome === "dead"
              ? "busted"
              : `${(h.yourMultiple ?? 0).toFixed(2)}×`}
        </span>
        <span className="label ml-auto">top {h.bestMultiple.toFixed(1)}×</span>
        <span className="label">{h.ticks}t</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className="tnum truncate text-[9.5px] text-[var(--color-dim)]"
          title={`commit ${h.commit} · seed ${h.seedHex}`}
        >
          {h.commit ? h.commit.slice(0, 14) : "no commit"}… / {h.seedHex}
        </span>
        {h.unavailable ? (
          <span className="label ml-auto shrink-0 text-[var(--color-warn)]">
            unverifiable
          </span>
        ) : h.verified === null && !h.checked && !h.unwitnessed ? (
          <button
            onClick={onVerify}
            className="label ml-auto shrink-0 rounded-sm bg-[var(--color-panel2)] px-1.5 py-0.5 hover:text-[var(--color-text)]"
          >
            verify
          </button>
        ) : h.verified === null ? (
          <span
            className="label ml-auto shrink-0 text-[var(--color-dim)]"
            title="this browser never saw this round's lobby, so its commitment could not be pinned before play"
          >
            {h.unwitnessed ? "not witnessed" : "unverifiable"}
          </span>
        ) : h.verified ? (
          <span className="label ml-auto shrink-0 text-[var(--color-profit)]">✓ fair</span>
        ) : (
          <span className="label ml-auto shrink-0 text-[var(--color-danger)]">✗ mismatch</span>
        )}
      </div>

      {h.checked && (
        <div className="mt-1 space-y-0.5 rounded-sm bg-[var(--color-panel2)]/60 p-1.5 text-[9.5px] leading-relaxed">
          {h.unwitnessed && (
            <div className="text-[var(--color-dim)]">
              · you were not here when this round's lobby opened, so its hash
              could not be pinned before play. The checks below prove internal
              consistency only.
            </div>
          )}
          {h.seedOk === null ? (
            <div className="text-[var(--color-dim)]">
              {h.unwitnessed || !h.commit
                ? "· commitment check unavailable"
                : "· no sealed seed to check: the lobby never sealed"}
            </div>
          ) : (
            <div style={{ color: h.seedOk ? "var(--color-profit)" : "var(--color-danger)" }}>
              {h.seedOk ? "✓" : "✗"} the revealed secret hashes to the commitment
              published before the round, and the seed derives from it
            </div>
          )}
          {h.replayOk === null ? (
            <div className="text-[var(--color-dim)]">
              · round interrupted: the seed was revealed, but the round never
              finished, so there is nothing to replay
            </div>
          ) : (
            <div
              style={{ color: h.replayOk ? "var(--color-profit)" : "var(--color-danger)" }}
            >
              {h.replayOk ? "✓" : "✗"} re-ran all {h.ticks} ticks from the seed:{" "}
              {h.entrants} players, every elimination and payout identical
            </div>
          )}
          {h.rulesOk === null ? (
            <div className="text-[var(--color-dim)]">
              · legacy round: its commitment covered the seed only, not the rules
            </div>
          ) : (
            <div
              style={{ color: h.rulesOk ? "var(--color-profit)" : "var(--color-danger)" }}
            >
              {h.rulesOk ? "✓" : "✗"} played under the published rules: same
              hazard curve, same rake, same payouts
            </div>
          )}
          {h.payoutOk !== null && (
            <div
              style={{ color: h.payoutOk ? "var(--color-profit)" : "var(--color-danger)" }}
            >
              {h.payoutOk ? "✓" : "✗"} your plate in the replay paid exactly what
              you were credited
            </div>
          )}
        </div>
      )}
    </div>
  );
}
