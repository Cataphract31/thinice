import { useEffect, useRef, useState, type JSX } from "react";
import type { PlayerView, Snapshot } from "@/game/client";
import { getClient } from "@/game/session";
import { Shaft } from "@/ui/Shaft";
import { Multiplier } from "@/ui/Multiplier";
import { Roster } from "@/ui/Ledger";
import { HistoryPanel } from "@/ui/History";
import { StatsPanel } from "@/ui/Stats";
import { TickRing } from "@/ui/TickRing";
import { ActionBar, AutoPanel } from "@/ui/Hud";
import { OfflineBar, SlimFooter, StateBar, TopNav } from "@/ui/Chrome";
import { InfoOverlay } from "@/ui/Info";
import { BankOverlay } from "@/ui/Bank";
import { Tutorial, tutorialSeen } from "@/ui/Tutorial";
import { CharArt, CharSelect, ShatterCard, WinnerOverlay } from "@/ui/Chars";
import { ChatPanel } from "@/ui/Chat";
import { initAudio, sfxTvOff, sfxTvOn } from "@/audio/sound";
import { crtOn, onCrtChange } from "@/ui/fx";
import { riskBand } from "@/game/risk";
import { charById, initCharAssets } from "@/game/chars";
import { DEFAULT_CONFIG } from "@zinc/engine";

const TICK_MS = DEFAULT_CONFIG.timing.tickMs;

type Tab = "roster" | "history" | "stats" | "chat";

