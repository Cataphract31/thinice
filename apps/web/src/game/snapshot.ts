import type {
  AutoSettings,
  ChatMsg,
  PlayerStats,
  PlayerView,
  Snapshot,
  WinnerInfo,
} from "./client";
import { DEFAULT_CONFIG } from "@zinc/engine";

// The server's state frame is spread over safe defaults NO MORE. Every field
// is coerced here, at the boundary: one malformed frame degrades to defaults
// instead of handing a null to the first .toFixed() in the tree.

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const bool = (v: unknown, fallback = false): boolean =>
  typeof v === "boolean" ? v : fallback;

function phase(v: unknown): Snapshot["phase"] {
  return v === "live" || v === "result" ? v : "lobby";
}

function outcome(v: unknown): PlayerView["outcome"] {
  return v === "cashed" || v === "dead" || v === "in" ? v : "dead";
}

function playerView(v: unknown): PlayerView {
  const r = (v ?? {}) as Record<string, unknown>;
  let lifetime: PlayerView["lifetime"];
  if (r.lifetime && typeof r.lifetime === "object") {
    const l = r.lifetime as Record<string, unknown>;
    lifetime = {
      wagered: num(l.wagered),
      net: num(l.net),
      hitRate: num(l.hitRate),
      best: num(l.best),
    };
  }
  return {
    id: num(r.id),
    name: str(r.name),
    you: bool(r.you),
    charId: str(r.charId, "chad"),
    outcome: outcome(r.outcome),
    multiple: num(r.multiple),
    balance: num(r.balance),
    ticksSurvived: num(r.ticksSurvived),
    lastStanding: r.lastStanding === true ? true : undefined,
    lifetime,
  };
}

function winnerInfo(v: unknown): WinnerInfo | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name === "") return null;
  return {
    name: r.name,
    charId: str(r.charId, "chad"),
    you: bool(r.you),
    multiple: num(r.multiple),
    amount: num(r.amount),
    lastStanding: bool(r.lastStanding),
    tied: r.tied === undefined ? undefined : num(r.tied, 1),
  };
}

function autoSettings(v: unknown): AutoSettings {
  const r = (v ?? {}) as Record<string, unknown>;
  return {
    enabled: bool(r.enabled),
    target: num(r.target, 2),
    plates: num(r.plates, 1),
  };
}

function playerStats(v: unknown): PlayerStats {
  const r = (v ?? {}) as Record<string, unknown>;
  return {
    roundsPlayed: num(r.roundsPlayed),
    roundsWon: num(r.roundsWon),
    wagered: num(r.wagered),
    returned: num(r.returned),
    bestMultiple: num(r.bestMultiple),
  };
}

export interface ServerStateFrame {
  snapshot: Omit<Snapshot, "chat" | "history" | "connected" | "seat" | "stats" | "online">;
  stats: PlayerStats;
  online: number;
}

export function toServerState(raw: unknown): ServerStateFrame {
  const s = (raw ?? {}) as Record<string, unknown>;

  const youRaw = (s.you ?? {}) as Record<string, unknown>;
  const platesRaw = (youRaw.plates ?? {}) as Record<string, unknown>;
  const locked = youRaw.lockedMultiple;
  const teamWins: Record<string, number> = {};
  if (s.teamWins && typeof s.teamWins === "object" && !Array.isArray(s.teamWins)) {
    for (const [k, v] of Object.entries(s.teamWins as Record<string, unknown>)) {
      teamWins[k] = num(v);
    }
  }
  const players = Array.isArray(s.players) ? s.players.map(playerView) : [];

  const liveCount = players.filter((p) => p.outcome === "in").length;
  const deadCount = players.filter((p) => p.outcome === "dead").length;
  const cashedCount = players.filter((p) => p.outcome === "cashed").length;

  return {
    online: num(s.online),
    stats: playerStats(s.stats),
    snapshot: {
      phase: phase(s.phase),
      roundId: Math.trunc(num(s.roundId)),
      tick: Math.trunc(num(s.tick)),
      multiplier: num(s.multiplier, 1),
      hazard: num(s.hazard),
      grace: bool(s.grace),
      graceRemaining: Math.trunc(num(s.graceRemaining)),
      msToPhaseEnd: Math.max(0, num(s.msToPhaseEnd)),
      players,
      liveCount,
      totalCount: players.length,
      deadCount,
      cashedCount,
      potInPlay: num(s.potInPlay),
      entry: num(s.entry, DEFAULT_CONFIG.entry),
      you: {
        joined: bool(youRaw.joined),
        outcome:
          youRaw.outcome === "out" ||
          youRaw.outcome === "in" ||
          youRaw.outcome === "cashed" ||
          youRaw.outcome === "dead"
            ? youRaw.outcome
            : "out",
        balance: num(youRaw.balance),
        multiple: num(youRaw.multiple),
        lockedMultiple: locked === null ? null : num(locked),
        plates: {
          total: Math.trunc(num(platesRaw.total)),
          alive: Math.trunc(num(platesRaw.alive)),
          cashed: Math.trunc(num(platesRaw.cashed)),
          dead: Math.trunc(num(platesRaw.dead)),
          max: Math.trunc(num(platesRaw.max, 5)),
        },
      },
      wallet: num(s.wallet),
      session: num(s.session),
      charId: str(s.charId, "chad"),
      winner: winnerInfo(s.winner),
      teamWins,
      nextCommit: str(s.nextCommit),
      auto: autoSettings(s.auto),
    },
  };
}

export function toChatMsg(r: Record<string, unknown>): ChatMsg {
  return {
    id: Math.trunc(num(r.id)),
    name: str(r.name),
    charId: str(r.charId, "chad"),
    text: str(r.text),
    at: num(r.at, Date.now()),
    you: bool(r.you),
  };
}
