import { type JSX } from "react";
import type { Snapshot } from "@/game/client";
import { CharArt } from "@/ui/Chars";
import { Stats, VolumePopover, WalletButton } from "@/ui/Hud";

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
          className="rounded-sm p-1 hover:bg-[var(--color-panel2)]"
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
 * in, what you hold, what the session has done, reads left to right on a
 * single baseline, scored by hairlines the way the lobby scores its arena
 * cards. The old layout printed the same facts in three different bands, in
 * three different alignments, at the same type size as the footer's legal
 * links.
 */
export function StateBar({ snap }: { snap: Snapshot }): JSX.Element {
  return (
    <div className="shrink-0 border-b border-[var(--color-line)] max-sm:hidden">
      <div className="flex items-stretch">
        <div className="px-3.5 py-1.5">
          <div className="label">round</div>
          <div className="tnum mt-0.5 text-[15px] font-semibold">
            {snap.roundId > 0 ? `#${snap.roundId}` : "-"}
          </div>
        </div>

        {/* Wallet and session keep their own component: the wallet float
            animation lives inside it. */}
        <div className="ml-auto flex items-center gap-5 border-l border-[var(--color-line-soft)] px-4 py-1.5">
          <Stats snap={snap} />
        </div>
      </div>
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

/**
 * Connection lost, said once and plainly.
 *
 * The only tell used to be the word "Reconnecting" on a disabled button at the
 * very bottom of the screen, while everything above it kept rendering the last
 * snapshot: a multiplier, a bonded count, a seal countdown, a wallet balance.
 * All of it stale, none of it labelled as such. On a product where people have
 * money on the table, "is this frozen or is my stake gone" is the one question
 * the screen must never leave open.
 */
export function OfflineBar({ snap }: { snap: Snapshot }): JSX.Element | null {
  if (snap.connected) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5"
    >
      <span
        aria-hidden="true"
        className="breathe inline-block h-[6px] w-[6px] shrink-0 rounded-full"
        style={{ background: "var(--color-warn)" }}
      />
      <span className="label text-[var(--color-warn)]">connection lost</span>
      <span className="label">
        reconnecting. nothing below is live, and no round can take your stake
        while this shows.
      </span>
    </div>
  );
}