export default function App(): JSX.Element {
  const client = getClient();
  const [snap, setSnap] = useState<Snapshot>(() => client.snapshot());
  const [selected, setSelected] = useState<{ roundId: number; id: number } | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showIntro, setShowIntro] = useState(
    () => !tutorialSeen() || new URLSearchParams(window.location.search).has("intro"),
  );
  const [showChars, setShowChars] = useState(false);
  const [showBank, setShowBank] = useState(false);
  const [tab, setTab] = useState<Tab>("roster");
  const [panelOpen, setPanelOpen] = useState(true);
  const [crt, setCrtState] = useState(() => crtOn());
  useEffect(() => onCrtChange(setCrtState), []);

  useEffect(() => {
    const moved = (): void => client.sync();
    window.addEventListener("zinc:balance", moved);
    return () => window.removeEventListener("zinc:balance", moved);
  }, [client]);

  const [tv, setTv] = useState<"off" | "on" | null>(null);
  const prevPhase = useRef(snap.phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = snap.phase;
    if (!crt || !(was === "result" && snap.phase === "lobby")) {
      setTv((t) => (t === null ? t : null));
      return;
    }
    setTv("off");
    sfxTvOff();
    const t1 = setTimeout(() => {
      setTv("on");
      sfxTvOn();
    }, 240);
    const t2 = setTimeout(() => setTv(null), 700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [snap.phase, crt]);

  useEffect(() => client.subscribe(setSnap), [client]);
  useEffect(() => initCharAssets(), []);

  useEffect(() => {
    const arm = (): void => initAudio();
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);

  const chosen =
    selected && selected.roundId === snap.roundId
      ? (snap.players.find((p) => p.id === selected.id) ?? null)
      : null;
  const select = (id: number | null): void =>
    setSelected(id === null ? null : { roundId: snap.roundId, id });

  const deskTab = tab === "chat" ? "roster" : tab;

  return (
    <div className="mx-auto flex h-full max-w-[1180px] flex-col">
      <TopNav
        snap={snap}
        onShowInfo={() => setShowInfo(true)}
        onShowChars={() => setShowChars(true)}
        onShowBank={() => setShowBank(true)}
        onWalletChange={(connected, arcadeSeated) =>
          connected ? client.reauth(!arcadeSeated) : client.logout()
        }
      />
      <OfflineBar snap={snap} />
      <StateBar snap={snap} onShowBank={() => setShowBank(true)} />

      <div className="mt-1.5 flex min-h-0 flex-1 gap-2 px-1.5 lg:px-3">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="mb-1.5 flex shrink-0 items-stretch gap-2">
            <TickRing snap={snap} tickMs={TICK_MS} />
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <Multiplier snap={snap} />
            </div>
            <AliveCard snap={snap} />
          </div>

          <div
            className={`relative min-h-0 flex-1 overflow-hidden ${crt ? "crt-tube" : ""} ${
              tv === "off" ? "tv-off" : tv === "on" ? "tv-on" : ""
            }`}
          >
            <div className="bleed absolute inset-0">
              <Shaft snap={snap} onSelectCell={select} />
              {crt && <CrtLayer snap={snap} />}
            </div>

            {chosen && (
              <PlayerCard
                p={chosen}
                entry={snap.entry}
                onClose={() => select(null)}
              />
            )}

            <ShatterCard snap={snap} />
            <WinnerOverlay snap={snap} />
          </div>
        </div>

        <aside className="hidden w-[286px] shrink-0 border-l border-[var(--color-line-soft)] pl-3 lg:flex lg:flex-col lg:gap-1.5">
          <ActionBar
            inline
            snap={snap}
            onJoin={() => client.join()}
            onWalkOut={() => client.walkOut()}
            onStepOff={() => client.stepOff()}
          />
          <AutoPanel snap={snap} onChange={(p) => client.setAuto(p)} />
          <div className="min-h-0 flex-[1.15]">
            <TabbedPanel snap={snap} tab={deskTab} onTab={setTab}>
              {deskTab === "roster" ? (
                <Roster snap={snap} onSelect={select} />
              ) : deskTab === "history" ? (
                <HistoryPanel snap={snap} client={client} />
              ) : (
                <StatsPanel snap={snap} />
              )}
            </TabbedPanel>
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel snap={snap} client={client} onSelect={select} />
          </div>
        </aside>
      </div>

      <div className={`mt-1 shrink-0 px-1.5 lg:hidden ${panelOpen ? "h-[124px]" : ""}`}>
        <TabbedPanel
          snap={snap}
          tab={tab}
          onTab={(t) => {
            setTab(t);
            setPanelOpen(true);
          }}
          chat
          open={panelOpen}
          onToggleOpen={() => setPanelOpen((o) => !o)}
        >
          {tab === "roster" ? (
            <Roster snap={snap} onSelect={select} />
          ) : tab === "history" ? (
            <HistoryPanel snap={snap} client={client} />
          ) : tab === "stats" ? (
            <StatsPanel snap={snap} />
          ) : (
            <ChatPanel snap={snap} client={client} bare onSelect={select} />
          )}
        </TabbedPanel>
      </div>

      {showInfo && (
        <InfoOverlay
          onClose={() => setShowInfo(false)}
          onReplayIntro={() => {
            setShowInfo(false);
            setShowIntro(true);
          }}
        />
      )}
      {showIntro && (
        <Tutorial
          onClose={() => setShowIntro(false)}
          onShowInfo={() => setShowInfo(true)}
        />
      )}
      {showBank && (
        <BankOverlay
          onClose={() => setShowBank(false)}
          onBalanceMoved={() => client.sync()}
          onSignedIn={() => client.reauth()}
        />
      )}
      {showChars && (
        <CharSelect
          snap={snap}
          onPick={(id) => client.setCharacter(id)}
          onClose={() => setShowChars(false)}
        />
      )}

      <div className="lg:hidden">
        <div className="px-3 pb-1">
          <AutoPanel snap={snap} onChange={(p) => client.setAuto(p)} />
        </div>
        <ActionBar
          snap={snap}
          onJoin={() => client.join()}
          onWalkOut={() => client.walkOut()}
          onStepOff={() => client.stepOff()}
        />
      </div>

      <SlimFooter onShowInfo={() => setShowInfo(true)} />
    </div>
  );
}

function CrtLayer({ snap }: { snap: Snapshot }): JSX.Element {
  const lines = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = lines.current;
    if (!c) return;
    const draw = (): void => {
      const host = c.parentElement;
      if (!host) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const x = c.getContext("2d");
      if (!x) return;
      x.scale(dpr, dpr);
      x.strokeStyle = "rgba(0, 0, 0, 0.22)";
      x.lineWidth = 1;
      const bow = Math.min(9, h * 0.018);
      for (let y = 1.5; y < h; y += 3) {
        const v = (y / h) * 2 - 1;
        x.beginPath();
        x.moveTo(0, y);
        x.quadraticCurveTo(w / 2, y + 2 * v * bow, w, y);
        x.stroke();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (c.parentElement) ro.observe(c.parentElement);
    return () => ro.disconnect();
  }, []);

  const [glitch, setGlitch] = useState<{ key: number; top: number } | null>(null);
  const prevDead = useRef(-1);
  useEffect(() => {
    if (prevDead.current >= 0 && snap.deadCount > prevDead.current) {
      setGlitch({ key: Date.now(), top: 10 + ((Date.now() / 7) % 70) });
    }
    prevDead.current = snap.deadCount;
  }, [snap.deadCount]);
  useEffect(() => {
    if (!glitch) return;
    const t = setTimeout(() => setGlitch(null), 300);
    return () => clearTimeout(t);
  }, [glitch]);

  const band = riskBand(snap.hazard, snap.grace);
  const jit =
    snap.phase === "live" ? (band === "critical" ? "crt-jit2" : band === "stressed" ? "crt-jit1" : "") : "";

  return (
    <div
      className={`crt-flicker pointer-events-none absolute inset-0 overflow-hidden ${jit} ${
        glitch ? "crt-glitching" : ""
      }`}
    >
      <canvas ref={lines} className="crt-lines absolute inset-0 h-full w-full" />
      <div className="crt-rgb absolute inset-0" />
      <div className="crt-roll absolute inset-x-0" />
      {glitch && (
        <div
          key={glitch.key}
          className="crt-tear absolute inset-x-0"
          style={{ top: `${glitch.top}%` }}
        />
      )}
      <div className="crt-glare absolute inset-0" />
      <div className="crt-glass absolute inset-0" />
    </div>
  );
}

function PlayerCard({
  p,
  entry,
  onClose,
}: {
  p: PlayerView;
  entry: number;
  onClose: () => void;
}): JSX.Element {
  const value = p.outcome === "dead" ? 0 : p.balance;
  const pl = value - entry;
  const tone =
    p.outcome === "dead"
      ? "var(--color-danger)"
      : p.outcome === "cashed"
        ? "var(--color-profit)"
        : "var(--color-text)";

  const line = (label: string, node: React.ReactNode): JSX.Element => (
    <div className="flex items-baseline justify-between gap-2">
      <span className="label">{label}</span>
      {node}
    </div>
  );

  return (
    <div className="absolute bottom-2 left-2 z-20 max-h-[calc(100%-16px)] w-[208px] overflow-y-auto rounded-sm border border-[var(--color-edge)] bg-[var(--color-pit)] p-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.75)]">
      <button
        onClick={onClose}
        aria-label="Close"
        className="label absolute right-2 top-2 text-[var(--color-dim)] hover:text-[var(--color-text)]"
      >
        ✕
      </button>

      <div className="flex items-center gap-2 pr-6">
        <CharArt charId={p.charId} pose="head" size={30} dim={p.outcome === "dead"} />
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold"
            style={{ color: p.you ? "var(--color-cyan)" : "var(--color-text)" }}
          >
            {p.name}
          </div>
          <div className="label truncate">
            {charById(p.charId).label} ·{" "}
            {p.outcome === "dead"
              ? "shattered"
              : p.outcome === "cashed"
                ? "extracted"
                : "still in"}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="tnum text-[19px] font-bold" style={{ color: tone }}>
          {p.outcome === "dead" ? "0.00×" : `${p.multiple.toFixed(2)}×`}
        </span>
        <span className="tnum text-[11px]" style={{ color: tone }}>
          {value.toFixed(3)} ◎
        </span>
      </div>

      <div className="mt-2 space-y-0.5 border-t border-[var(--color-panel2)] pt-1.5">
        {line(
          p.outcome === "in" ? "unrealised" : "profit",
          <span
            className="tnum text-[11px] font-semibold"
            style={{
              color: pl >= 0 ? "var(--color-profit)" : "var(--color-danger)",
            }}
          >
            {pl >= 0 ? "+" : ""}
            {pl.toFixed(3)} ◎
          </span>,
        )}
      </div>

      {p.lifetime && (
        <div className="mt-1.5 space-y-0.5 border-t border-[var(--color-panel2)] pt-1.5">
          {line(
            "wagered",
            <span className="tnum text-[11px]">{p.lifetime.wagered.toFixed(1)} ◎</span>,
          )}
          {line(
            "banked ahead",
            <span className="tnum text-[11px] font-semibold">
              {(p.lifetime.hitRate * 100).toFixed(0)}%
            </span>,
          )}
          {line(
            "best ride",
            <span
              className="tnum text-[11px] font-semibold"
              style={p.lifetime.best >= 5 ? { color: "var(--color-gold)" } : undefined}
            >
              {p.lifetime.best > 0 ? `${p.lifetime.best.toFixed(2)}×` : "-"}
            </span>,
          )}
          {p.lifetime.wagered > 0 &&
            line(
              "lifetime rtp",
              <span
                className="tnum text-[11px] font-semibold"
                style={p.lifetime.net >= 0 ? { color: "var(--color-profit)" } : undefined}
              >
                {(((p.lifetime.wagered + p.lifetime.net) / p.lifetime.wagered) * 100).toFixed(1)}%
              </span>,
            )}
        </div>
      )}
    </div>
  );
}

function AliveCard({ snap }: { snap: Snapshot }): JSX.Element {
  const secs = Math.ceil(snap.msToPhaseEnd / 1000);

  let label: string;
  let big: JSX.Element;
  let sub: string;

  if (snap.phase === "lobby") {
    label = "bonded";
    big = <>{snap.totalCount}</>;
    sub = `seals ${secs}s`;
  } else if (snap.phase === "live") {
    label = "alive";
    big = (
      <>
        {snap.liveCount}
        <span className="text-[var(--color-dim)]" style={{ fontSize: 13 }}>
          /{snap.totalCount}
        </span>
      </>
    );
    sub = `pot ${snap.potInPlay.toFixed(1)} ◎`;
  } else {
    label = "next round";
    big = <span className="text-[var(--color-dim)]">{secs}s</span>;
    sub = "";
  }

  return (
    <div className="flex w-[88px] shrink-0 flex-col items-center justify-center p-2 sm:w-[118px]">
      <div className="label">{label}</div>
      <div className="tnum mt-1 leading-none" style={{ fontSize: 26, fontWeight: 700 }}>
        {big}
      </div>
      <div className="label tnum mt-1.5 h-3">{sub}</div>
    </div>
  );
}

function TabbedPanel({
  snap,
  tab,
  onTab,
  chat = false,
  open,
  onToggleOpen,
  children,
}: {
  snap: Snapshot;
  tab: Tab;
  onTab: (t: Tab) => void;
  chat?: boolean;
  open?: boolean;
  onToggleOpen?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const shown = open !== false;
  const tabBtn = (id: Tab, label: string): JSX.Element => (
    <button
      onClick={() => onTab(id)}
      className="label border-b-2 px-2 pb-1.5 pt-1"
      style={{
        color: tab === id && shown ? "var(--color-text)" : undefined,
        borderColor: tab === id && shown ? "var(--color-cyan)" : "transparent",
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-1">
        {tabBtn("roster", `roster · ${snap.liveCount} in`)}
        {chat && tabBtn("chat", "chat")}
        {tabBtn("history", "history")}
        {tabBtn("stats", "stats")}
        {onToggleOpen && (
          <button
            onClick={onToggleOpen}
            aria-label={shown ? "Hide panel" : "Show panel"}
            className="label ml-auto rounded-sm px-2.5 py-1"
          >
            {shown ? "▾" : "▴"}
          </button>
        )}
      </div>
      {shown && <div className="min-h-0 flex-1 p-1">{children}</div>}
    </div>
  );
}
