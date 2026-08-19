import type { GameConfig } from "./config.js";
import { rngFromSeedHex } from "./rng.js";
import { Round, type CashOutRecord, type Entrant, type RoundResult } from "./round.js";

export interface RoundRecord {
  seedHex?: string;
  sealNonce?: string;
  interrupted?: boolean;
  config?: GameConfig;
  entrantIds: number[];
  cashOuts: CashOutRecord[];
}

export function roundSeedPreimage(
  secretHex: string,
  sealNonce: string,
  entrantIds: number[],
): string {
  return `thinice-seed:${secretHex}:${sealNonce}:${entrantIds.join(",")}`;
}

export function canonicalConfig(config: GameConfig): string {
  const walk = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k])}`)
      .join(",");
    return `{${body}}`;
  };
  return walk(config);
}

export function replayRound(config: GameConfig, rec: RoundRecord): RoundResult {
  const strategyExitAt = new Map<number, number>();
  const manualByTick = new Map<number, number[]>();
  for (const c of rec.cashOuts) {
    if (c.manual) {
      const list = manualByTick.get(c.tick) ?? [];
      list.push(c.id);
      manualByTick.set(c.tick, list);
    } else {
      strategyExitAt.set(c.id, c.tick);
    }
  }

  const entrants: Entrant[] = rec.entrantIds.map((id) => ({
    id,
    strategyId: "replay",
    strategy: (ctx) => {
      const t = strategyExitAt.get(id);
      return t !== undefined && ctx.tick >= t;
    },
  }));

  const rules = rec.config ?? config;
  if (rec.seedHex === undefined) {
    throw new Error("round record carries no seed: nothing to replay");
  }
  if (rec.interrupted) {
    throw new Error("round was interrupted before it finished: nothing to replay");
  }
  const rng = rngFromSeedHex(rec.seedHex);
  const round = new Round(rules, rng, entrants);
  for (const id of manualByTick.get(0) ?? []) round.cashOut(id);
  while (!round.finished) {
    round.step();
    for (const id of manualByTick.get(round.currentTick) ?? []) round.cashOut(id);
  }
  return round.result();
}

export function outcomeDigest(res: RoundResult): string {
  const players = res.players
    .map((p) => `${p.id}:${p.outcome}:${Math.round(p.cashedOut * 1e9)}`)
    .join("|");
  const events = res.events
    .map((e) => `${e.tick}:${e.killed}:${e.cashedOut}:${Math.round(e.q * 1e9)}`)
    .join("|");
  return `${res.ticks};${players};${events}`;
}
