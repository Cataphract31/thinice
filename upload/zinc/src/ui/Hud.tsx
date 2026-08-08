import { useEffect, useRef, useState, type JSX } from "react";
import { DEFAULT_CONFIG } from "@zinc/engine";
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
      className="rounded-md px-2 py-1.5 text-[15px] leading-none text-[var(--color-dim)] hover:bg-[var(--color-panel2)] hover:text-[var(--color-text)]"
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
function VolumePopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(() => getVolume());
  const [muteFlag, setMuteFlag] = useState(() => loadMutePreference());
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
          <div className="absolute right-0 top-full z-50 mt-1.5 w-[196px] rounded-md bg-[var(--color-panel2)] p-3 shadow-[0_8px_30px_rgba(0,0,0,0.55)]">
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
 * the page. For now the connection only proves the flow and shows the address;
 * balances stay in the demo wallet until the server and program land.
 */
function WalletButton({
  onChange,
}: {
  /** Called with true after an explicit connect, false after a disconnect. */
  onChange?: (connected: boolean) => void;
}): JSX.Element {
  const [addr, setAddr] = useState<string | null>(null);

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

  const click = async (): Promise<void> => {
    const p = phantom();
    if (!p) {
      window.open("https://phantom.app", "_blank", "noopener");
      return;
    }
    if (addr) {
      await p.disconnect().catch(() => {});
      setWalletOptIn(false);
      setAddr(null);
      onChange?.(false);
      return;
    }
    try {
      const r = await p.connect();
      setWalletOptIn(true);
      setAddr(r.publicKey.toString());
      onChange?.(true);
    } catch {
      // Player closed the Phantom prompt; nothing to do.
    }
  };

  return (
    <button
      onClick={click}
      className="label rounded-sm bg-[var(--color-panel2)] px-2.5 py-1.5 hover:text-[var(--color-text)]"
      style={addr ? { color: "var(--color-cyan)" } : undefined}
    >
      {addr ? shortAddress(addr) : "connect"}
    </button>
  );
}

/**
 * Adaptive pool precision: a young pool grows by thousandths per round, and
 * at one decimal it sat frozen at "0.0" through its entire infancy — the one
 * number whose whole job is visibly growing.
 */
function poolDigits(pool: number): number {
  return pool < 1 ? 3 : pool < 100 ? 2 : 1;
}

