import { useEffect, useState, type JSX } from "react";
import { useEscape } from "@/ui/esc";
import type { Snapshot } from "@/game/client";
import { CHARACTERS, charById, charImage, type Pose } from "@/game/chars";

export function CharArt({
  charId,
  pose,
  size,
  dim = false,
  fill = false,
}: {
  charId: string;
  pose: Pose;
  size: number;
  dim?: boolean;
  fill?: boolean;
}): JSX.Element {
  const def = charById(charId);
  const img = charImage(def.id, pose);

  if (img) {
    return (
      <img
        src={img.src}
        {...(fill ? {} : { width: size, height: size })}
        alt={def.label}
        className={
          fill
            ? "h-full max-h-full w-auto max-w-full select-none object-contain"
            : "shrink-0 select-none object-contain"
        }
        style={{
          imageRendering: "pixelated",
          filter: dim ? "grayscale(0.6) brightness(0.8)" : undefined,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={
        fill
          ? "flex aspect-square h-full max-h-full select-none items-center justify-center overflow-hidden rounded-full leading-none"
          : "flex shrink-0 select-none items-center justify-center rounded-full leading-none"
      }
      style={{
        ...(fill ? {} : { width: size, height: size }),
        fontSize: size * 0.62,
        background: `hsl(${def.hue} 45% 22% / ${dim ? 0.4 : 0.85})`,
        filter: dim ? "grayscale(0.6) brightness(0.8)" : undefined,
      }}
    >
      {def.emoji}
    </span>
  );
}

export function CharHead({
  charId,
  outcome,
  size = 18,
}: {
  charId: string;
  outcome: "in" | "cashed" | "dead";
  size?: number;
}): JSX.Element {
  return <CharArt charId={charId} pose="head" size={size} dim={outcome === "dead"} />;
}

export function CharSelect({
  snap,
  onPick,
  onClose,
}: {
  snap: Snapshot;
  onPick: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  useEscape(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-sm bg-[var(--color-panel)] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <span className="display text-[13px] font-bold tracking-[0.14em]">
            choose your fighter
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="label text-[var(--color-dim)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2 max-sm:grid-cols-3">
          {CHARACTERS.map((c) => {
            const active = snap.charId === c.id;
            return (
              <button
                key={c.id}
                onClick={() => {
                  onPick(c.id);
                  onClose();
                }}
                className="flex flex-col items-center gap-2 rounded-sm p-3"
                style={{
                  background: active ? "var(--color-panel2)" : undefined,
                  boxShadow: active ? "inset 0 0 0 1.5px var(--color-cyan)" : undefined,
                }}
              >
                <CharArt charId={c.id} pose="head" size={52} />
                <span
                  className="label"
                  style={active ? { color: "var(--color-cyan)" } : undefined}
                >
                  {c.label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="label mt-3 text-center">purely cosmetic, same odds for all</div>
      </div>
    </div>
  );
}

export function ShatterCard({ snap }: { snap: Snapshot }): JSX.Element | null {
  if (!snap.you.joined || snap.you.outcome !== "dead") return null;
  return (
    <div
      key={snap.roundId}
      className="win-rise pointer-events-none absolute bottom-2 right-2 z-20 flex flex-row-reverse items-end gap-1.5"
    >
      <div className="h-[64px] max-h-[30%] min-h-[34px] lg:h-[88px]">
        <CharArt charId={snap.charId} pose="lose" size={64} dim fill />
      </div>
      <span className="label pb-1 text-[var(--color-danger)]">you shattered</span>
    </div>
  );
}

export function WinnerOverlay({ snap }: { snap: Snapshot }): JSX.Element | null {
  const isResult = snap.phase === "result";
  const w = snap.winner;
  const holdMs = !w ? 2400 : w.lastStanding ? 3000 : 900;
  const [curtain, setCurtain] = useState(false);
  useEffect(() => {
    if (!isResult) {
      setCurtain(false);
      return;
    }
    const t = window.setTimeout(() => setCurtain(true), holdMs);
    return () => clearTimeout(t);
  }, [isResult, snap.roundId, holdMs]);

  if (!isResult || !curtain) return null;
  const champs = snap.history.filter((h) => h.winnerChar).slice(0, 8);

  return (
    <div
      key={snap.roundId}
      className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center overflow-hidden p-2"
    >
      <div className="scanlines absolute inset-0 bg-[var(--color-pit)]/82" />
      <div className="win-flash absolute inset-0 bg-white/70" />

      {w ? (
        <div className="relative flex h-full w-full min-h-0 flex-col items-center justify-center">
          <div className="win-slam h-[168px] max-h-[42%] min-h-[70px] shrink lg:h-[240px] 2xl:h-[320px]">
            <CharArt charId={w.charId} pose="win" size={168} fill />
          </div>
          <div
            className="display win-rise mt-2 text-[15px] font-bold tracking-[0.22em] lg:mt-3 lg:text-[17px]"
            style={{ color: w.you ? "var(--color-cyan)" : "var(--color-text)" }}
          >
            {w.lastStanding
              ? "last one standing"
              : (w.tied ?? 1) > 1
                ? "dead heat"
                : "best extraction"}
          </div>
          <div className="win-rise mt-1 flex items-baseline gap-2.5">
            <span
              className="text-[13px] font-semibold lg:text-[15px]"
              style={{ color: w.you ? "var(--color-cyan)" : "var(--color-text)" }}
            >
              {w.you ? "YOU" : w.name}
              {(w.tied ?? 1) > 1 && (
                <span className="text-[var(--color-dim)]"> +{(w.tied ?? 1) - 1} more</span>
              )}
            </span>
            <span className="tnum text-[17px] font-bold text-[var(--color-profit)] lg:text-[20px]">
              {w.multiple.toFixed(2)}×
            </span>
          </div>
        </div>
      ) : (
        <div className="relative flex h-full w-full flex-col items-center justify-center">
          <div className="win-slam text-[64px] leading-none lg:text-[92px]">❄️</div>
          <div className="display win-rise mt-3 text-[15px] font-bold tracking-[0.22em] text-[var(--color-danger)] lg:text-[17px]">
            the ice took everyone
          </div>
        </div>
      )}

      {champs.length > 1 && (
        <div className="win-rise absolute inset-x-0 bottom-2.5 hidden flex-col items-center gap-1.5 lg:flex">
          <span className="label">recent champions</span>
          <div className="flex items-center gap-1.5">
            {champs.map((h) => (
              <div key={h.roundId} className="h-[24px] lg:h-[32px]">
                <CharArt
                  charId={h.winnerChar!}
                  pose="head"
                  size={24}
                  dim={!h.winnerYou}
                  fill
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
