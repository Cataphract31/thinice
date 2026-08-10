import { useEffect, type JSX, type ReactNode } from "react";
import { DEFAULT_CONFIG, totalRake } from "@zinc/engine";

/**
 * Rules and odds, in as few words as they can be said.
 *
 * Every number on this page is read out of the live game config rather than
 * typed in — the rake moved mid-build once and four hardcoded copies went
 * stale silently. A rules page that disagrees with the engine reads as either
 * incompetence or a lie, and this is a product asking people for money.
 */

const C = DEFAULT_CONFIG;
const RAKE = totalRake(C);
const IN_GAME = 1 - RAKE;
const RTP = IN_GAME + C.rake.bonanza + C.rake.revShare;
const pc = (x: number, dp = 0): string => `${(x * 100).toFixed(dp)}%`;

export function InfoOverlay({
  onClose,
  onReplayIntro,
}: {
  onClose: () => void;
  onReplayIntro?: () => void;
}): JSX.Element {
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-[#04070a]/85 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className="h-fit w-full max-w-[640px] rounded-sm bg-[var(--color-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center gap-3 rounded-t-md bg-[var(--color-panel)] px-4 py-3">
          <span className="display text-[14px] tracking-[0.14em]">how it works</span>
          <span className="label ml-auto text-[var(--color-cyan)]">
            {pc(RTP)} back to players
          </span>
          {onReplayIntro && (
            <button
              onClick={onReplayIntro}
              className="label rounded-sm bg-[var(--color-panel2)] px-2 py-1 hover:text-[var(--color-text)]"
            >
              intro
            </button>
          )}
          <button
            onClick={onClose}
            className="label rounded-sm bg-[var(--color-panel2)] px-2 py-1 hover:text-[var(--color-text)]"
          >
            close
          </button>
        </div>

        <div className="space-y-5 px-4 pb-5 pt-1 text-[13.5px] leading-relaxed text-[var(--color-zinc-hi)]">
          <Section title="the game">
            <p>
              Everyone pays {C.entry} ◎ to step onto the ice. Every half second it
              can take someone, and everything they held is split between everyone
              still standing. Cash out whenever you like and keep what you hold.
              Get caught and you keep nothing.
            </p>
          </Section>

          <Section title="where the money goes">
            <Table
              rows={[
                [pc(IN_GAME), "the pot", "paid out every round"],
                [pc(C.rake.bonanza), "the bonanza", "jackpot, one winner takes all"],
                [pc(C.rake.revShare), "rakeback", "streamed to players forever"],
                [pc(C.rake.house), "platform fee", "the only real edge"],
              ]}
              foot={[pc(RTP), "returned to players", `${pc(C.rake.house)} platform fee`]}
            />
          </Section>

          <Section title="when should you leave?">
            <p>
              <strong className="text-[var(--color-text)]">Whenever you want. No
              timing is better than any other.</strong>{" "}
              Leaving early is a small win more often. Staying is a big win less
              often. The average is exactly the same, verified over 400,000
              simulated rounds.
            </p>
          </Section>

          <Section title="the bonanza">
            <p>
              Every entry earns the same {C.bonanza.ticketBase.toLocaleString()}{" "}
              bonanza tickets. About 1 round in{" "}
              {Math.round(1 / C.bonanza.fireProb).toLocaleString()}, the jackpot
              fires: one ticket holder takes the whole pool, and every ticket
              resets. More entries, better odds. No other way to farm it.
            </p>
          </Section>

          <Section title="rakeback">
            <p>
              {pc(C.rake.revShare)} of everything everyone bets is streamed to
              rakeback ticket holders. That includes rounds you skip, and it keeps
              paying after you stop playing. Your share slowly fades (
              {C.revShare.halfLifeDays}-day half-life), so active players always
              earn the most.
            </p>
          </Section>

          <Section title="provably fair">
            <p>
              Before every round starts, its dice are locked: a sha256 hash of the
              round's secret seed is published up front. When the round ends, the
              seed is revealed. Open the History tab to replay any of your past
              rounds against its seed and check that every result matches, right
              in your browser.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="display text-[12px] tracking-[0.14em] text-[var(--color-cyan)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Table({
  rows,
  foot,
}: {
  rows: [string, string, string][];
  foot: [string, string, string];
}): JSX.Element {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map(([a, b, c]) => (
          <tr key={b} className="border-t border-[var(--color-panel2)]">
            <td className="tnum w-[62px] py-1.5 font-semibold text-[var(--color-text)]">
              {a}
            </td>
            <td className="py-1.5 pr-3 text-[var(--color-text)]">{b}</td>
            <td className="py-1.5 text-right text-[var(--color-dim)]">{c}</td>
          </tr>
        ))}
        <tr className="border-t-2 border-[var(--color-edge2)]">
          <td className="tnum py-1.5 font-bold text-[var(--color-cyan)]">{foot[0]}</td>
          <td className="py-1.5 pr-3 font-semibold text-[var(--color-cyan)]">{foot[1]}</td>
          <td className="py-1.5 text-right text-[var(--color-dim)]">{foot[2]}</td>
        </tr>
      </tbody>
    </table>
  );
}
