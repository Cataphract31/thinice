import { type JSX } from "react";
import type { Snapshot } from "@/game/client";
import { CharArt } from "@/ui/Chars";
import { Stats, VolumePopover, WalletButton } from "@/ui/Hud";

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

function FundsButton({ snap, onOpen }: { snap: Snapshot; onOpen: () => void }): JSX.Element | null {
  if (!snap.seat || snap.seat.guest) return null;
  const broke = snap.wallet < snap.entry;
  return (
    <button
      onClick={onOpen}
      title="deposit or withdraw"
      className={
        broke
          ? "label flex items-center gap-1.5 rounded-sm bg-[var(--color-cyan)] px-2.5 py-1.5 font-semibold text-[#03211f] hover:brightness-95"
          : "chip label flex items-center gap-1.5 px-2 py-1.5 text-[var(--color-cyan)]"
      }
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 2.4v7.2m0 0L5.2 6.9M8 9.6l2.8-2.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M2.8 12.4h10.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="max-sm:hidden">{broke ? "add funds" : "funds"}</span>
    </button>
  );
}

export function TopNav({
  snap,
  onShowInfo,
  onShowChars,
  onShowBank,
  onWalletChange,
}: {
  snap: Snapshot;
  onShowInfo: () => void;
  onShowChars: () => void;
  onShowBank: () => void;
  onWalletChange?: (connected: boolean, arcadeSeated?: boolean) => void;
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
        <FundsButton snap={snap} onOpen={onShowBank} />
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

      <div className="mt-1.5 flex items-center justify-between gap-3 sm:hidden">
        <Stats snap={snap} mobile onBank={seated(snap) ? onShowBank : undefined} />
      </div>
    </div>
  );
}

const seated = (snap: Snapshot): boolean => Boolean(snap.seat && !snap.seat.guest);

export function StateBar({
  snap,
  onShowBank,
}: {
  snap: Snapshot;
  onShowBank: () => void;
}): JSX.Element {
  return (
    <div className="shrink-0 border-b border-[var(--color-line)] max-sm:hidden">
      <div className="flex items-stretch">
        <div className="px-3.5 py-1.5">
          <div className="label">round</div>
          <div className="tnum mt-0.5 text-[15px] font-semibold">
            {snap.roundId > 0 ? `#${snap.roundId}` : "-"}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-5 border-l border-[var(--color-line-soft)] px-4 py-1.5">
          <Stats snap={snap} onBank={seated(snap) ? onShowBank : undefined} />
        </div>
      </div>
    </div>
  );
}

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
