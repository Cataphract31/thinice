import {
  canonicalConfig,
  outcomeDigest,
  replayRound,
  rngFromSeedHex,
  verifyBonanzaDraw,
  type GameConfig,
  type RoundRecord,
} from "@zinc/engine";

/**
 * The client's shared contract: the Snapshot every component renders, and the
 * fairness verification that replays finished rounds from their revealed
 * seeds. The game itself lives on the server; NetClient consumes it.
 */

export type Phase = "lobby" | "live" | "result";

export interface PlayerView {
  id: number;
  name: string;
  you: boolean;
  charId: string;
  outcome: "in" | "cashed" | "dead";
  /** Multiple of the entry paid. 1.00 is break-even. */
  multiple: number;
  balance: number;
  /** Ticks spent standing on the ice. Still climbing while they are alive. */
  ticksSurvived: number;
  /**
   * True for the plate(s) that stood until the very end — the engine's sole
   * survivor, or a sole owner's auto-banked plates. Everyone else's "cashed"
   * means THEY LEFT, and the end-screen board draws the two differently:
   * leavers ghost out, the one who stood stays standing.
   */
  lastStanding?: boolean;
  /**
   * Lifetime record as of joining this round, for the profile card. Net
   * includes rakeback and jackpot winnings — the wallet's true result
   * against the house, not just round settlements.
   *
   * No plate count: entry is fixed, so it is `wagered / entry` — the same
   * fact in different units. `hitRate` and `best` are the style tells that
   * separate a nit from someone who rides every plate into the red zone.
   */
  lifetime?: {
    wagered: number;
    net: number;
    /** Share of plates that came back at or above the entry, 0-1. */
    hitRate: number;
    best: number;
    jackpots: number;
    /**
     * Actual holdings — bonanza tickets in circulation / lifetime rev-share
     * tickets — the same pair the owner's tickets stat shows. Not the flat
     * per-entry award, which is the same number for everyone.
     */
    tickets?: { bon: number; rev: number };
  };
}

/** Who the winner scene celebrates once a round ends. */
export interface WinnerInfo {
  name: string;
  charId: string;
  you: boolean;
  multiple: number;
  amount: number;
  /** True: outlasted everyone. False: nobody survived, best extraction shown. */
  lastStanding: boolean;
  /**
   * Distinct wallets sharing the top extraction. Everyone extracting at the
   * same multiple is common (any simultaneous exit ties exactly), and
   * crowning one of them "best" is a coin flip dressed as a verdict — above
   * 1 the scene says "dead heat" instead.
   */
  tied?: number;
}

export interface BonanzaEvent {
  amount: number;
  winner: string;
  youWon: boolean;
  /** When it fired, so the overlay knows how far through the sequence it is. */
  at: number;
}

/** One line of table talk. */
export interface ChatMsg {
  id: number;
  name: string;
  charId: string;
  text: string;
  at: number;
  you: boolean;
  /** Server notices ("slow down") rendered dim, without an avatar. */
  system?: boolean;
}

export interface AutoSettings {
  /** Enters every round automatically while the wallet covers the entry. */
  enabled: boolean;
  /**
   * Extracts the first tick the shared multiplier reaches this. Steps are
   * discrete, so the exit banks whatever the multiple actually is when it
   * crosses: never below the target, sometimes above it.
   */
  target: number;
  /** Plates auto play buys each round, 1 up to the per-wallet cap. */
  plates: number;
}

