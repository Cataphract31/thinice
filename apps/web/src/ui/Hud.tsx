import { useEffect, useRef, useState, type JSX } from "react";
import { DEFAULT_CONFIG, totalRake } from "@zinc/engine";
import type { AutoSettings, Snapshot } from "@/game/client";
import { arcadeSignIn, arcadeToken, walletRoute, ArcadeError } from "@/game/arcade";
import { setWalletOptIn, walletCarried, walletOptedIn, walletSeated } from "@/game/net";
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

export function VolumePopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [muteFlag, setMuteFlag] = useState(() => loadMutePreference());
  const [level, setLevel] = useState(() => getVolume());
  const [crtFlag, setCrtFlag] = useState(() => crtOn());
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
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-[196px] rounded-sm bg-[var(--color-panel2)] p-3 shadow-[0_8px_30px_rgba(0,0,0,0.55)]">
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => {
                  if (silent) {
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
                  if (v > 0 && isMuted()) {
                    setMuted(false);
                    setMuteFlag(false);
                  }
                }}
                className="w-full accent-[var(--color-cyan)]"
              />
            </div>
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

export function WalletButton({
  seat,
  onChange,
}: {
  seat?: { guest: boolean; address: string };
  onChange?: (connected: boolean, arcadeSeated?: boolean) => void;
}): JSX.Element {
  const [addr, setAddr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showExit, setShowExit] = useState(false);

  useEffect(() => {
    if (!walletOptedIn() || !arcadeToken()) return;
    phantom()
      ?.connect({ onlyIfTrusted: true })
      .then((r) => setAddr(r.publicKey.toString()))
      .catch(() => {});
  }, []);

  const seatAddr = seat && !seat.guest ? seat.address : null;
  const shown = seat ? seatAddr : addr;
  const expired = seat !== undefined && seat.guest && walletSeated();
  const known = !shown && !expired && Boolean(walletCarried());

  const click = async (): Promise<void> => {
    if (shown) {
      setShowExit((v) => !v);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const address = await arcadeSignIn();
      setWalletOptIn(true, address);
      setAddr(address);
      onChange?.(true, Boolean(arcadeToken()));
    } catch (err) {
      const e = err as ArcadeError;
      if (e.code === "NO_WALLET" && walletRoute() === "desktop") {
        window.open("https://phantom.app", "_blank", "noopener");
      }
    } finally {
      setBusy(false);
    }
  };

  const exit = async (): Promise<void> => {
    setShowExit(false);
    await phantom()?.disconnect().catch(() => {});
    setWalletOptIn(false);
    setAddr(null);
    onChange?.(false);
  };

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
      {busy
        ? "check your wallet…"
        : shown
          ? shortAddress(shown)
          : expired
            ? "re-sign"
            : known
              ? "sign in"
              : "connect"}
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
  suffix,
}: {
  label: string;
  value: string;
  color?: string;
  suffix?: JSX.Element;
}): JSX.Element {
  return (
    <div className="text-right">
      <div className="label">{label}</div>
      <div className="tnum text-[13px] font-semibold" style={color ? { color } : undefined}>
        {value}
        {suffix}
      </div>
    </div>
  );
}

export function Stats({
  snap,
  mobile = false,
  onBank,
}: {
  snap: Snapshot;
  mobile?: boolean;
  onBank?: () => void;
}): JSX.Element {
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

  const walletStat = (
    <Stat
      label="wallet"
      value={`${snap.wallet.toFixed(3)} ◎`}
      color="var(--color-zinc-hi)"
      suffix={
        onBank ? (
          <span className="pl-1 text-[var(--color-cyan)]" aria-hidden="true">
            +
          </span>
        ) : undefined
      }
    />
  );

  return (
    <>
      <div className="relative">
        {onBank ? (
          <button
            onClick={onBank}
            aria-label="Deposit or withdraw"
            title="deposit or withdraw"
            className="chip -mr-1.5 block px-1.5 py-0.5"
          >
            {walletStat}
          </button>
        ) : (
          walletStat
        )}
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

export function TopBar({
  snap,
  onShowInfo,
  onShowChars,
  onWalletChange,
}: {
  snap: Snapshot;
  onShowInfo: () => void;
  onShowChars: () => void;
  onWalletChange?: (connected: boolean) => void;
}): JSX.Element {
  return (
    <div className="border-b border-[var(--color-line)] px-3 py-2.5">
      <div className="flex items-center gap-3">
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
        <div className="label">{snap.roundId > 0 ? `#${snap.roundId}` : "-"}</div>

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
        <Stats snap={snap} mobile />
      </div>
    </div>
  );
}

export function AutoPanel({
  snap,
  onChange,
}: {
  snap: Snapshot;
  onChange: (patch: Partial<AutoSettings>) => void;
}): JSX.Element {
  const on = snap.auto.enabled;

  const ceiling =
    snap.potInPlay > 0
      ? snap.potInPlay / snap.entry
      : snap.totalCount * (1 - totalRake(DEFAULT_CONFIG));
  const unreachable = ceiling > 0 && snap.auto.target > ceiling;
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
  onStepOff?: () => void;
  inline?: boolean;
}): JSX.Element {
  const secs = Math.ceil(snap.msToPhaseEnd / 1000);
  let label = "";
  let action: (() => void) | null = null;
  let tone = "idle";

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
        label = "Not enough balance";
      } else {
        label = `Bond in · ${snap.entry.toFixed(3)} ◎`;
        action = onJoin;
        tone = "go";
      }
    } else if (k < snap.you.plates.max && snap.wallet >= snap.entry) {
      label = `Bond another · ${snap.entry.toFixed(3)} ◎ (${k} in)`;
      action = onJoin;
      tone = "go";
    } else {
      label = `Bonded ×${k}, sealing in ${secs}s`;
    }
  } else if (snap.phase === "live") {
    if (snap.you.outcome === "in") {
      if (snap.grace) {
        const s = Math.max(
          1,
          Math.ceil((snap.graceRemaining * DEFAULT_CONFIG.timing.tickMs) / 1000),
        );
        label = `Extract unlocks in ${s}s`;
        tone = "lock";
      } else {
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

function wrap(button: JSX.Element, inline: boolean): JSX.Element {
  if (inline) return button;
  return (
    <div className="bg-[var(--color-pit)]/95 px-3 pt-2.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] backdrop-blur">
      {button}
    </div>
  );
}
