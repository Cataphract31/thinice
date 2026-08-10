import { useState, type JSX } from "react";
import type { Snapshot } from "@/game/client";
import { CharArt } from "@/ui/Chars";
import {
  BonanzaOverlay,
  Stats,
  VolumePopover,
  WalletButton,
  poolDigits,
} from "@/ui/Hud";

/**
 * The house family, with the accent each arena wears on the lobby.
 *
 * crash.zinc.cash colours every game and then repeats that colour on the
 * card, the play dot and the enter strip. Carrying the same dots here is what
 * turns four links into a navbar: a player reads "four tables, I am on the
 * cyan one" before reading a single word.
 */
const ARENAS = [
  { name: "classic", href: "https://crash.zinc.cash/play/classic", dot: "#c9e84f" },
  {
    name: "last man standing",
    href: "https://crash.zinc.cash/play/last-man-standing",
    dot: "#ff5a3c",
  },
  { name: "no pain no gain", href: "https://crash.zinc.cash/play/no-pain-no-gain", dot: "#3ba9e8" },
] as const;

function Dot({ color }: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

/**
 * Row one: who we are, which table you are at, and your account. Nothing that
 * changes tick to tick lives here, which is the whole reason it can be read
 * at a glance and then ignored for an hour.
 */
export function TopNav({
  snap,
  onShowInfo,
  onShowChars,
  onWalletChange,
  onShowBank,
}: {
  snap: Snapshot;
  onShowInfo: () => void;
  onShowChars: () => void;
  onWalletChange?: (connected: boolean) => void;
  onShowBank?: () => void;
}): JSX.Element {
  return (
    <div className="shrink-0 border-b border-[var(--color-line)] px-3 py-2">
    <div className="flex items-center gap-4">
      <span className="flex shrink-0 items-center gap-2">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="var(--color-cyan)" />
          <path
            d="M12 5.4l5.2 3v7.2l-5.2 3-5.2-3V8.4z"
            fill="none"
            stroke="var(--color-pit)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
        <span className="display text-[15px] font-bold tracking-[0.16em]">
          THIN<span className="text-[var(--color-cyan)]">ICE</span>
        </span>
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          onClick={onShowChars}
          aria-label="Choose character"
          className="rounded-md p-1 hover:bg-[var(--color-panel2)]"
        >
          <CharArt charId={snap.charId} pose="head" size={22} />
        </button>
        {onShowBank && (
          <button
            onClick={onShowBank}
            className="chip label px-2.5 py-1.5 text-[var(--color-profit)]"
          >
            bank
          </button>
        )}
        <WalletButton seat={snap.seat} onChange={onWalletChange} />
        <button
          onClick={onShowInfo}
          aria-label="How it works"
          className="chip label flex items-center gap-1.5 px-2 py-1.5"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7.1v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
          </svg>
          <span className="max-sm:hidden">rules</span>
        </button>
        <VolumePopover />
      </div>
    </div>

      {/* Phones have no room for a state band, so the money keeps its thin
          row here, exactly as before. */}
      <div className="mt-1.5 flex items-center justify-between gap-3 sm:hidden">
        <Stats snap={snap} mobile />
      </div>
    </div>
  );
}

/**
 * Row two: the state display, as one instrument instead of four scattered
 * readouts. Everything the house owes you at this moment, the round you are
 * in, what you hold, what the session has done, what the jackpot has grown
 * to, reads left to right on a single baseline, scored by hairlines the way
 * the lobby scores its arena cards. The old layout printed the same facts in
 * three different bands, in three different alignments, at the same type size
 * as the footer's legal links.
 */
export function StateBar({ snap }: { snap: Snapshot }): JSX.Element {
  const [open, setOpen] = useState(false);
  const pool = snap.bonanzaPool;

  return (
    <div className="shrink-0 border-b border-[var(--color-line)] max-sm:hidden">
      <div className="flex items-stretch">
        <div className="px-3.5 py-1.5">
          <div className="label">round</div>
          <div className="tnum mt-0.5 text-[15px] font-semibold">
            {snap.roundId > 0 ? `#${snap.roundId}` : "-"}
          </div>
        </div>

        {/* Wallet, session and tickets keep their own component: the wallet
            float animation and the ticket popover both live inside it. */}
        <div className="flex items-center gap-5 border-l border-[var(--color-line)] px-3.5 py-1.5">
          <Stats snap={snap} />
        </div>

        {/* The jackpot ends the band rather than owning a gradient strip of
            its own. It is one number among the house's numbers until it is
            not, and when it fires the overlay is the whole screen anyway. */}
        <button
          onClick={() => setOpen(true)}
          title="Bonanza history"
          className="ml-auto flex items-center gap-5 border-l border-[var(--color-line)] px-3.5 py-1.5 hover:bg-[var(--color-panel2)]"
        >
          <span className="text-right">
            <span className="label block text-[var(--color-gold)]">bonanza</span>
            <span className="breathe tnum mt-0.5 block text-[17px] font-bold text-[var(--color-gold)]">
              {pool.toFixed(poolDigits(pool))} ◎
            </span>
          </span>
          <span className="text-right">
            {/* Counted in rounds, and the unit is left implicit: the figure
                beside it is a jackpot, so "last hit 20" can only mean rounds.
                The window this opens spells it out for anyone who wonders. */}
            <span className="label block">last hit</span>
            <span className="tnum mt-0.5 block text-[13px] font-semibold text-[var(--color-zinc-hi)]">
              {snap.bonanzaDrought.toLocaleString()}
            </span>
          </span>
        </button>
      </div>
      {open && <BonanzaOverlay snap={snap} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The family bar stays in the footer, where crash.zinc.cash carries its own,
 * but it stops being indistinguishable from the legal links beside it. Each
 * arena wears the colour the lobby gives it, and the table you are standing
 * on is not a link at all: it is the lit one. A row of coloured dots reads as
 * a switcher at a glance; four grey words in a row of grey words did not.
 */
export function SlimFooter({ onShowInfo }: { onShowInfo: () => void }): JSX.Element {
  return (
    <footer className="relative hidden shrink-0 items-center justify-between border-t border-[var(--color-line)] px-3 py-2 lg:flex">
      <span className="display text-[12px] font-bold tracking-[0.16em]">
        THIN<span className="text-[var(--color-cyan)]">ICE</span>
      </span>

      <nav className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        {ARENAS.map((a) => (
          <a
            key={a.name}
            href={a.href}
            target="_blank"
            rel="noreferrer"
            className="label flex items-center gap-1.5 rounded-sm px-2.5 py-1 hover:bg-[var(--color-panel2)] hover:text-[var(--color-text)]"
          >
            <Dot color={a.dot} />
            {a.name}
          </a>
        ))}
        <span className="label flex items-center gap-1.5 rounded-sm bg-[var(--color-panel2)] px-2.5 py-1 text-[var(--color-text)]">
          <Dot color="var(--color-cyan)" />
          thin ice
        </span>
      </nav>

      <span className="label flex items-center gap-4">
        <button onClick={onShowInfo} className="label hover:text-[var(--color-text)]">
          provably fair
        </button>
        <a
          href="https://zinc.cash"
          target="_blank"
          rel="noreferrer"
          className="hover:text-[var(--color-text)]"
        >
          zinc.cash
        </a>
      </span>
    </footer>
  );
}
