import {
  canonicalConfig,
  outcomeDigest,
  replayRound,
  roundSeedPreimage,
  type GameConfig,
  type RoundRecord,
} from "@zinc/engine";

export type Phase = "lobby" | "live" | "result";

export interface PlayerView {
  id: number;
  name: string;
  you: boolean;
  charId: string;
  outcome: "in" | "cashed" | "dead";
  multiple: number;
  balance: number;
  ticksSurvived: number;
  lastStanding?: boolean;
  lifetime?: {
    wagered: number;
    net: number;
    hitRate: number;
    best: number;
  };
}

export interface WinnerInfo {
  name: string;
  charId: string;
  you: boolean;
  multiple: number;
  amount: number;
  lastStanding: boolean;
  tied?: number;
}

export interface ChatMsg {
  id: number;
  name: string;
  charId: string;
  text: string;
  at: number;
  you: boolean;
  system?: boolean;
}

export interface AutoSettings {
  enabled: boolean;
  target: number;
  plates: number;
}

export interface Snapshot {
  phase: Phase;
  roundId: number;
  tick: number;
  multiplier: number;
  hazard: number;
  grace: boolean;
  graceRemaining: number;
  msToPhaseEnd: number;
  players: PlayerView[];
  liveCount: number;
  totalCount: number;
  deadCount: number;
  cashedCount: number;
  potInPlay: number;
  entry: number;
  you: {
    joined: boolean;
    outcome: "out" | "in" | "cashed" | "dead";
    balance: number;
    multiple: number;
    lockedMultiple: number | null;
    plates: { total: number; alive: number; cashed: number; dead: number; max: number };
  };
  wallet: number;
  session: number;
  charId: string;
  winner: WinnerInfo | null;
  teamWins: Record<string, number>;
  chat: ChatMsg[];
  history: HistoryEntry[];
  nextCommit: string;
  auto: AutoSettings;
  stats: PlayerStats;
  online: number;
  connected: boolean;
  seat?: { guest: boolean; address: string };
}

export interface PlayerStats {
  roundsPlayed: number;
  roundsWon: number;
  wagered: number;
  returned: number;
  bestMultiple: number;
}

export async function sha256Hex(s: string): Promise<string | null> {
  if (!crypto?.subtle) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function commitPreimage(
  roundId: number,
  secretHex: string,
  rulesHash: string,
  ceremony = 2,
): string {
  const tag = ceremony > 1 ? `thinice:${ceremony}` : "thinice";
  return `${tag}:${roundId}:${secretHex}:${rulesHash}`;
}

export async function verifyEntry(h: HistoryEntry, expected: GameConfig): Promise<void> {
  try {
    if (h.unavailable) {
      h.seedOk = h.replayOk = h.rulesOk = h.verified = null;
      return;
    }

    const rules = h.record.config ?? expected;

    const interrupted = h.record.interrupted === true;
    const replay = interrupted ? null : replayRound(rules, h.record);
    h.replayOk = replay ? outcomeDigest(replay) === h.digest : null;

    const seats = h.yourSeats ?? [];
    if (seats.length === 0 || !replay) {
      h.payoutOk = null;
    } else {
      const mine = replay.players.filter((p) => seats.includes(p.id));
      const claimed = h.yourMultiple ?? 0;
      const actual =
        mine.length > 0
          ? mine.reduce((a, p) => a + p.cashedOut, 0) / (rules.entry * seats.length)
          : -1;
      h.payoutOk = mine.length === seats.length && Math.abs(actual - claimed) < 1e-6;
    }

    const rec = h.record;
    const ceremony = rec.sealNonce !== undefined ? 2 : 1;
    let seedsAgree: boolean;
    if (ceremony === 1) {
      seedsAgree = rec.seedHex !== undefined && rec.seedHex === h.seedHex;
    } else if (interrupted && !rec.seedHex) {
      seedsAgree = true;
    } else {
      const derived = await sha256Hex(
        roundSeedPreimage(h.seedHex, rec.sealNonce ?? "", rec.entrantIds),
      );
      seedsAgree = derived !== null && rec.seedHex === derived;
    }

    const commitPinned = h.observedCommit === undefined || h.observedCommit === h.commit;

    const canonical = canonicalConfig(rules);
    const rulesHash = await sha256Hex(canonical);
    if (rulesHash === null) {
      h.unavailable = true;
      h.seedOk = null;
      h.rulesOk = null;
      h.verified = null;
      return;
    }

    const hash = await sha256Hex(commitPreimage(h.roundId, h.seedHex, rulesHash, ceremony));
    h.seedOk = seedsAgree && commitPinned && h.commit !== "" && hash === h.commit;
    h.rulesOk = canonical === canonicalConfig(expected);
    h.verified =
      h.replayOk !== false &&
      h.seedOk === true &&
      h.rulesOk === true &&
      h.payoutOk !== false;
  } catch {
    h.verified = false;
    h.seedOk = h.seedOk ?? false;
    h.replayOk = h.replayOk ?? false;
    h.rulesOk = h.rulesOk ?? false;
  }
}

export interface HistoryEntry {
  roundId: number;
  entrants: number;
  ticks: number;
  joined: boolean;
  yourOutcome: "none" | "cashed" | "dead";
  yourMultiple: number | null;
  bestMultiple: number;
  commit: string;
  observedCommit?: string;
  seedHex: string;
  verified: boolean | null;
  seedOk: boolean | null;
  replayOk: boolean | null;
  rulesOk: boolean | null;
  payoutOk: boolean | null;
  yourSeats?: number[] | null;
  unavailable?: boolean;
  record: RoundRecord;
  digest: string;
  winnerChar: string | null;
  winnerYou: boolean;
}