/** 37,200 → "37.2k": phone-width numbers for counters that run long. */
function kfmt(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : n.toLocaleString();
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

/**
 * The tickets stat opens the standings: what your tickets are worth right now
 * in both economies. This is the demo's showcase that holding pays — the rev
 * slice streams to you every round whether you entered it or not.
 */
function TicketsStat({
  snap,
  compact = false,
}: {
  snap: Snapshot;
  /** Phone-width display: five-figure counters as 37.2k, not 37,200. */
  compact?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const t = snap.tickets;
  const pct = (x: number): string =>
    x > 0 && x < 0.0001 ? "<0.01%" : `${(x * 100).toFixed(2)}%`;
  const num = (n: number): string => (compact ? kfmt(n) : n.toLocaleString());

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="text-right">
        <div className="label">tickets</div>
        {/* Rev-share tickets never reset, so they run into five figures fast —
            grouped, or the number stops being readable. */}
        <div className="tnum text-[13px] font-semibold">
          <span className="text-[var(--color-gold)]">{num(snap.bonanzaTickets)}</span>
          <span className="text-[var(--color-dim)]"> / </span>
          <span className="text-[var(--color-cyan)]">{num(snap.revShareTickets)}</span>
        </div>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-[240px] rounded-md bg-[var(--color-panel2)] p-3 text-left shadow-[0_8px_30px_rgba(0,0,0,0.55)]">
            <div className="label text-[var(--color-gold)]">bonanza</div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="tnum text-[12px] font-semibold">
                {t.bonYours.toLocaleString()}
                <span className="text-[var(--color-dim)]">
                  {" "}
                  / {t.bonTotal.toLocaleString()}
                </span>
              </span>
              <span className="tnum text-[12px] font-bold text-[var(--color-gold)]">
                {pct(t.bonShare)}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="label">dry streak</span>
              <span className="tnum text-[12px] font-bold text-[var(--color-gold)]">
                {snap.bonanzaDrought.toLocaleString()} rounds
              </span>
            </div>
            <div className="mt-1 text-[10.5px] leading-snug text-[var(--color-dim)]">
              Fires about 1 round in{" "}
              {Math.round(1 / DEFAULT_CONFIG.bonanza.fireProb).toLocaleString()},
              same odds every round. Your share is your odds of taking the whole
              pool; all tickets wipe on a fire.
            </div>

            <div className="label mt-3 text-[var(--color-cyan)]">rev share</div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="label">your slice</span>
              <span className="tnum text-[12px] font-bold text-[var(--color-cyan)]">
                {pct(t.revShare)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="label">streamed to you</span>
              <span className="tnum text-[12px] font-bold text-[var(--color-profit)]">
                +{t.revStreamed.toFixed(4)} ◎
              </span>
            </div>
            <div className="mt-1 text-[10.5px] leading-snug text-[var(--color-dim)]">
              2% of every entry streams to ticket holders, paid every round, even
              rounds you sit out. Newer tickets weigh more.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stats({
  snap,
  mobile = false,
}: {
  snap: Snapshot;
  /**
   * The phone top row carries only what has nowhere better to live: the
   * wallet (with its money floats), the bonanza pool (whose bar is hidden
   * on phones), and the tickets pair. Session P/L moved into the stats tab
   * — "focus on gameplay" means the chrome above the lattice stays thin.
   */
  mobile?: boolean;
}): JSX.Element {
  // Two money moments float over the wallet, in the game's own colours.
  // The rakeback drip (cyan — the rev-share colour) lands at the SEAL, the
  // instant the rake is collected; the round's own result (profit green /
  // danger red) lands at the end. Separated on purpose: summed together the
  // drip was invisible next to a round swing two orders of magnitude bigger.
  const prevStreamed = useRef<number | null>(null);
  const lastResultRound = useRef(0);
  const [gain, setGain] = useState<{ amt: number; key: number; color: string } | null>(null);
  useEffect(() => {
    const cur = snap.tickets.revStreamed;
    // First observation is baseline, never a gain: on connect the counter
    // jumps from 0 to a lifetime total, and floating THAT would announce a
    // windfall nobody just received.
    if (prevStreamed.current !== null && cur - prevStreamed.current > 5e-5) {
      setGain({ amt: cur - prevStreamed.current, key: Date.now(), color: "var(--color-cyan)" });
    }
    prevStreamed.current = cur;
  }, [snap.tickets.revStreamed]);
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
      {mobile ? (
        <Stat
          label="bonanza"
          value={`${snap.bonanzaPool.toFixed(poolDigits(snap.bonanzaPool))} ◎`}
          color="var(--color-gold)"
        />
      ) : (
        <Stat
          label="session"
          value={`${snap.session >= 0 ? "+" : ""}${snap.session.toFixed(3)} ◎`}
          color={snap.session >= 0 ? "var(--color-profit)" : "var(--color-danger)"}
        />
      )}
      <TicketsStat snap={snap} compact={mobile} />
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
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="display text-[15px] font-bold tracking-[0.16em]">
          THIN<span className="text-[var(--color-cyan)]">ICE</span>
        </div>
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
            className="rounded-md p-1 hover:bg-[var(--color-panel2)]"
          >
            <CharArt charId={snap.charId} pose="head" size={22} />
          </button>
          {onShowBank && (
            <button
              onClick={onShowBank}
              className="label rounded-sm bg-[var(--color-panel2)] px-2.5 py-1.5 text-[var(--color-profit)] hover:text-[var(--color-text)]"
            >
              bank
            </button>
          )}
          <WalletButton onChange={onWalletChange} />
          <IconButton label="How it works" onClick={onShowInfo}>
            ⓘ
          </IconButton>
          <VolumePopover />
        </div>
      </div>

      {/* Mobile: one thin money row — wallet, bonanza pool, tickets. */}
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
    <div className="flex items-center gap-2 px-2.5 py-2">
      <button
        onClick={() => onChange({ enabled: !on })}
        className="label rounded-sm px-2.5 py-1.5"
        style={{
          background: on ? "var(--color-cyan)" : "var(--color-panel2)",
          color: on ? "#03211f" : undefined,
          fontWeight: on ? 700 : 500,
        }}
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
        className="tnum w-[64px] rounded-sm bg-[var(--color-panel2)] px-1.5 py-1 text-right text-[13px] font-semibold text-[var(--color-text)] outline-none focus:ring-1 focus:ring-[var(--color-cyan)]"
      />
      <span className="label">×</span>
      {/* How many plates each auto round buys. A select, not a stepper: five
          discrete values, and the whole range must be visible in one tap. */}
      <select
        value={snap.auto.plates}
        onChange={(e) => onChange({ plates: Number(e.target.value) })}
        aria-label="Auto plate count"
        className="tnum rounded-sm bg-[var(--color-panel2)] px-1 py-1 text-[13px] font-semibold text-[var(--color-text)] outline-none focus:ring-1 focus:ring-[var(--color-cyan)]"
      >
        {Array.from({ length: Math.max(1, snap.you.plates.max || 5) }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            ×{i + 1}
          </option>
        ))}
      </select>
    </div>
  );
}

export function BonanzaBar({ snap }: { snap: Snapshot }): JSX.Element {
  // Hidden on phones: there the pool lives as a stat in the top money row,
  // and this whole bar was a row of chrome between the player and the ice.
  const pool = snap.bonanzaPool;
  const digits = poolDigits(pool);
  return (
    <div className="breathe mx-3 flex items-center gap-3 rounded-sm bg-gradient-to-r from-[#1b1608] to-[#0f1319] px-3 py-1.5 max-sm:hidden">
      <span className="label text-[var(--color-gold)]">bonanza</span>
      <span className="tnum text-[17px] font-bold text-[var(--color-gold)]">
        {pool.toFixed(digits)} ◎
      </span>
      {/* The drought is the sales pitch: every dry round is one more the
          pool grew and one more it did not fire. Odds stay printed next to
          it so the number reads as chance, never as "due". */}
      <span className="label ml-auto hidden sm:inline">
        <span className="tnum text-[var(--color-gold)]">
          {snap.bonanzaDrought.toLocaleString()}
        </span>{" "}
        rounds dry · 1 in{" "}
        {Math.round(1 / DEFAULT_CONFIG.bonanza.fireProb).toLocaleString()} every
        round · one ticket takes all
      </span>
    </div>
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
        className="display h-13 w-full rounded-sm bg-[var(--color-panel2)] py-3.5 text-[17px] font-bold tracking-[0.1em] text-[var(--color-warn)]"
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
      // One press extracts every live plate at the shared multiple. The
      // multiple shown is blended across ALL your plates (dead ones count as
      // zero), so the button never advertises more than pressing it banks.
      label =
        k > 1
          ? `Extract ×${snap.you.plates.alive} · ${snap.you.multiple.toFixed(2)}×`
          : `Extract · ${snap.you.multiple.toFixed(2)}×`;
      action = onWalkOut;
      tone = "cash";
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
        : "bg-[var(--color-panel2)] text-[var(--color-dim)]";

  // The way out. A bonded player whose lobby never fills would otherwise be
  // locked in with no exit — nothing between "wait indefinitely" and closing
  // the tab. Refunds every plate, as if never bought. Sized and lit as a real
  // button: this is the un-bet control, and at label size in dim-on-panel it
  // read as a caption pinned to the screen edge, not a thing thumbs can hit.
  const stepOff =
    snap.phase === "lobby" && snap.you.joined && snap.connected && onStepOff ? (
      <button
        onClick={onStepOff}
        className="mt-1.5 w-full rounded-sm bg-[var(--color-panel2)] py-2.5 text-[12px] font-semibold tracking-[0.04em] text-[var(--color-warn)] transition-transform active:scale-[0.985]"
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