export interface Snapshot {
  phase: Phase;
  roundId: number;
  tick: number;
  /** Shared by everyone still inside: balance / entry. */
  multiplier: number;
  /**
   * The rate the NEXT roll will run at, given the field as it stands now.
   * The engine's own `hazard` is backward-looking (the tick that already
   * resolved), which left the meter showing the pre-shatter rate for a full
   * tick after a mass death — the exact unresponsiveness the hazard curve was
   * tuned to avoid.
   */
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
    /** Blended across your plates: total value over total staked. */
    multiple: number;
    lockedMultiple: number | null;
    /** Your plates this round. Multi-betting is buying more than one. */
    plates: { total: number; alive: number; cashed: number; dead: number; max: number };
  };
  wallet: number;
  session: number;
  bonanzaPool: number;
  /** Rounds finished since the jackpot last fired: the drought counter. */
  bonanzaDrought: number;
  bonanzaTickets: number;
  revShareTickets: number;
  /** Set for a few seconds after the jackpot fires, then cleared. */
  bonanza: BonanzaEvent | null;
  /** Your chosen character. */
  charId: string;
  /** Set through the result phase, null once the next lobby opens. */
  winner: WinnerInfo | null;
  /** All-time wins per character, the team dominance record. */
  teamWins: Record<string, number>;
  /** Your standing in both ticket economies, ready to display. */
  tickets: {
    /** Bonanza: your tickets over everything circulating since the last fire. */
    bonYours: number;
    bonTotal: number;
    /** Your odds of taking the next fire, 0-1. */
    bonShare: number;
    /** Rev share: your slice of the stream as it stands right now, 0-1. */
    revShare: number;
    /** Everything the stream has ever paid you. */
    revStreamed: number;
  };
  /**
   * The room's talk, oldest first. Server-relayed in networked play; in the
   * demo it is only your own echo, and the panel says so.
   */
  chat: ChatMsg[];
  /** Finished rounds, newest first, each replayable and verifiable. */
  history: HistoryEntry[];
  /** Fairness commitment for the round currently forming or running. */
  nextCommit: string;
  auto: AutoSettings;
  /** Lifetime record. Server-authoritative in net play, local in the demo. */
  stats: PlayerStats;
  /** Humans connected right now. Always 1 offline. */
  online: number;
  /** False while the socket is down, so the UI can say so instead of freezing. */
  connected: boolean;
  /**
   * On-chain banking, networked mode with a real wallet only. Absent in the
   * demo and for guests — there is no chain identity to move money for.
   */
  bank?: BankState;
  /**
   * WHO the server actually seated, networked play only. The wallet button
   * must render this — Phantom's own connect state can disagree with it (an
   * expired session seats a guest while the extension still shows the
   * address), and the seat is the identity money moves under.
   */
  seat?: { guest: boolean; address: string };
  /** Rakeback that streamed in while the tab was closed. One-shot recap,
      shown as a welcome-back card; null or absent when there is nothing. */
  away?: { ms: number; sol: number } | null;
  /** Recent jackpot hits, newest first, for the bonanza history popover. */
  bonanzaFires?: { round: number; name: string; charId: string; sol: number; at: number }[];
}

export interface BankState {
  /** Where deposits go: the house account this server pays from and into. */
  house: string;
  /** True while a deposit or withdrawal is in flight. */
  busy: boolean;
  /** Outcome of the last operation, for the panel to show. */
  note: string;
  /** True when the last note is a success, false for a failure, null idle. */
  ok: boolean | null;
}

export interface PlayerStats {
  roundsPlayed: number;
  /** Rounds that came back at or above the entry. */
  roundsWon: number;
  /** Everything ever staked. */
  wagered: number;
  /** Everything ever paid back. */
  returned: number;
  bestMultiple: number;
  /** Lifetime rakeback received. */
  revEarned: number;
  /**
   * Lifetime jackpot winnings. Paid straight to the balance rather than
   * through a round settlement, so it is not part of `returned` and has to be
   * carried separately or the record understates by the whole pool.
   */
  bonanzaWon?: number;
}

/**
 * The ledger identity for "you" in the demo, and the base id for your plates.
 * Multi-betting gives you several PLATE ids in a round (YOU_BASE + i), but
 * tickets and rakeback accrue under the single YOU_ID so persistence and the
 * standings read one player, however many plates they stood on.
 */
