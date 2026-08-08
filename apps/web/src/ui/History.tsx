import { type JSX } from "react";
import type { HistoryEntry, Snapshot } from "@/game/client";

/** Either client verifies rounds the same way: locally, from the seed. */
interface Verifier {
  verifyRound(roundId: number): void | Promise<void>;
}
import { CharArt } from "@/ui/Chars";

/**
 * Your past rounds, each one verifiable.
 *
 * Every round's seed is committed to (sha256) before it seals and revealed
 * when it ends. "Verify" replays the whole round from that seed right here in
 * the browser and checks both that the replay matches what you watched and
 * that the seed matches the hash published up front.
 */
export function HistoryPanel({
  snap,
  client,
}: {
  snap: Snapshot;
  client: Verifier;
}): JSX.Element {
  if (snap.history.length === 0) {
    return (
      /* Scrollable rather than vertically centred: on a phone this panel is
         short enough that a centred block simply hangs off both ends, which
         is why the commitment was arriving half cut off. */
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
    /* Padded past the top fade so the first block is never half-swallowed. */
    <div className="scroll-fade h-full overflow-y-auto pt-2.5">
      {/* Team dominance: all-time round wins per character. Fun data, zero
          stakes — the teams are cosmetic and every plate rolls the same odds.
          Label on its own line and the tally centred: as a single wrapping row
          it broke across two lines in the desktop rail and looked accidental. */}
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
          /* No verdict at all rather than a false one: without crypto.subtle
             (any insecure origin, e.g. testing over a LAN IP) the hash cannot
             be computed, and a round whose record will not parse cannot be
             replayed either. Calling an honest round a mismatch is the worst
             thing this panel could possibly say, so it says neither. */
          <span className="label ml-auto shrink-0 text-[var(--color-warn)]">
            unverifiable
          </span>
        ) : h.verified === null ? (
          <button
            onClick={onVerify}
            className="label ml-auto shrink-0 rounded-sm bg-[var(--color-panel2)] px-1.5 py-0.5 hover:text-[var(--color-text)]"
          >
            verify
          </button>
        ) : h.verified ? (
          <span className="label ml-auto shrink-0 text-[var(--color-profit)]">✓ fair</span>
        ) : (
          <span className="label ml-auto shrink-0 text-[var(--color-danger)]">✗ mismatch</span>
        )}
      </div>

      {/* The receipts. A bare "fair" verdict convinces nobody: show exactly
          what was recomputed and what it was checked against. */}
      {h.verified !== null && (
        <div className="mt-1 space-y-0.5 rounded-sm bg-[var(--color-panel2)]/60 p-1.5 text-[9.5px] leading-relaxed">
          <div
            style={{ color: h.seedOk ? "var(--color-profit)" : "var(--color-danger)" }}
          >
            {h.seedOk ? "✓" : "✗"} sha256(seed) matches the hash published before
            the round started
          </div>
          <div
            style={{ color: h.replayOk ? "var(--color-profit)" : "var(--color-danger)" }}
          >
            {h.replayOk ? "✓" : "✗"} re-ran all {h.ticks} ticks from the seed:{" "}
            {h.entrants} players, every elimination and payout identical
          </div>
          {/* Without this a round replays perfectly under rigged numbers and
              still reads "fair" — the other two checks only prove the operator
              is consistent with itself. Null on rounds played before the rules
              were folded into the commitment: there is nothing to check them
              against, and claiming otherwise would be the lie this panel
              exists to prevent. */}
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
          {/* Your own money. The three checks above prove the round was honest;
              this one proves the number you were actually paid is the number
              that round produced for your plate. */}
          {h.payoutOk !== null && (
            <div
              style={{ color: h.payoutOk ? "var(--color-profit)" : "var(--color-danger)" }}
            >
              {h.payoutOk ? "✓" : "✗"} your plate in the replay paid exactly what
              you were credited
            </div>
          )}
          {/* The jackpot draw runs on a stream derived from the same committed
              seed, so a fire is as checkable as an elimination. */}
          {h.bonanzaOk !== null && (
            <div
              style={{ color: h.bonanzaOk ? "var(--color-profit)" : "var(--color-danger)" }}
            >
              {h.bonanzaOk ? "✓" : "✗"} the bonanza draw came off the committed
              seed, not a number the house picked
            </div>
          )}
        </div>
      )}
    </div>
  );
}
