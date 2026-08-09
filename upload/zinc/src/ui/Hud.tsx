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
  sfxExtract,
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
  // Load the stored preferences BEFORE reading the level: initializers run
  // in order, and the old order captured the 0.7 default one line before
  // the saved volume was actually loaded into the module.
  const [muteFlag, setMuteFlag] = useState(() => loadMutePreference());
  const [level, setLevel] = useState(() => getVolume());
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
 * the page.
 *
 * In networked play the label renders the SEAT the server reported, never
 * Phantom's connect state — the two can disagree, and when they did the
 * button showed a cyan address over a session the server had expired down to
 * a guest ledger. That mismatch now renders as an explicit "re-sign" state
 * whose click runs the signature ceremony again.
 */
function WalletButton({
  seat,
  onChange,
}: {
  /** The server-reported seat identity; undefined in the local demo. */
  seat?: { guest: boolean; address: string };
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
      style={
        shown
          ? { color: "var(--color-cyan)" }
          : expired
            ? { color: "var(--color-warn)" }
            : undefined
      }
    >
      {shown ? shortAddress(shown) : expired ? "re-sign" : "connect"}
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
              <span className="label">last hit</span>
              <span className="tnum text-[12px] font-bold text-[var(--color-gold)]">
                {snap.bonanzaDrought.toLocaleString()} rounds ago
              </span>
            </div>
            {/* No hit rows here: the jackpot window owns that list, on both
                widths. Two places showing the same receipts in two styles was
                the clutter, not the content. */}
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

function BonanzaStat({ snap }: { snap: Snapshot }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>
        <Stat
          label="bonanza"
          value={`${snap.bonanzaPool.toFixed(poolDigits(snap.bonanzaPool))} ◎`}
          color="var(--color-gold)"
        />
      </button>
      {open && <BonanzaOverlay snap={snap} onClose={() => setOpen(false)} />}
    </>
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
        // The bar is hidden at this width, so this stat is the phone's door
        // into the jackpot window — same window the bar opens, no second
        // design and no history rows crammed into the tickets popover.
        <BonanzaStat snap={snap} />
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
          <WalletButton seat={snap.seat} onChange={onWalletChange} />
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
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-3 max-sm:hidden">
      {/* The bar carries three things at three sizes and nothing else: what it
          is, what it holds, how long it has held it. The odds, the rules and
          the receipts all moved into the window this opens — they were a run-on
          sentence set in one type size, which is not a design. The whole bar is
          the affordance; there is no separate history control to find. */}
      <button
        onClick={() => setOpen(true)}
        title="Bonanza history"
        className="breathe flex w-full items-center gap-3 rounded-sm bg-gradient-to-r from-[#1b1608] to-[#0f1319] px-3 py-1.5 text-left hover:brightness-125"
      >
        <span className="label text-[var(--color-gold)]">bonanza</span>
        <span className="tnum text-[17px] font-bold text-[var(--color-gold)]">
          {pool.toFixed(digits)} ◎
        </span>
        {/* The drought is the sales pitch: every dry round is one more the pool
            grew and one more it did not fire. The odds live one click away so
            the number can never be read as "due" for long. */}
        <span className="ml-auto flex items-baseline gap-1.5">
          <span className="tnum text-[13px] font-semibold text-[var(--color-zinc-hi)]">
            {snap.bonanzaDrought.toLocaleString()}
          </span>
          <span className="label">rounds dry</span>
        </span>
      </button>

      {open && <BonanzaOverlay snap={snap} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The jackpot's own window: the pool, the terms, and every hit on record.
 *
 * A centred overlay rather than a popover hanging off the bar, because this is
 * the one screen that has to feel like money — a 240px dropdown of grey rows
 * cannot carry a jackpot, and the bar it hung from was already overloaded.
 */
function BonanzaOverlay({
  snap,
  onClose,
}: {
  snap: Snapshot;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const fires = snap.bonanzaFires ?? [];
  const share = snap.tickets.bonShare;
  const pct =
    share > 0 && share < 0.0001 ? "<0.01%" : `${(share * 100).toFixed(2)}%`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#04070a]/85 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="win-slam w-full max-w-[400px] rounded-md bg-[var(--color-panel)] shadow-[0_24px_90px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pt-3">
          <span className="display text-[13px] tracking-[0.14em] text-[var(--color-gold)]">
            the bonanza
          </span>
          <button
            onClick={onClose}
            className="label ml-auto rounded-sm bg-[var(--color-panel2)] px-2 py-1 hover:text-[var(--color-text)]"
          >
            close
          </button>
        </div>

        {/* The pool, alone and enormous. Everything else on this screen is a
            caption to it. */}
        <div className="px-4 pb-4 pt-5 text-center">
          <div className="tnum text-[40px] font-bold leading-none text-[var(--color-gold)] [text-shadow:0_0_30px_rgba(255,196,64,0.35)]">
            {snap.bonanzaPool.toFixed(poolDigits(snap.bonanzaPool))} ◎
          </div>
          <div className="label mt-2">in the pool right now</div>
        </div>

        <div className="mx-4 space-y-1.5 rounded-sm bg-[var(--color-panel2)] px-3 py-2.5">
          <Line label="odds">
            1 in {Math.round(1 / DEFAULT_CONFIG.bonanza.fireProb).toLocaleString()}, every
            round
          </Line>
          <Line label="dry for">
            <span className="tnum">{snap.bonanzaDrought.toLocaleString()}</span> rounds
          </Line>
          <Line label="your share" gold>
            {pct}
          </Line>
        </div>

        <div className="label px-4 pb-1 pt-4">previous hits</div>
        <div className="max-h-[196px] overflow-y-auto px-4">
          {fires.length === 0 ? (
            <div className="pb-1 text-[12px] leading-snug text-[var(--color-dim)]">
              Nothing on record yet. Every dry round grows the pool.
            </div>
          ) : (
            fires.slice(0, 12).map((f) => (
              <div key={f.round} className="flex items-center gap-2 py-1">
                <CharArt charId={f.charId} pose="head" size={20} />
                <span
                  className="truncate text-[12.5px] font-semibold"
                  style={f.name === "YOU" ? { color: "var(--color-cyan)" } : undefined}
                >
                  {f.name}
                </span>
                <span className="label">#{f.round.toLocaleString()}</span>
                <span className="tnum ml-auto text-[13px] font-bold text-[var(--color-gold)]">
                  {f.sol.toFixed(2)} ◎
                </span>
                <span className="label w-[28px] text-right">{ago(Date.now() - f.at)}</span>
              </div>
            ))
          )}
        </div>

        <div className="px-4 pb-4 pt-3 text-[11.5px] leading-snug text-[var(--color-dim)]">
          One ticket takes the whole pool. Every plate buys{" "}
          {DEFAULT_CONFIG.bonanza.ticketBase} of them, and a fire wipes every ticket
          in circulation.
        </div>
      </div>
    </div>
  );
}

/** A caption and its value, the two type sizes this window is built from. */
function Line({
  label,
  gold = false,
  children,
}: {
  label: string;
  gold?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <span className="label">{label}</span>
      <span
        className="text-[12.5px] font-semibold"
        style={gold ? { color: "var(--color-gold)" } : undefined}
      >
        {children}
      </span>
    </div>
  );
}

/** How long ago, in the shortest spelling that still reads. */
function ago(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * The welcome-back card: an idle game's "while you were away" screen for the
 * rev-share stream. One-shot, full takeover, big gold number counting up,
 * one COLLECT button. This is the whole pitch made into a dopamine moment —
 * your tickets earned while the tab was closed, here are the receipts.
 */
export function AwayRecap({ snap }: { snap: Snapshot }): JSX.Element | null {
  const away = snap.away ?? null;
  const [shown, setShown] = useState<{ ms: number; sol: number } | null>(null);
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!away || away.sol <= 0) return;
    setShown(away);
  }, [away]);
  // The count-up IS the dopamine: the number climbs to its total with a
  // fast start and a soft landing, like a payout being counted out.
  useEffect(() => {
    if (!shown) return;
    setVal(0);
    const t0 = performance.now();
    const dur = 1700;
    let raf = 0;
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0 - 350) / dur);
      if (k > 0) setVal(shown.sol * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [shown]);
  if (!shown) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="win-slam w-[340px] max-w-full rounded-md bg-[var(--color-pit)] p-6 text-center shadow-[0_16px_60px_rgba(0,0,0,0.7)]">
        <div className="label text-[var(--color-cyan)]">the stream never sleeps</div>
        <h2 className="display mt-1.5 text-[19px] font-bold tracking-[0.16em]">
          WHILE YOU WERE AWAY
        </h2>
        <div className="label mt-1">gone {ago(shown.ms)}</div>

        <div className="breathe tnum mt-5 text-[40px] font-bold leading-none text-[var(--color-gold)]">
          +{val.toFixed(4)} <span className="text-[24px]">◎</span>
        </div>
        <div className="label mt-1.5">rakeback streamed into your wallet</div>

        <div className="mt-4 text-[12px] text-[var(--color-dim)]">
          every sealed round pays your tickets their cut, awake or not
        </div>

        <button
          onClick={() => {
            initAudio();
            sfxExtract();
            setShown(null);
          }}
          className="display mt-5 w-full rounded-sm bg-[var(--color-gold)] py-3 text-[15px] font-bold tracking-[0.12em] text-[#241a05] transition-transform active:scale-[0.985]"
        >
          COLLECT
        </button>
      </div>
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
          ? "bg-[var(--color-panel2)] text-[var(--color-profit)]"
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
