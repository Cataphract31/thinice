import { DEFAULT_CONFIG } from "@zinc/engine";

const FLOOR = DEFAULT_CONFIG.hazard.qMin;
const KNEE = DEFAULT_CONFIG.hazard.q0;
const CEIL = DEFAULT_CONFIG.hazard.qMax;
const KNEE_POS = 0.85;
const LOWER = Math.log(KNEE / FLOOR);
const UPPER = Math.log(CEIL / KNEE);

export function riskScale(hazard: number): number {
  const h = Math.max(FLOOR, Math.min(CEIL, hazard));
  if (h <= KNEE) return KNEE_POS * (Math.log(h / FLOOR) / LOWER);
  return KNEE_POS + (1 - KNEE_POS) * (Math.log(h / KNEE) / UPPER);
}

export type RiskBand = "holding" | "stable" | "stressed" | "critical";

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
