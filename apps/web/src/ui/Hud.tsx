import { useEffect, useRef, useState, type JSX } from "react";
import { DEFAULT_CONFIG, totalRake } from "@zinc/engine";
import type { AutoSettings, Snapshot } from "@/game/client";
import { setWalletOptIn, walletOptedIn } from "@/game/net";
import { shortAddress } from "@/game/names";
import { CharArt } from "./Chars";
import {
  getVolume,
  initAudio,
  isMuted,
  loadMutePreference,
  setMuted,
  setVolume,
} from "@/audio/sound";
import { crtOn, setCrt } from "./fx";

/** Flat icon button shared by the top bar's controls. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="rounded-sm px-2 py-1.5 text-[15px] leading-none text-[var(--color-dim)] hover:bg-[var(--color-panel2)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}

/**
 * Volume behind a popover instead of an always-visible slider.
 *
 * The inline slider was the thing pushing the top bar past the viewport on
 * mobile. The popover holds both controls — mute is one tap once it is open,
 * and the slider is still there so a player who finds the game slightly too
 * loud has a better option than silence. Both persist.
 */
export function VolumePopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  // Load the stored preferences BEFORE reading the level: initializers run
  // in order, and the old order captured the 0.7 default one line before
  // the saved volume was actually loaded into the module.
  const [muteFlag, setMuteFlag] = useState(() => loadMutePreference());
  const [level, setLevel] = useState(() => getVolume());
  const [crtFlag, setCrtFlag] = useState(() => crtOn());
  // One definition of "silent", used by the icon, the label and the toggle.
  // These were three different expressions, so the button could read "Unmute"
  // and mute, or show 🔊 over a game whose volume was zero.
  const silent = muteFlag || level === 0;

  return (
    <div className="relative">
      <IconButton
        label="Sound"
        onClick={() => {
          initAudio();
          setOpen((o) => !o);
        }}
      >
        {silent ? "\u{1F507}" : "\u{1F50A}"}
      </IconButton>

      {open && (
        <>
          {/* Click-away layer. Sits under the popover, over everything else. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-[196px] rounded-sm bg-[var(--color-panel2)] p-3 shadow-[0_8px_30px_rgba(0,0,0,0.55)]">
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => {
                  if (silent) {
                    // Restore audibility whichever way it was lost — flipping
                    // only the mute flag on a zero volume leaves the icon
                    // claiming sound while the game stays silent.
                    setMuted(false);
                    setMuteFlag(false);
                    if (level === 0) {
                      setVolume(0.7);
                      setLevel(0.7);
                    }
                  } else {
                    setMuted(true);
                    setMuteFlag(true);
                  }
                }}
                aria-label={silent ? "Unmute" : "Mute"}
                className="text-[15px] leading-none"
              >
                {silent ? "\u{1F507}" : "\u{1F50A}"}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={muteFlag ? 0 : level}
                aria-label="Volume"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  setLevel(v);
                  // Dragging above zero is an unmute in every product that has
                  // ever had a volume slider.
                  if (v > 0 && isMuted()) {
                    setMuted(false);
                    setMuteFlag(false);
                  }
                }}
                className="w-full accent-[var(--color-cyan)]"
              />
            </div>
            {/* Screen effects ride in the sound popover: it is the de facto
                settings surface, and one more icon in the top bar is chrome
                the design does not want. */}
            <div className="mt-3 flex items-center justify-between border-t border-[var(--color-line)] pt-2.5">
              <span className="label">crt screen</span>
              <button
                onClick={() => {
                  setCrt(!crtFlag);
                  setCrtFlag(!crtFlag);
                }}
                className={
                  crtFlag
                    ? "label rounded-sm bg-[var(--color-cyan)] px-2 py-1 font-bold text-[#03211f]"
                    : "chip label px-2 py-1"
                }
              >
                {crtFlag ? "on" : "off"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The slice of Phantom's injected API this button needs. */
type PhantomProvider = {
  isPhantom?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
};

function phantom(): PhantomProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

/**
 * Real Phantom connect, no wallet library: the extension injects its API into
 * the page.
 *
 * In networked play the label renders the SEAT the server reported, never
 * Phantom's connect state — the two can disagree, and when they did the
 * button showed a cyan address over a session the server had expired down to
 * a guest ledger. That mismatch now renders as an explicit "re-sign" state
 * whose click runs the signature ceremony again.
 */
export function WalletButton({
  seat,
  onChange,
}: {
  /** The server-reported seat identity; undefined in the local demo. */
  seat?: { guest: boolean; address: string };
  /** Called with true after an explicit connect, false after a disconnect. */
  onChange?: (connected: boolean) => void;
}): JSX.Element {
  const [addr, setAddr] = useState<string | null>(null);
  /* The way out is ASKED FOR, not offered. Disconnecting used to be a second
     press on the chip carrying your own address, which is a thing you have to
     be told; now that press reveals an explicit exit beside it, and pressing
     the address again puts it away. */
  const [showExit, setShowExit] = useState(false);

  // Reconnect silently ONLY for players who explicitly connected before.
  // Merely having Phantom installed must never start a wallet conversation:
  // everyone is a guest until they press this button.
  useEffect(() => {
    if (!walletOptedIn()) return;
    phantom()
      ?.connect({ onlyIfTrusted: true })
      .then((r) => setAddr(r.publicKey.toString()))
      .catch(() => {});
  }, []);

  // The seat is the truth when there is one; the demo falls back to Phantom.
  const seatAddr = seat && !seat.guest ? seat.address : null;
  const shown = seat ? seatAddr : addr;
  // Opted in, but the server seated a guest: the session token died and the
  // wallet needs one fresh signature to get its ledger back.
  const expired = seat !== undefined && seat.guest && walletOptedIn();

  const click = async (): Promise<void> => {
    const p = phantom();
    if (!p) {
      window.open("https://phantom.app", "_blank", "noopener");
      return;
    }
    if (shown) {
      setShowExit((v) => !v);
      return;
    }
    try {
      const r = await p.connect();
      // The address goes with the opt-in: every other world on this domain
      // reads it and is spared asking who you are all over again.
      setWalletOptIn(true, r.publicKey.toString());
      setAddr(r.publicKey.toString());
      onChange?.(true);
    } catch {
      // Player closed the Phantom prompt; nothing to do.
    }
  };

  const exit = async (): Promise<void> => {
    setShowExit(false);
    await phantom()?.disconnect().catch(() => {});
    // Disconnecting here disconnects everywhere: the seat and the opt-in both go.
    setWalletOptIn(false);
    setAddr(null);
    onChange?.(false);
  };

  // Connected and re-sign stay dark chips — they are status, not a call to
  // action. The one that IS a call to action is inverted to near-white, the
  // house treatment: crash.zinc.cash puts its only solid light element on
  // "CONNECT + SIGN IN" and nothing else on the page competes with it.
  const cta = !shown && !expired;
  return (
    <>
    <button
      onClick={click}
      className={
        cta
          ? "label flex items-center gap-1.5 rounded-sm bg-[var(--color-text)] px-2.5 py-1.5 font-semibold text-[var(--color-pit)] hover:brightness-95"
          : "chip label px-2.5 py-1.5"
      }
      style={shown ? { color: "var(--color-cyan)" } : expired ? { color: "var(--color-warn)" } : undefined}
    >
      {cta && (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="1.5"
            y="3.5"
            width="13"
            height="9.5"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M10.5 8.25h4" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )}
      {shown ? shortAddress(shown) : expired ? "re-sign" : "connect"}
    </button>
    {shown && showExit && (
      <button
        onClick={exit}
        className="chip label px-2.5 py-1.5"
        style={{ color: "var(--color-danger)" }}
        title="Disconnect this wallet from every ZINC world"
      >
        disconnect
      </button>
    )}
    </>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}): JSX.Element {
  return (
    <div className="text-right">
      <div className="label">{label}</div>
      <div className="tnum text-[13px] font-semibold" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

export function Stats({
  snap,
  mobile = false,
}: {
  snap: Snapshot;
  /**
   * The phone top row carries only what has nowhere better to live: the
   * wallet, with its money float. Session P/L moved into the stats tab —
   * "focus on gameplay" means the chrome above the lattice stays thin.
   */
  mobile?: boolean;
}): JSX.Element {
  // The round's own result floats over the wallet in the game's own colours,
  // profit green or danger red, once the round settles.
  const lastResultRound = useRef(0);
  const [gain, setGain] = useState<{ amt: number; key: number; color: string } | null>(null);
  useEffect(() => {
    if (snap.phase !== "result" || !snap.you.joined) return;
    if (snap.you.plates.total === 0 || lastResultRound.current === snap.roundId) return;
    lastResultRound.current = snap.roundId;
    const net = snap.you.balance - snap.you.plates.total * snap.entry;
    if (Math.abs(net) < 5e-5) return;
    setGain({
      amt: net,
      key: Date.now(),
      color: net >= 0 ? "var(--color-profit)" : "var(--color-danger)",
    });
  }, [snap.phase, snap.roundId, snap.you, snap.entry]);

  return (
    <>
      <div className="relative">
        <Stat label="wallet" value={`${snap.wallet.toFixed(3)} ◎`} color="var(--color-zinc-hi)" />
        {gain && (
          <span
            key={gain.key}
            className="gain-float tnum pointer-events-none absolute right-0 top-full z-10 mt-0.5 text-[11px] font-bold"
            style={{ color: gain.color }}
          >
            {gain.amt >= 0 ? "+" : ""}
            {gain.amt.toFixed(4)} ◎
          </span>
        )}
      </div>
      {!mobile && (
        <Stat
          label="session"
          value={`${snap.session >= 0 ? "+" : ""}${snap.session.toFixed(3)} ◎`}
          color={snap.session >= 0 ? "var(--color-profit)" : "var(--color-danger)"}
        />
      )}
    </>
  );
}

/**
 * Two jobs, two rows on mobile: identity and controls on the first, money on
 * the second. On desktop everything fits one row. The old single-row layout
 * overflowed a phone screen sideways and left dead space under the spill.
 */
export function TopBar({
  snap,
  onShowInfo,
  onShowChars,
  onWalletChange,
  onShowBank,
}: {
  snap: Snapshot;
  onShowInfo: () => void;
  onShowChars: () => void;
  /** Networked play authenticates at socket open, so a wallet that connects
      after that needs the handshake re-run or it stays seated as a guest.
      True = the player just connected (run the signature ceremony once). */
  onWalletChange?: (connected: boolean) => void;
  /** Present only when the server offers banking (real wallet, networked). */
  onShowBank?: () => void;
}): JSX.Element {
  return (
    <div className="border-b border-[var(--color-line)] px-3 py-2.5">
      <div className="flex items-center gap-3">
        {/* The house lockup: a filled tile carrying the product glyph, then
            the wordmark. crash.zinc.cash opens with exactly this shape, and
            two zinc.cash games that start their headers the same way are
            visibly the same company. The glyph is ours — a hex plate, not
            their crash ring. */}
        <span className="flex items-center gap-2">
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
        {/* Round 0 does not exist — the counter increments before the first
            lobby opens — so it must not be shown while still connecting. */}
        <div className="label">{snap.roundId > 0 ? `#${snap.roundId}` : "-"}</div>

        {/* Desktop: stats inline. */}
        <div className="ml-auto hidden items-center gap-4 sm:flex">
          <Stats snap={snap} />
        </div>

        <div className="flex items-center gap-1 sm:ml-1 max-sm:ml-auto">
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
          {/* An outlined RULES chip, the house affordance, instead of a bare
              glyph. A lone ⓘ in a row of six controls is the least-pressed
              thing on the page, and this is the screen that explains the
              odds. The word drops on phones, where the row cannot spare it. */}
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

      {/* Mobile: one thin money row. */}
      <div className="mt-1.5 flex items-center justify-between gap-3 sm:hidden">
        <Stats snap={snap} mobile />
      </div>
    </div>
  );
}

/**
 * Bustabit-style auto play: enter every round, extract at a target multiple.
 * The exit fires the tick the multiple crosses the target, banking whatever
 * the crossing value actually is: never under the target, sometimes above.
 */
export function AutoPanel({
  snap,
  onChange,
}: {
  snap: Snapshot;
  onChange: (patch: Partial<AutoSettings>) => void;
}): JSX.Element {
  const on = snap.auto.enabled;

  /*
   * The highest multiple this room can actually produce.
   *
   * The number only climbs when somebody DIES and their stake is released to
   * whoever is left; a voluntary exit takes its money out of the game. So the
   * ceiling is whatever is still in the pot, and in a quiet lobby it can sit
   * below the exit target — the shipped default of 2.00x is unreachable in a
   * four plate room, which does not fail loudly. Auto simply waits forever for
   * a number the round cannot reach, and rides every one of them into the ice.
   * Say so rather than let a player discover it a stake at a time.
   */
  const ceiling =
    snap.potInPlay > 0
      ? snap.potInPlay / snap.entry
      : snap.totalCount * (1 - totalRake(DEFAULT_CONFIG));
  const unreachable = ceiling > 0 && snap.auto.target > ceiling;
  // Typed text is held locally and only committed on blur or Enter. Feeding
  // every keystroke through a clamped round trip fought the keyboard: typing
  // "1.5" clamped "1" to 1.05 mid-entry and produced "1.055", and clearing the
  // field snapped it straight back.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const v = Number(draft);
    onChange({ target: Number.isFinite(v) && v > 0 ? v : snap.auto.target });
    setDraft(null);
  };

  return (
    <>
    <div className="flex items-center gap-2 px-2.5 py-2">
      <button
        onClick={() => onChange({ enabled: !on })}
        className={on ? "label rounded-sm px-2.5 py-1.5" : "chip label px-2.5 py-1.5"}
        style={
          on
            ? { background: "var(--color-cyan)", color: "#03211f", fontWeight: 700 }
            : undefined
        }
      >
        auto {on ? "on" : "off"}
      </button>
      <span className="label ml-auto">exit at</span>
      <input
        type="number"
        min={1.05}
        step={0.05}
        value={draft ?? snap.auto.target}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        aria-label="Auto exit target"
        className="field tnum w-[64px] px-1.5 py-1 text-right text-[13px] font-semibold text-[var(--color-text)]"
      />
      <span className="label">×</span>
      {/* How many plates each auto round buys. A select, not a stepper: five
          discrete values, and the whole range must be visible in one tap. */}
      <select
        value={snap.auto.plates}
        onChange={(e) => onChange({ plates: Number(e.target.value) })}
        aria-label="Auto plate count"
        className="field tnum px-1 py-1 text-[13px] font-semibold text-[var(--color-text)]"
      >
        {Array.from({ length: Math.max(1, snap.you.plates.max || 5) }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            ×{i + 1}
          </option>
        ))}
      </select>
    </div>
      {unreachable && (
        <div className="label px-2.5 pb-1.5 text-[var(--color-warn)]">
          this room tops out at {ceiling.toFixed(2)}×. auto will not fire.
        </div>
      )}
    </>
  );
}

export function ActionBar({
  snap,
  onJoin,
  onWalkOut,
  onStepOff,
  inline = false,
}: {
  snap: Snapshot;
  onJoin: () => void;
  onWalkOut: () => void;
  /** Lobby-only: refunds every plate and stands the player down. */
  onStepOff?: () => void;
  /** In-column placement (desktop) instead of the full-width bottom bar. */
  inline?: boolean;
}): JSX.Element {
  const secs = Math.ceil(snap.msToPhaseEnd / 1000);
  let label = "";
  let action: (() => void) | null = null;
  let tone = "idle";

  // A dropped socket silently discards every intent, so an enabled button here
  // takes the player's tap and does nothing at all — the worst possible
  // behaviour for the control that extracts their money.
  if (!snap.connected) {
    return wrap(
      <button
        disabled
        className="display h-13 w-full py-3.5 text-[17px] font-bold tracking-[0.1em] text-[var(--color-dim)]"
      >
        Reconnecting…
      </button>,
      inline,
    );
  }

  const k = snap.you.plates.total;
  if (snap.phase === "lobby") {
    if (!snap.you.joined) {
      if (snap.wallet < snap.entry) {
        // Both clients drop a join they cannot fund, and the server's refusal
        // reaches the browser as a console warning nobody sees. A full-colour
        // primary CTA that silently does nothing is the worst thing the money
        // button can do, so it says why instead.
        label = "Not enough balance";
      } else {
        label = `Bond in · ${snap.entry.toFixed(3)} ◎`;
        action = onJoin;
        tone = "go";
      }
    } else if (k < snap.you.plates.max && snap.wallet >= snap.entry) {
      // Multi-betting: the same button buys the next plate. EV per plate is
      // identical however many you hold — this buys breadth, not odds.
      label = `Bond another · ${snap.entry.toFixed(3)} ◎ (${k} in)`;
      action = onJoin;
      tone = "go";
    } else {
      label = `Bonded ×${k}, sealing in ${secs}s`;
    }
  } else if (snap.phase === "live") {
    if (snap.you.outcome === "in") {
      if (snap.grace) {
        // This same button was "bond another" half a second ago, so a player
        // still hammering it would extract at 0.95× before they can read.
        // Nothing can shatter during grace, so keeping extraction shut for
        // those ticks costs the player exactly nothing.
        const s = Math.max(
          1,
          Math.ceil((snap.graceRemaining * DEFAULT_CONFIG.timing.tickMs) / 1000),
        );
        label = `Extract unlocks in ${s}s`;
        tone = "lock";
      } else {
        // One press extracts every live plate at the shared multiple. The
        // multiple shown is blended across ALL your plates (dead ones count as
        // zero), so the button never advertises more than pressing it banks.
        label =
          k > 1
            ? `Extract ×${snap.you.plates.alive} · ${snap.you.multiple.toFixed(2)}×`
            : `Extract · ${snap.you.multiple.toFixed(2)}×`;
        action = onWalkOut;
        tone = "cash";
      }
    } else if (snap.you.outcome === "cashed") {
      label = `Banked ${snap.you.multiple.toFixed(2)}×`;
    } else if (snap.you.outcome === "dead") {
      label = k > 1 ? "All plates shattered" : "Plate shattered";
    } else {
      label = "Spectating";
    }
  } else {
    label = `Next round in ${secs}s`;
  }

  const bg =
    tone === "go"
      ? "bg-[var(--color-cyan)] text-[#03211f]"
      : tone === "cash"
        ? "bg-[var(--color-profit)] text-[#03231a]"
        : tone === "lock"
          ? "text-[var(--color-profit)]"
          : "text-[var(--color-dim)]";

  // The way out. A bonded player whose lobby never fills would otherwise be
  // locked in with no exit — nothing between "wait indefinitely" and closing
  // the tab. Refunds every plate, as if never bought. Sized and lit as a real
  // button: this is the un-bet control, and at label size in dim-on-panel it
  // read as a caption pinned to the screen edge, not a thing thumbs can hit.
  const stepOff =
    snap.phase === "lobby" && snap.you.joined && snap.connected && onStepOff ? (
      <button
        onClick={onStepOff}
        className="chip mt-1.5 w-full py-2.5 text-[12px] font-semibold tracking-[0.04em] text-[var(--color-warn)] transition-transform active:scale-[0.985]"
      >
        step off · refund {(k * snap.entry).toFixed(1)} ◎
      </button>
    ) : null;

  return wrap(
    <>
      <button
        disabled={!action}
        onClick={action ?? undefined}
        className={`display h-13 w-full rounded-sm py-3.5 text-[17px] font-bold tracking-[0.1em] transition-transform active:scale-[0.985] disabled:cursor-not-allowed ${bg}`}
      >
        {label}
      </button>
      {stepOff}
    </>,
    inline,
  );
}

/** Bottom bar on mobile, bare button in the desktop column. */
function wrap(button: JSX.Element, inline: boolean): JSX.Element {
  if (inline) return button;
  // Bottom padding clears the gesture bar on phones (safe-area inset when the
  // browser reports one, a floor of 14px when it does not) so the last button
  // never sits flush against the screen edge.
  return (
    <div className="bg-[var(--color-pit)]/95 px-3 pt-2.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] backdrop-blur">
      {button}
    </div>
  );
}
