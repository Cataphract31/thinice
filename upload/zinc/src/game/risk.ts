import { DEFAULT_CONFIG } from "@zinc/engine";

/**
 * The shared risk scale.
 *
 * Hazard is a probability with a very lopsided distribution: it opens around
 * 7.5%, collapses within a few ticks, then lives between roughly 0.5% and 3%
 * for almost the whole round. Anything that presents it on a linear 0-to-max
 * axis therefore spends the entire round pinned near the bottom and reads as
 * dead — which is exactly what both the tick audio and the risk meter were
 * doing, each with its own privately hardcoded thresholds.
 *
 * So there is one mapping, defined here, derived from the engine config, and
 * used by everything that displays risk. It is logarithmic for the same reason
 * hearing and vision are: what registers is the ratio between two values, not
 * their difference. Going from 1% to 2% doubles your chance of dying and
 * should look and sound like a real change; 6% to 7% is a sixth more and
 * should barely register.
 */

/** Bottom of the scale: the configured hazard floor. */
const FLOOR = DEFAULT_CONFIG.hazard.qMin;
/** The opening rate — the top of the band where essentially all play happens. */
const KNEE = DEFAULT_CONFIG.hazard.q0;
/** The engine's hard clamp. Practically unreachable, but the scale must not lie. */
const CEIL = DEFAULT_CONFIG.hazard.qMax;
/**
 * Two-segment scale with a knee at q0.
 *
 * Measured over 60k rounds: normal play lives between 0.5% and 3.5%, the
 * endgame creep pulls 56% of rounds back above 5%, ~8% revisit 7.5%+, 1.4%
 * cross 10%, and nothing has ever reached 20% (observed max ~17%). So the
 * bottom segment keeps the full expressive resolution over 0.4-7.5% — where
 * every round actually happens — and the top 15% of the scale absorbs the
 * rare endgame blowout, which the old q0-capped scale rendered pixel- and
 * sample-identical to an ordinary opening tick.
 */
const KNEE_POS = 0.85;
const LOWER = Math.log(KNEE / FLOOR);
const UPPER = Math.log(CEIL / KNEE);

/** Maps a hazard rate to 0-1 across the range players actually experience. */
export function riskScale(hazard: number): number {
  const h = Math.max(FLOOR, Math.min(CEIL, hazard));
  if (h <= KNEE) return KNEE_POS * (Math.log(h / FLOOR) / LOWER);
  return KNEE_POS + (1 - KNEE_POS) * (Math.log(h / KNEE) / UPPER);
}

export type RiskBand = "holding" | "stable" | "stressed" | "critical";

/**
 * Thresholds are on the scale, not on the raw rate, so they stay meaningful if
 * the hazard curve is retuned. On the knee scale these fire at the same
 * real-world rates as always: "stressed" from ~1.1% hazard, "critical" ~3%.
 */
export function riskBand(hazard: number, grace: boolean): RiskBand {
  if (grace) return "holding";
  const s = riskScale(hazard);
  return s > 0.59 ? "critical" : s > 0.3 ? "stressed" : "stable";
}

export function bandColor(band: RiskBand): string {
  switch (band) {
    case "holding":
      return "var(--color-cyan)";
    case "critical":
      return "var(--color-danger)";
    case "stressed":
      return "var(--color-warn)";
    default:
      return "var(--color-cyan)";
  }
}

/** One word each. "Say more with less" — the colour and the number do the work. */
export function bandLabel(band: RiskBand): string {
  switch (band) {
    case "holding":
      return "safe";
    case "critical":
      return "critical";
    case "stressed":
      return "tense";
    default:
      return "calm";
  }
}
