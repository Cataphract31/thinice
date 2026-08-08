import type { Strategy } from "@zinc/engine";

export interface NamedStrategy {
  id: string;
  label: string;
  strategy: Strategy;
  /** Relative share of the player population. */
  weight: number;
}

/** Walks out the first time the balance reaches a fixed multiple of entry. */
export function targetExit(multiple: number): Strategy {
  return (ctx) => ctx.multiple >= multiple;
}

/** Never walks out voluntarily: rides to elimination or last-standing. */
export const neverExit: Strategy = () => false;

/** Walks out after a fixed number of ticks, regardless of profit. */
export function tickExit(ticks: number): Strategy {
  return (ctx) => ctx.tick >= ticks;
}

/**
 * Leaves on a target, but panics out early once the hazard rate spikes.
 * Approximates a human who watches the risk meter rather than the number.
 */
export function nervy(multiple: number, panicQ: number, panicChance: number): Strategy {
  return (ctx) => {
    if (ctx.multiple >= multiple) return true;
    return ctx.q > panicQ && ctx.rng.next() < panicChance;
  };
}

/** The population used for headline RTP reporting. */
export const STRATEGY_SET: NamedStrategy[] = [
  { id: "exit_1.2x", label: "Cautious — exit at 1.2x", strategy: targetExit(1.2), weight: 1 },
  { id: "exit_1.6x", label: "Measured — exit at 1.6x", strategy: targetExit(1.6), weight: 1 },
  { id: "exit_2x", label: "Patient — exit at 2x", strategy: targetExit(2), weight: 1 },
  { id: "exit_3x", label: "Greedy — exit at 3x", strategy: targetExit(3), weight: 1 },
  { id: "exit_5x", label: "Moonshot — exit at 5x", strategy: targetExit(5), weight: 1 },
  { id: "never", label: "Diamond hands — never exit", strategy: neverExit, weight: 1 },
  { id: "nervy_2x", label: "Human — 2x target, panics when hot", strategy: nervy(2, 0.05, 0.18), weight: 1 },
];
