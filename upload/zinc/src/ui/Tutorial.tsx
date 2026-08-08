import { useState, type JSX } from "react";
import { DEFAULT_CONFIG } from "@zinc/engine";

/**
 * First-visit walkthrough, modelled on the step-card onboarding the owner
 * supplied as reference: dimmed board behind, one card with a visual pane and
 * a few short steps. Copy is deliberately ape-simple — one idea per step,
 * nothing a first-timer has to parse twice.
 */

const SEEN_KEY = "zinc.introSeen";

export function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* just shows again next visit */
  }
}

interface Step {
  chip: string;
  title: string;
  body: string[];
  visual: "ice" | "number" | "ring" | "payout";
}

const STEPS: Step[] = [
  {
    chip: "introduction",
    title: "Welcome onto THIN ICE",
    body: [
      "Everyone pays the same entry to step onto the ice with a crowd of strangers.",
      // Not "takes someone": most ticks take nobody, and teaching a
      // one-death-per-tick model the first round then contradicts is a bad
      // way to meet a player. Info.tsx has always worded this correctly.
      "Every half second the ice rolls, and it can take anyone standing on it.",
    ],
    visual: "ice",
  },
  {
    chip: "the number",
    title: "Their loss is your gain",
    body: [
      "Everything a fallen player was holding is split between everyone still standing.",
      "One number shows what your stake is worth right now. It climbs every time someone else breaks.",
    ],
    visual: "number",
  },
  {
    chip: "the danger",
    title: "Read the ring",
    body: [
      "The ring fills every half second. When it fills, the ice rolls and anyone can break.",
      "Blue is calmer, crimson means get out. Calm is never safe: even quiet ice can take you on any tick.",
    ],
    visual: "ring",
  },
  {
    chip: "getting paid",
    title: "Leave with the money",
    body: [
      "Hit Extract any moment and keep what you're holding. Get caught and you keep nothing.",
      // Derived, never restated: a hardcoded rake figure in player-facing copy
      // has already gone stale once in this build.
      `${((1 - DEFAULT_CONFIG.rake.house) * 100).toFixed(0)}% of every coin goes back to players: the pot, a jackpot, and rakeback that keeps paying you even after you stop playing.`,
    ],
    visual: "payout",
  },
];

function Visual({ kind }: { kind: Step["visual"] }): JSX.Element {
  if (kind === "number") {
    return (
      <div className="flex flex-col items-center gap-2">
        <span className="tnum text-[64px] font-bold leading-none text-[var(--color-profit)]">
          2.34<span className="text-[0.5em] opacity-75">×</span>
        </span>
        <span className="label">and climbing</span>
      </div>
    );
  }
  if (kind === "ring") {
    return (
      <div className="relative h-[120px] w-[120px]">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="44" fill="none" stroke="var(--color-panel2)" strokeWidth="7" />
          <circle
            cx="50"
            cy="50"
            r="44"
            fill="none"
            stroke="var(--color-warn)"
            strokeWidth="7"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset="28"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-[22px] font-bold text-[var(--color-warn)]">3.2%</span>
          <span className="label text-[var(--color-warn)]">tense</span>
        </div>
      </div>
    );
  }
  if (kind === "payout") {
    return (
      <div className="flex flex-col items-center gap-2">
        <span className="tnum text-[44px] font-bold leading-none text-[var(--color-gold)]">
          412.7 ◎
        </span>
        <span className="label text-[var(--color-gold)]">bonanza pool</span>
        <span className="label mt-1 rounded-sm bg-[var(--color-cyan)]/10 px-2 py-1 text-[var(--color-cyan)]">
          + rakeback, forever
        </span>
      </div>
    );
  }
  // The ice: one hex plate with its snowflake dendrite.
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${50 + 42 * Math.cos(a)},${50 + 42 * Math.sin(a)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 100 100" className="h-[130px] w-[130px]">
      <polygon
        points={pts}
        fill="#1f3a4d"
        stroke="#5b93b4"
        strokeWidth="2"
      />
      {Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return (
          <line
            key={i}
            x1={50 + 6 * Math.cos(a)}
            y1={50 + 6 * Math.sin(a)}
            x2={50 + 33 * Math.cos(a)}
            y2={50 + 33 * Math.sin(a)}
            stroke="#c9ecff"
            strokeWidth="1.4"
            opacity="0.5"
          />
        );
      })}
    </svg>
  );
}

export function Tutorial({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState(0);
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;

  const done = (): void => {
    markSeen();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#04070a]/80 p-3 backdrop-blur-sm">
      <div className="flex w-full max-w-[760px] overflow-hidden rounded-md bg-[var(--color-panel)] shadow-[0_20px_80px_rgba(0,0,0,0.6)]">
        {/* Visual pane. Hidden on narrow screens where the text needs the room. */}
        <div className="hidden w-[300px] shrink-0 items-center justify-center bg-[var(--color-pit)] sm:flex">
          <Visual kind={s.visual} />
        </div>

        <div className="flex min-h-[360px] flex-1 flex-col p-5">
          <div className="mb-3 flex gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className="h-[3px] flex-1 rounded-full"
                style={{
                  background: i <= step ? "var(--color-cyan)" : "var(--color-panel2)",
                }}
              />
            ))}
          </div>

          <span className="label mb-3 w-fit rounded-sm bg-[var(--color-panel2)] px-2 py-1">
            {s.chip}
          </span>

          <h2 className="display mb-3 text-[24px] font-bold leading-tight">{s.title}</h2>

          {s.body.map((p) => (
            <p key={p} className="mb-2 text-[14px] leading-relaxed text-[var(--color-zinc-hi)]">
              {p}
            </p>
          ))}

          <div className="mt-auto flex items-center justify-between pt-4">
            <button
              onClick={done}
              className="label rounded-sm bg-[var(--color-panel2)] px-4 py-2.5 hover:text-[var(--color-text)]"
            >
              skip
            </button>
            <button
              onClick={() => (last ? done() : setStep(step + 1))}
              className="display rounded-sm bg-[var(--color-cyan)] px-5 py-2.5 text-[13px] font-bold tracking-[0.1em] text-[#03211f] active:scale-[0.97]"
            >
              {last ? "step on" : "next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