const YOU_ID = 9999;
const YOU_BASE = 9900;
/**
 * The restored crowd, as one ledger id. Plate ids are non-negative and YOU
 * lives above YOU_BASE, so a negative id can never collide with either.
 */
const CROWD_ID = -2;
const MAX_PLATES = 5;
const isYou = (id: number): boolean => id >= YOU_BASE;

/**
 * sha256 as lowercase hex, or null where the browser will not provide it.
 *
 * `crypto.subtle` does not exist on an insecure origin — testing over a LAN
 * IP, for instance. Returning null rather than "" matters: an empty string
 * compares unequal to the commitment and would brand every honest round a
 * mismatch, which is the single worst thing this panel could say.
 */
export async function sha256Hex(s: string): Promise<string | null> {
  if (!crypto?.subtle) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function commitPreimage(roundId: number, seedHex: string, rulesHash: string): string {
  return `thinice:${roundId}:${seedHex}:${rulesHash}`;
}

/*
 * The offline demo lived below this point until 2026-08-10: a full in-browser
 * simulation of the game against a generated crowd, with its own localStorage
 * ledger. It reached production once, wearing the live game's face, because
 * a deploy that lost its server URL fell back to it silently. It is deleted
 * rather than hidden: this repository builds exactly one thing, the client of
 * a real server. The sandbox lives on in the private dev overlay.
 */

/**
 * The verification both clients run. One implementation on purpose: the local
 * demo and the networked build must reach a verdict the same way, or the demo
 * proves nothing about the thing players will actually be paid by.
 *
 * Mutates the entry in place with its three receipts.
 */
export async function verifyEntry(h: HistoryEntry, expected: GameConfig): Promise<void> {
  try {
    // A row whose record could not even be parsed is UNVERIFIABLE, which is a
    // different statement from "this round was rigged". Saying the second when
    // you only know the first is the exact accusation this panel must never
    // make by accident.
    if (h.unavailable) {
      h.seedOk = h.replayOk = h.rulesOk = h.verified = null;
      return;
    }

    // Replay under the rules recorded with the round, not the ones this build
    // ships: a round played before a config change is still an honest round.
    const rules = h.record.config ?? expected;
    const replay = replayRound(rules, h.record);
    h.replayOk = outcomeDigest(replay) === h.digest;

    // Your own money, checked against the round rather than taken on trust.
    // Multi-betting means several seats; the claim is the BLENDED multiple,
    // so the check sums every one of your plates in the replay.
    const seats = h.yourSeats ?? [];
    if (seats.length === 0) {
      h.payoutOk = null;
    } else {
      const mine = replay.players.filter((p) => seats.includes(p.id));
      const claimed = h.yourMultiple ?? 0;
      const actual =
        mine.length > 0
          ? mine.reduce((a, p) => a + p.cashedOut, 0) / (rules.entry * seats.length)
          : -1;
      // Lamport-scale tolerance: both sides are floats derived by division.
      h.payoutOk = mine.length === seats.length && Math.abs(actual - claimed) < 1e-6;
    }

    // THE binding check. The replay runs on record.seedHex; the commitment is
    // checked against the row's seedHex. Nothing else forces those to be the
    // same value, and if they can differ then an operator commits to seed A,
    // plays the round on seed B, and ships {commit(A), A, record(B)}: the
    // replay agrees with itself, the hash agrees with itself, and a rigged
    // round renders three green ticks. The two seeds must be one seed.
    const seedsAgree =
      h.record.seedHex !== undefined && h.record.seedHex === h.seedHex;

    // Likewise the commitment must be the one this client SAW before the round
    // sealed. Checking a server-supplied seed against a server-supplied hash
    // that arrived in the same message proves only that the server can run
    // sha256: any seed picked after the fact hashes to a commitment computed
    // after the fact. `observedCommit` is what was on screen during the lobby.
    const commitPinned = h.observedCommit === undefined || h.observedCommit === h.commit;

    const canonical = canonicalConfig(rules);
    const rulesHash = await sha256Hex(canonical);
    if (rulesHash === null) {
      // No hashing available (insecure origin). Refuse to render a verdict
      // rather than report a mismatch we have not actually found.
      h.unavailable = true;
      h.seedOk = null;
      h.rulesOk = null;
      h.verified = null;
      return;
    }

    if (h.record.seedHex === undefined) {
      // A round from before the rules were folded into the commitment. Check
      // it against the ceremony it was actually played under rather than
      // calling it a mismatch: the old commitment covered the seed alone, so
      // that is exactly — and only — what can honestly be verified about it.
      h.seedOk =
        commitPinned &&
        h.commit !== "" &&
        (await sha256Hex(`thinice:${h.roundId}:${h.seedHex}`)) === h.commit;
      h.rulesOk = null;
      h.bonanzaOk = null;
      h.verified = h.replayOk === true && h.seedOk === true;
      return;
    }

    const hash = await sha256Hex(commitPreimage(h.roundId, h.seedHex, rulesHash));
    h.seedOk = seedsAgree && commitPinned && h.commit !== "" && hash === h.commit;
    h.rulesOk = canonical === canonicalConfig(expected);
    h.bonanzaOk = verifyBonanzaDraw(h.record);
    // Null receipts are "nothing to check here", not failures — only an
    // outright false may condemn a round.
    h.verified =
      h.replayOk === true &&
      h.seedOk === true &&
      h.rulesOk === true &&
      h.bonanzaOk !== false &&
      h.payoutOk !== false;
  } catch {
    h.verified = false;
    h.seedOk = h.seedOk ?? false;
    h.replayOk = h.replayOk ?? false;
    h.rulesOk = h.rulesOk ?? false;
  }
}

/** One finished round, carrying everything needed to re-verify it in-browser. */
export interface HistoryEntry {
  roundId: number;
  entrants: number;
  ticks: number;
  joined: boolean;
  yourOutcome: "none" | "cashed" | "dead";
  yourMultiple: number | null;
  bestMultiple: number;
  /** Published before the round sealed — as reported with the finished round. */
  commit: string;
  /**
   * The commitment this client actually saw on screen while the round was
   * still forming, recorded at the time. Undefined when the round predates
   * this client's connection, in which case there is nothing to compare and
   * the check is skipped rather than failed.
   */
  observedCommit?: string;
  /** Revealed once the round ends. */
  seedHex: string;
  /** null = not yet checked; then the verdict of the in-browser replay. */
  verified: boolean | null;
  /** Receipt: does the revealed seed hash to the pre-published commitment? */
  seedOk: boolean | null;
  /** Receipt: did the replay reproduce every tick and every balance? */
  replayOk: boolean | null;
  /**
   * Receipt: were the rules this round ran under the same rules this build
   * advertises? A round can replay perfectly under rigged numbers, so without
   * this check the other two prove only internal consistency.
   */
  rulesOk: boolean | null;
  /**
   * Receipt: did the jackpot draw come off the committed seed? Null for
   * rounds recorded before the draw was folded into the record.
   */
  bonanzaOk: boolean | null;
  /**
   * Receipt: does the replayed round pay YOUR seat exactly what this row says
   * you were paid? Null when the round did not report a seat. Without it the
   * other receipts prove the round was honest in the abstract while the line
   * describing your own result remains an unchecked claim.
   */
  payoutOk: boolean | null;
  /** Your plates in that round, from the server's entry rows. */
  yourSeats?: number[] | null;
  /**
   * True when no verdict is honest at all: the browser cannot hash (insecure
   * origin), or the round's record could not be parsed. Not a mismatch.
   */
  unavailable?: boolean;
  record: RoundRecord;
  digest: string;
  /** Who took the round, for the champions strip and the team tally. */
  winnerChar: string | null;
  winnerYou: boolean;
}

