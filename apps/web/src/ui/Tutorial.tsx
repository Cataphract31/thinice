import { useEffect, useState, type JSX } from "react";
import { DEFAULT_CONFIG } from "@zinc/engine";
import { CharArt } from "./Chars";

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
  visual: "ice" | "number" | "ring" | "payout" | "drip";
}

// Quick pitches, not documentation — one idea per line, marketing-short.
// Anyone who wants the full math gets a door to "how it works" on the last
// card. Numbers are derived, never restated: a hardcoded rake figure in
// player-facing copy has already gone stale once in this build.
// ("The dice roll", not "the ice rolls" — owner feedback: dice say "random
// chance, every time" in one word to exactly this audience.)
const STEPS: Step[] = [
  {
    chip: "introduction",
    title: "YOU'RE ON THIN ICE",
    body: [
      "Same entry for everyone. You and a crowd of strangers, standing on ice.",
      "Twice a second, the ice tests everyone on it. Anyone can go under.",
    ],
    visual: "ice",
  },
  {
    chip: "the number",
    title: "Their loss is your gain",
    body: [
      "Whatever a fallen player held is split between everyone still standing.",
      "One number shows what your stake is worth. Someone breaks, it climbs.",
    ],
    visual: "number",
  },
  {
    chip: "the danger",
    title: "Know when to run",
    body: [
      // All four mechanics in two breaths, and no colour-reading advice:
      // players tried to "game" the shades, and it is just the odds.
      "The ring shows every plate's chance to shatter, rolled fresh each time it fills.",
      "Crowds strain the ice. Exits ease it. Time thins it. Anyone can go, on any roll.",
    ],
    visual: "ring",
  },
  {
    chip: "getting paid",
    title: "Leave with the money",
    body: [
      "Extract any moment, keep what you hold. Get caught, keep nothing.",
      `${((1 - DEFAULT_CONFIG.rake.house) * 100).toFixed(0)}% goes back to players: the pot, a winner-takes-all bonanza, rakeback. Fair, provably.`,
    ],
    visual: "payout",
  },
  {
    chip: "passive income",
    title: "Get paid while you sleep",
    body: [
      `Every plate earns rakeback tickets, forever. ${(DEFAULT_CONFIG.rake.revShare * 100).toFixed(0)}% of every entry streams to ticket holders, every round, around the clock.`,
      "Playing or sleeping, your cut keeps landing. Even if you stop.",
    ],
    visual: "drip",
  },
];

/**
 * The wallet actually ticking up. One drip at a time rises into the number,
 * and the number grows as it lands with a small pop — the "goes up while you
 * sleep" pitch happening for real, not looping decoration. The old version
 * ran three staggered CSS loops on fixed offsets over a static number: the
 * floats crossed each other and the chip, and the balance never moved.
 */
function DripVisual(): JSX.Element {
  const [wallet, setWallet] = useState(3.278);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    // Each beat: the previous drip has just reached the number, so the
    // balance banks it and the next drip launches. Keyed by beat, so every
    // cycle restarts the one-shot animation cleanly instead of loops drifting
    // out of phase.
    const t = setInterval(() => {
      setWallet((w) => w + 0.004);
      setBeat((b) => b + 1);
    }, 1700);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="relative flex flex-col items-center gap-1.5">
      <span className="label">your wallet</span>
      <span
        key={beat}
        className="tnum tick-pop text-[40px] font-bold leading-none text-[var(--color-zinc-hi)]"
      >
        {wallet.toFixed(3)} ◎
      </span>
      <div className="pointer-events-none absolute inset-x-0 bottom-[34px] flex justify-center">
        <span key={`d${beat}`} className="drip tnum text-[13px] font-bold text-[var(--color-cyan)]">
          +0.004 ◎
        </span>
      </div>
      <span className="label mt-3 rounded-sm bg-[var(--color-cyan)]/10 px-2 py-1 text-[var(--color-cyan)]">
        every round · even offline
      </span>
    </div>
  );
}

function Visual({ kind }: { kind: Step["visual"] }): JSX.Element {
  if (kind === "drip") return <DripVisual />;
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
  // The ice: one hex plate with its snowflake dendrite — and the crowd of
  // strangers actually standing on it, in the game's own pixel art.
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${50 + 42 * Math.cos(a)},${50 + 42 * Math.sin(a)}`;
  }).join(" ");
  return (
    <div className="relative">
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
      <div className="absolute inset-x-0 top-[26px] flex items-end justify-center gap-1">
        <CharArt charId="wojak" pose="head" size={28} />
        <CharArt charId="chad" pose="head" size={34} />
        <CharArt charId="pepe" pose="head" size={28} />
      </div>
    </div>
  );
}

export function Tutorial({
  onClose,
  onShowInfo,
}: {
  onClose: () => void;
  /** The door for readers: closes the walkthrough and opens "how it works". */
  onShowInfo?: () => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;

  const done = (): void => {
    markSeen();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#04070a]/80 p-3 backdrop-blur-sm">
      {/* Stacked on phones (visual on top, never hidden), side-by-side from
          sm up, and genuinely large on big monitors — a 760px card read as a
          postage stamp on 4K. */}
      <div className="flex w-full max-w-[780px] flex-col overflow-hidden rounded-sm bg-[var(--color-panel)] shadow-[0_20px_80px_rgba(0,0,0,0.6)] sm:flex-row xl:max-w-[940px] 2xl:max-w-[1100px]">
        <div className="flex h-[150px] w-full shrink-0 items-center justify-center bg-[var(--color-pit)] sm:h-auto sm:w-[300px] xl:w-[380px] 2xl:w-[450px]">
          <Visual kind={s.visual} />
        </div>

        <div className="flex flex-1 flex-col p-5 sm:min-h-[380px] lg:p-7 2xl:min-h-[460px]">
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

          <h2 className="display mb-3 text-[24px] font-bold leading-tight lg:text-[30px] 2xl:text-[34px]">
            {s.title}
          </h2>

          {s.body.map((p) => (
            <p
              key={p}
              className="mb-2 text-[14px] leading-relaxed text-[var(--color-zinc-hi)] lg:text-[16px] 2xl:text-[17px]"
            >
              {p}
            </p>
          ))}

          {/* The reading door, only where the pitches end. A real button:
              gray text read as decoration, not something you could tap. */}
          {last && onShowInfo && (
            <button
              onClick={() => {
                done();
                onShowInfo();
              }}
              className="mt-3 w-fit rounded-sm bg-[var(--color-cyan)]/14 px-3.5 py-2 text-[12.5px] font-semibold text-[var(--color-cyan)] hover:bg-[var(--color-cyan)]/22 lg:text-[13.5px]"
            >
              want the full math? read how it works →
            </button>
          )}

          <div className="mt-auto flex items-center justify-between pt-4">
            <button
              onClick={done}
              className="label rounded-sm bg-[var(--color-panel2)] px-4 py-2.5 hover:text-[var(--color-text)]"
            >
              skip
            </button>
            <button
              onClick={() => (last ? done() : setStep(step + 1))}
              className="display rounded-sm bg-[var(--color-cyan)] px-5 py-2.5 text-[13px] font-bold tracking-[0.1em] text-[#03211f] active:scale-[0.97] lg:px-6 lg:py-3 lg:text-[14px]"
            >
              {last ? "step on" : "next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
