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
import { Tutorial, tutorialSeen } from "@/ui/Tutorial";
import { CharArt, CharSelect, ShatterCard, WinnerOverlay } from "@/ui/Chars";
import { ChatPanel } from "@/ui/Chat";
import { initAudio, sfxTvOff, sfxTvOn } from "@/audio/sound";
import { crtOn, onCrtChange } from "@/ui/fx";
import { riskBand } from "@/game/risk";
import { charById, initCharAssets } from "@/game/chars";
import { DEFAULT_CONFIG } from "@zinc/engine";

// Read from the engine, not restated. A second copy of the tick interval means
// the ring animation silently races the wrong clock the moment timing changes.
const TICK_MS = DEFAULT_CONFIG.timing.tickMs;

type Tab = "roster" | "history" | "stats" | "chat";

export default function App(): JSX.Element {
  const client = getClient();
  const [snap, setSnap] = useState<Snapshot>(() => client.snapshot());
  const [selected, setSelected] = useState<{ roundId: number; id: number } | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  // ?intro on the URL re-summons the walkthrough — it is otherwise a
  // once-per-browser event, which makes reviewing copy changes impossible.
  const [showIntro, setShowIntro] = useState(
    () => !tutorialSeen() || new URLSearchParams(window.location.search).has("intro"),
  );
  const [showChars, setShowChars] = useState(false);
  const [tab, setTab] = useState<Tab>("roster");
  // Mobile only: the bottom panel folds to its tab row so the lattice gets
  // the height back. Desktop's rail ignores this entirely.
  const [panelOpen, setPanelOpen] = useState(true);
  // CRT mode, toggled from the sound popover, worn by the lattice frame.
  const [crt, setCrtState] = useState(() => crtOn());
  useEffect(() => onCrtChange(setCrtState), []);

  // The TV power cycle: when the result screen gives way to the next lobby,
  // the picture collapses to a line and snaps back open on fresh ice.
  const [tv, setTv] = useState<"off" | "on" | null>(null);
  const prevPhase = useRef(snap.phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = snap.phase;
    if (!crt || !(was === "result" && snap.phase === "lobby")) {
      // A cycle interrupted mid-flight must not leave the picture collapsed.
      // Re-running this effect clears the pending timers below, and those
      // timers are the only thing that ever restores the screen: toggling CRT
      // off during the 700ms blink, or a reconnect jumping the phase inside
      // it, would otherwise strand tv at "off" — the board held at 0.4% of
      // its height by the animation's fill mode, invisible for good.
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
  // Ice faces are drawn in code now; only the character art loads from disk.
  useEffect(() => initCharAssets(), []);

  // Browsers block audio until the first gesture, so arm it on any interaction.
  useEffect(() => {
    const arm = (): void => initAudio();
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);

  // Seat ids are only unique within a round: id 3 next round is a different
  // person. The selection therefore carries the round it was made in, and is
  // discarded during render rather than in an effect — an effect runs after
  // paint, so the first frame of the new round still resolved the old id and
  // showed a stranger's card as if it were the same continuous player.
  const chosen =
    selected && selected.roundId === snap.roundId
      ? (snap.players.find((p) => p.id === selected.id) ?? null)
      : null;
  const select = (id: number | null): void =>
    setSelected(id === null ? null : { roundId: snap.roundId, id });

  // One tab state serves both layouts, but only mobile offers "chat" as a tab
  // — the desktop rail has a dedicated chat panel instead, so there the value
  // falls back to the roster rather than rendering an unlisted tab.
  const deskTab = tab === "chat" ? "roster" : tab;

  return (
    <div className="mx-auto flex h-full max-w-[1180px] flex-col">
      <TopNav
        snap={snap}
        onShowInfo={() => setShowInfo(true)}
        onShowChars={() => setShowChars(true)}
        onWalletChange={(connected) => client.reauth(connected)}
      />
      <OfflineBar snap={snap} />
      <StateBar snap={snap} />

      <div className="mt-1.5 flex min-h-0 flex-1 gap-2 px-1.5 lg:px-3">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* The vitals strip. Everything a player must not miss lives here,
              above the lattice: the tick/danger ring, the hero multiplier, and
              the field count. The old placement — multiplier floating on the
              canvas, risk relegated to a thin bar below it — left the single
              most important quantity in the game unread. */}
          <div className="mb-1.5 flex shrink-0 items-stretch gap-2">
            <TickRing snap={snap} tickMs={TICK_MS} />
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <Multiplier snap={snap} />
            </div>
            <AliveCard snap={snap} />
          </div>

          {/* Flat: the lattice reads as a surface, not a framed screenshot.
              Its darker pit background is the only separation it needs. The
              tube filter warms the picture only while CRT mode is on. */}
          <div
            className={`relative min-h-0 flex-1 overflow-hidden ${crt ? "crt-tube" : ""} ${
              tv === "off" ? "tv-off" : tv === "on" ? "tv-on" : ""
            }`}
          >
            {/* `bleed` fades the BOARD into the pit, and only the board. It is
                a mask, so it applies to the whole subtree it sits on — with
                the overlays inside it, the first 64px from every side of a
                card were multiplied down toward transparent, which is why a
                card parked at left-2 had no visible left edge no matter what
                colour it was drawn in. The atmosphere belongs to the ice. */}
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

        {/* Desktop rail: your controls on top, at eye level with the game,
            the way every crash game places its bet panel. */}
        {/* Scored off the board by one hairline, not boxed: the house draws
            its sidebar as a region of the same surface, and the whole page
            stops reading as cards floating on a background. */}
        <aside className="hidden w-[286px] shrink-0 border-l border-[var(--color-line-soft)] pl-3 lg:flex lg:flex-col lg:gap-1.5">
          <ActionBar
            inline
            snap={snap}
            onJoin={() => client.join()}
            onWalkOut={() => client.walkOut()}
            onStepOff={() => client.stepOff()}
          />
          <AutoPanel snap={snap} onChange={(p) => client.setAuto(p)} />
          {/* Chat lives on mobile as a fourth tab; on desktop it has its own
              panel below, so the tab maps back to the roster here. */}
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
          {/* Always visible, never behind a tab: a PvP room where the other
              players are silent and hidden reads as a single-player game. */}
          <div className="min-h-0 flex-1">
            <ChatPanel snap={snap} client={client} onSelect={select} />
          </div>
        </aside>
      </div>

      {/* Mobile panel. Kept deliberately short: on a phone every row of chrome
          is taken straight out of the lattice, which is the thing people came
          to look at. The roster scrolls, so height here is a luxury. */}
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
      {showChars && (
        <CharSelect
          snap={snap}
          onPick={(id) => client.setCharacter(id)}
          onClose={() => setShowChars(false)}
        />
      )}
      {/* Root level, NOT inside the lattice frame: the tube's filter turns any
          ancestor into the containing block for fixed children, which caged
          this "fullscreen" card inside the TV and clipped it on phones. */}

      {/* Mobile keeps the thumb-reach bottom bar, with auto play just above. */}
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

/**
 * The rink behind curved glass. Mounted directly over the canvas — under the
 * player card and the winner scene, which are chrome, not broadcast. Pure
 * composited CSS plus one canvas of BENT scanlines redrawn only on resize:
 * the curvature is the whole trick, straight lines say overlay and bent
 * lines say tube. The game canvas never pays a frame for any of it.
 *
 * The signal degrades with the danger: a sub-pixel sway when the ice is
 * tense, hard tracking steps when it is critical, and a tear-band glitch
 * the instant a plate goes under. Presentation reacting to the same number
 * as the ring and the seams — a channel, not a costume.
 */
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
      // Barrel curvature: each line bows away from the vertical centre, the
      // way a tube's face bulges. A quadratic through-midpoint needs double
      // the sag on its control point.
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

  // One tear per death, riding wherever the clock happens to point.
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

/**
 * Everything about one player on one plate.
 *
 * Fixed width with a pinned close
 * button, so the geometry never depends on the length of a name; capped to
 * the lattice frame and scrollable inside, because on a phone the frame is
 * shorter than the card and the overflow was silently clipped.
 */
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

      {/* The record, not the stopwatch.
          Volume is ONE line: entry is fixed, so plates and SOL wagered are
          the same fact and printing both was one number twice. The rows that
          earn their space are the style tells — how often this wallet
          finishes a plate ahead, and how far it has ever ridden one. Those
          separate a nit from a degen, which is the thing worth knowing about
          a stranger you are sharing a lattice with. */}
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
          {/* RTP, not net SOL. A 24/7 grinder's card would otherwise read
              like a casualty report ("-20 ◎ lifetime") when the honest
              summary of the same volume is "98% returned" — the number the
              game actually promises. Green only at or above break-even;
              below it stays neutral, because under 100% IS the expected
              case, not damage. Hidden until a wallet has wagered anything. */}
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

/**
 * Field count, and the one number that matters for the current phase: how many
 * are bonded and when the round seals, how many are still alive and what the
 * pot is, or how long until the next round.
 */
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

  // Boxless on purpose: numbers over the page, same as the hero multiplier.
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

/** Flat surface, no frame: the lattice keeps the product's one border. */
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
  /** Offer chat as a tab — the mobile layout, which has no room for a rail. */
  chat?: boolean;
  /** Collapse support (mobile): false hides the body, leaving the tab row. */
  open?: boolean;
  onToggleOpen?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const shown = open !== false;
  // Active tab is a cyan underline on lit text — the house marks the current
  // arena this way, and an underline says "section" where a filled pill said
  // "button". The inactive border is transparent, not absent, so switching
  // tabs never shifts the row by two pixels.
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
        {/* The give-me-my-screen-back button: collapses the panel to this
            row so the lattice takes the height. Tapping any tab reopens. */}
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
