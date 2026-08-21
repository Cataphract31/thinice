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
  seat?: { spectator: boolean; address: string };
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
    h.checked = true;
    if (h.unavailable) {
      h.seedOk = h.replayOk = h.rulesOk = h.payoutOk = null;
      h.unwitnessed = undefined;
      h.verified = null;
      return;
    }

    // The commitment check means something ONLY if this browser saw the
    // commitment during a lobby and pinned it before the round ran, and the
    // commit that arrives with the finished round is still that same one. A
    // commit, seed and record that all arrive together after the fact are
    // self-consistent by construction; "verified" would prove nothing beyond
    // that the server can run sha256. Unwitnessed rounds still get every
    // self-consistency check below, but they can never earn the badge.
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
    const sealed = typeof rec.sealNonce === "string" && rec.sealNonce !== "";
    let seedsAgree: boolean | null;
    if (ceremony === 1) {
      seedsAgree = rec.seedHex !== undefined && rec.seedHex === h.seedHex;
    } else if (!sealed) {
      // The lobby never sealed: no seed was ever drawn, so there is nothing
      // for a seed check to say either way.
      seedsAgree = null;
    } else if (interrupted && !rec.seedHex) {
      seedsAgree = null;
    } else {
      const derived = await sha256Hex(
        roundSeedPreimage(h.seedHex, rec.sealNonce ?? "", rec.entrantIds),
      );
      seedsAgree = derived !== null && rec.seedHex === derived;
    }

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
    const commitMatches = hash !== null && h.commit !== "" && hash === h.commit;
    const seen = h.observedCommit !== undefined;
    const pinned = seen && h.observedCommit === h.commit;
    h.unwitnessed = !seen || undefined;
    // Tri-state on purpose: false only when something was CHECKED and failed,
    // null when the check could not run (never witnessed, or no sealed seed).
    h.seedOk = !seen
      ? null
      : !pinned || !commitMatches
        ? false
        : seedsAgree === false
          ? false
          : seedsAgree === true
            ? true
            : null;
    h.rulesOk = canonical === canonicalConfig(expected);
    const clean =
      h.replayOk === true &&
      h.seedOk === true &&
      h.rulesOk === true &&
      h.payoutOk !== false;
    const broken =
      h.replayOk === false ||
      h.seedOk === false ||
      h.rulesOk === false ||
      h.payoutOk === false;
    h.verified =
      !seen || interrupted ? null : clean ? true : broken ? false : null;
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
  /** this browser never saw the lobby, so the commitment could not be pinned */
  unwitnessed?: boolean;
  /** verifyEntry has run at least once */
  checked?: boolean;
  record: RoundRecord;
  digest: string;
  winnerChar: string | null;
  winnerYou: boolean;
}
