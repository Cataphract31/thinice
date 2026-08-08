import { useEffect, useState, type JSX } from "react";
import type { BonanzaEvent } from "@/game/client";

/**
 * Jackpot overlay.
 *
 * The bonanza fires roughly once in 1500 rounds, so most players will see it
 * happen to someone else a handful of times and win it approximately never.
 * It gets the loudest treatment in the product: the cold palette is abandoned
 * entirely for warm gold, and the sequence is allowed to interrupt everything.
 */
/** Intro slam, hold, then lift away. */
const HOLD = 5.4;
const FADE = 0.9;
const DURATION = HOLD + FADE;

export function BonanzaOverlay({ event }: { event: BonanzaEvent | null }): JSX.Element | null {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!event) return;
    setElapsed(0);
    let raf = 0;
    const start = performance.now();
    const loop = (now: number): void => {
      const t = (now - start) / 1000;
      setElapsed(t);
      // Stop once the sequence is over. Previously this kept requesting frames
      // and setting state at 60Hz until the next lobby cleared the event, long
      // after the overlay had faded out and stopped rendering anything.
      if (t > DURATION) return;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // Keyed on the fire's timestamp, not the event object. In networked play
    // every server push builds a fresh `bonanza` object, so an identity key
    // re-ran this effect several times a second for the whole result phase:
    // elapsed was reset before it ever left the intro, and the celebration
    // sawtoothed instead of playing. `at` is stable for one fire and distinct
    // between two.
  }, [event?.at]);

  if (!event) return null;

  const t = elapsed;
  const intro = Math.min(1, t / 0.45);
  const outro = t > HOLD ? Math.min(1, (t - HOLD) / FADE) : 0;
  const alpha = intro * (1 - outro);
  if (alpha <= 0.01) return null;

  const scale = 0.7 + 0.3 * (1 - Math.pow(1 - intro, 4));

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center"
      style={{
        opacity: alpha,
        background:
          "radial-gradient(circle at 50% 45%, rgba(255,180,60,0.30), rgba(80,40,0,0.55) 45%, rgba(4,7,10,0.86) 80%)",
      }}
    >
      <div
        className="display text-[var(--color-gold)]"
        style={{
          fontSize: "clamp(30px, 9vw, 74px)",
          fontWeight: 700,
          letterSpacing: "0.16em",
          transform: `scale(${scale})`,
          textShadow: "0 0 46px rgba(255,190,80,0.75), 0 0 100px rgba(255,150,40,0.45)",
        }}
      >
        BONANZA
      </div>

      <div
        className="tnum mt-1"
        style={{
          fontSize: "clamp(34px, 12vw, 92px)",
          fontWeight: 700,
          color: "#fff3d6",
          letterSpacing: "-0.02em",
          textShadow: "0 0 42px rgba(255,200,90,0.7)",
          transform: `scale(${scale})`,
        }}
      >
        {event.amount.toFixed(2)} ◎
      </div>

      <div className="mt-3 text-center">
        {event.youWon ? (
          <div
            className="display text-[15px] tracking-[0.2em] text-[#fff0cf]"
            style={{ textShadow: "0 0 24px rgba(255,200,90,0.8)" }}
          >
            YOU TOOK THE WHOLE POOL
          </div>
        ) : (
          <div className="display text-[13px] tracking-[0.18em] text-[#e8c98d]">
            taken by <span className="text-[var(--color-gold)]">{event.winner}</span>
          </div>
        )}
        <div className="label mt-2 text-[#c9a55f]">
          every ticket is now void · the next draw starts from zero
        </div>
      </div>
    </div>
  );
}
