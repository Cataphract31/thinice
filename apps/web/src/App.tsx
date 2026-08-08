import { useEffect, useState, type JSX } from "react";
import type { PlayerView, Snapshot } from "@/game/client";
import { getClient } from "@/game/session";
import { Shaft } from "@/ui/Shaft";
import { Multiplier } from "@/ui/Multiplier";
import { Roster } from "@/ui/Ledger";
import { HistoryPanel } from "@/ui/History";
import { StatsPanel } from "@/ui/Stats";
import { TickRing } from "@/ui/TickRing";
import { BonanzaOverlay } from "@/ui/Bonanza";
import { BankPanel, type Banker } from "@/ui/Bank";
import { ActionBar, AutoPanel, BonanzaBar, TopBar } from "@/ui/Hud";
import { InfoOverlay } from "@/ui/Info";
import { Tutorial, tutorialSeen } from "@/ui/Tutorial";
import { CharArt, CharSelect, ShatterCard, WinnerOverlay } from "@/ui/Chars";
import { ChatPanel } from "@/ui/Chat";
import { initAudio } from "@/audio/sound";
import { charById, initCharAssets } from "@/game/chars";
import { initTileAssets } from "@/render/tiles";
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
  const [showIntro, setShowIntro] = useState(() => !tutorialSeen());
  const [showChars, setShowChars] = useState(false);
  const [showBank, setShowBank] = useState(false);
  const [tab, setTab] = useState<Tab>("roster");
  // Mobile only: the bottom panel folds to its tab row so the lattice gets
  // the height back. Desktop's rail ignores this entirely.
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => client.subscribe(setSnap), [client]);
  useEffect(() => {
    initCharAssets();
    initTileAssets();
  }, []);

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
      <TopBar
        snap={snap}
        onShowInfo={() => setShowInfo(true)}
        onShowChars={() => setShowChars(true)}
        onWalletChange={() => {
          if (!client.isLocal) client.reauth();
        }}
        onShowBank={snap.bank ? () => setShowBank(true) : undefined}
      />
      <BonanzaBar snap={snap} />

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
              Its darker pit background is the only separation it needs. */}
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm">
            <Shaft snap={snap} onSelectCell={select} />

            {chosen && (
              <PlayerCard
                p={chosen}
                entry={snap.entry}
                onClose={() => select(null)}
              />
            )}

            <ShatterCard snap={snap} />
            <WinnerOverlay snap={snap} />
            <BonanzaOverlay event={snap.bonanza} />
          </div>
        </div>

        {/* Desktop rail: your controls on top, at eye level with the game,
            the way every crash game places its bet panel. */}
        <aside className="hidden w-[286px] shrink-0 lg:flex lg:flex-col lg:gap-1.5">
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
      {showIntro && <Tutorial onClose={() => setShowIntro(false)} />}
      {showChars && (
        <CharSelect
          snap={snap}
          onPick={(id) => client.setCharacter(id)}
          onClose={() => setShowChars(false)}
        />
      )}
      {showBank && snap.bank && !client.isLocal && (
        <BankPanel
          snap={snap}
          bank={snap.bank}
          client={client as unknown as Banker}
          onClose={() => setShowBank(false)}
        />
      )}

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

      <Footer onShowInfo={() => setShowInfo(true)} />
    </div>
  );
}

/**
 * Slim anchor for the bottom of the page. Without it the layout just stops,
 * which reads as "did this fail to load" or "can I scroll"; with it the page
 * visibly ends on purpose.
 */
function Footer({ onShowInfo }: { onShowInfo: () => void }): JSX.Element {
  return (
    /* Hidden on phones: there the action bar already anchors the bottom of
       the page, and the footer would only cost the lattice another row. */
    <footer className="hidden shrink-0 items-center justify-between px-3 py-2 lg:flex">
      <span className="label">
        THIN<span className="text-[var(--color-cyan)]">ICE</span> · a zinc game
      </span>
      <span className="label flex items-center gap-3">
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
 * Everything about one player on one plate.
 *
 * The tickets row is the wallet's ACTUAL holdings — the same bonanza / rev
 * pair the owner sees in their own tickets stat. It used to print the flat
 * per-entry award, which told a player checking their alt from another phone
 * that their five-figure stack was "200". Fixed width with a pinned close
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
    <div className="absolute bottom-2 left-2 z-20 max-h-[calc(100%-16px)] w-[208px] overflow-y-auto rounded-md bg-[var(--color-pit)]/95 p-2.5 shadow-[0_6px_28px_rgba(0,0,0,0.55)] backdrop-blur">
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
          {/* This wallet's holdings, not the per-entry award: bots and fresh
              wallets hold nothing, and printing 0 / 0 would only invite the
              question this row exists to answer. */}
          {p.lifetime.tickets &&
            (p.lifetime.tickets.bon > 0 || p.lifetime.tickets.rev > 0) &&
            line(
              "tickets",
              <span className="tnum text-[11px] font-semibold">
                <span className="text-[var(--color-gold)]">
                  {p.lifetime.tickets.bon.toLocaleString()}
                </span>
                <span className="text-[var(--color-dim)]"> / </span>
                <span className="text-[var(--color-cyan)]">
                  {p.lifetime.tickets.rev.toLocaleString()}
                </span>
              </span>,
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
              {p.lifetime.best > 0 ? `${p.lifetime.best.toFixed(2)}×` : "—"}
            </span>,
          )}
          {line(
            "lifetime p/l",
            <span
              className="tnum text-[11px] font-semibold"
              style={{
                color:
                  p.lifetime.net >= 0 ? "var(--color-profit)" : "var(--color-danger)",
              }}
            >
              {p.lifetime.net >= 0 ? "+" : ""}
              {p.lifetime.net.toFixed(3)} ◎
            </span>,
          )}
          {/* Only for the few who have actually taken one — a row of zeroes
              on every other card would say nothing and cost a line. */}
          {p.lifetime.jackpots > 0 &&
            line(
              "bonanza won",
              <span className="tnum text-[11px] font-semibold text-[var(--color-gold)]">
                +{p.lifetime.jackpots.toFixed(2)} ◎
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
  const tabBtn = (id: Tab, label: string): JSX.Element => (
    <button
      onClick={() => onTab(id)}
      className="label rounded-sm px-2 py-1"
      style={{
        color: tab === id && shown ? "var(--color-text)" : undefined,
        background: tab === id && shown ? "var(--color-panel2)" : undefined,
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-1 py-1">
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
