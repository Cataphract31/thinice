import {
  BonanzaPool,
  DEFAULT_CONFIG,
  RevShareLedger,
  Round,
  BONANZA_TAG,
  canonicalConfig,
  deriveRng,
  drawFieldSize,
  hazardAt,
  mulberry32,
  outcomeDigest,
  replayRound,
  rngFromSeedHex,
  totalRake,
  verifyBonanzaDraw,
  type Entrant,
  type GameConfig,
  type Player,
  type Rng,
  type RoundRecord,
  type Strategy,
} from "@zinc/engine";
import { fakeAddress, shortAddress } from "./names";
import { CHARACTERS, charById } from "./chars";
import { riskScale } from "./risk";
import {
  sfxBonanza,
  sfxExtract,
  sfxJoin,
  sfxSeal,
  sfxShatter,
  sfxTick,
  sfxYouDied,
} from "../audio/sound";

/**
 * Local game driver for the prototype.
 *
 * Runs the real engine against bots on a wall clock, so the UI is developed
 * against genuine round dynamics rather than hand-waved animation. The whole
 * economy runs through the engine's own ledgers — the jackpot draw is
 * ticket-weighted across rounds via `BonanzaPool`, and the rakeback stream
 * accrues and pays through `RevShareLedger` — so the client's numbers cannot
 * drift from what the simulator certifies.
 *
 * In production this class is replaced by a websocket client consuming
 * server-authoritative round state; everything downstream of `Snapshot` stays
 * exactly as it is. NOTE the RNG seeding here is prototype-only: a live
 * deployment derives round seeds from a commit-reveal scheme on the server,
 * never from wall-clock time in the browser.
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

const SAVE_KEY = "zinc.save.v1";

interface SaveState {
  wallet: number;
  session: number;
  pool: number;
  bTickets: number;
  revLifetime: number;
  revWeight: number;
  autoEnabled?: boolean;
  autoTarget?: number;
  autoPlates?: number;
  charId?: string;
  revStreamed?: number;
  teamWins?: Record<string, number>;
  roundId?: number;
  stats?: PlayerStats;
  /** Round the jackpot last fired in, so the drought survives a reload. */
  lastFire?: number;
  /**
   * The CROWD's side of both ledgers, as one aggregate each. Restoring only
   * your own tickets and weight made you the sole holder after every reload:
   * the popover showed 100% bonanza odds, and the first seal handed your
   * whole historical weight the round's rakeback against one round of fresh
   * bot tickets — reload-spam was a faucet.
   */
  crowdBTickets?: number;
  crowdRevWeight?: number;
}

/**
 * Any stored value, forced to a real number. A save from an older schema (or
 * an edited one) carries undefined where a number is expected, and feeding
 * that into the ledgers poisons the totals with NaN — after which every
 * percentage in the HUD reads "NaN%" and no reload fixes it, because the bad
 * value is what got persisted.
 */
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function loadSave(): SaveState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SaveState;
    if (!Number.isFinite(s.wallet)) return null;
    return {
      ...s,
      wallet: num(s.wallet),
      session: num(s.session),
      pool: num(s.pool),
      bTickets: num(s.bTickets),
      revLifetime: num(s.revLifetime),
      revWeight: num(s.revWeight),
      revStreamed: num(s.revStreamed),
      autoTarget: num(s.autoTarget, 2),
      roundId: num(s.roundId),
      lastFire: num(s.lastFire),
      crowdBTickets: num(s.crowdBTickets),
      crowdRevWeight: num(s.crowdRevWeight),
    };
  } catch {
    return null;
  }
}

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

export class GameClient {
  /** Discriminant: the dev tools only make sense against the local driver. */
  readonly isLocal = true;
  private config: GameConfig = DEFAULT_CONFIG;
  private stats: PlayerStats = {
    roundsPlayed: 0,
    roundsWon: 0,
    wagered: 0,
    returned: 0,
    bestMultiple: 0,
    revEarned: 0,
    bonanzaWon: 0,
  };
  /** Presentation-side randomness only: bot personalities, names, arrivals. */
  private rng = mulberry32((Date.now() & 0xffffffff) >>> 0);
  /**
   * The round's own seed, drawn from the platform CSPRNG and committed to via
   * sha256 before the round seals. Bots never touch this stream — the round
   * consumes it in a fixed pattern, which is what makes replay verification
   * possible. In production the server runs this same ceremony and the
   * client only checks it.
   */
  private roundSeedHex = "";
  private roundCommit = "";
  /** Hash of the rules each round is committed under, alongside the seed. */
  private rulesHash = "";
  /** The exact rules the sealed round is running, recorded for replay. */
  private roundRules: GameConfig | null = null;
  private history: HistoryEntry[] = [];
  private round: Round | null = null;
  private phase: Phase = "lobby";
  private phaseEnd = 0;
  // openLobby increments first, so the first round players see is #1.
  private roundId = 0;
  private names = new Map<number, string>();
  /** How many plates you bought this round. 0 = spectating. */
  private youPlates = 0;
  private lobbyEntrants: Entrant[] = [];
  /** Wall-clock time each bot walks into the lobby, so the room fills visibly. */
  private arrivals = new Map<number, number>();
  private loopTimer: number | null = null;
  /** Absolute time the next tick fires. Advanced by the interval on each fire,
   * so the realised period averages exactly tickMs instead of quantising up to
   * the driver interval and drifting ~12% slow. */
  private nextTickAt = 0;
  private lastSig = "";

  wallet = 5;
  session = 0;

  /** The real jackpot: cross-round ticket-weighted, funded per round. */
  private jackpot: BonanzaPool;
  /** The real rakeback stream. Your earnings are auto-claimed into the wallet. */
  private revShare: RevShareLedger;
  private rakebackClaimed = 0;
  /** Everything the stream has ever paid you, across sessions. Display only. */
  private revStreamedLifetime = 0;

  private bonanza: BonanzaEvent | null = null;
  private winner: WinnerInfo | null = null;
  /** Round the demo jackpot last fired in, for the drought counter. */
  private lastFireRound = 0;
  /** Set when the round ended because one owner held every live plate. */
  private soleOwnerKey: string | null = null;
  /** Owner that banked on the very tick every other standing player died:
   *  faced the final roll, survived it — the survivor's claim. */
  private outlastedKey: string | null = null;
  /** Demo chat is an echo chamber — there is nobody on the other end. */
  private chatLog: ChatMsg[] = [];
  private nextChatId = 1;
  private teamWins: Record<string, number> = {};
  /**
   * Your character. Drawn at random on a first visit rather than defaulting
   * everyone to the same face, then remembered; bots get theirs per lobby in
   * `charMap`.
   */
  charId: string = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)]!.id;
  private charMap = new Map<number, string>();
  auto: AutoSettings = { enabled: false, target: 2, plates: 1 };

  private listeners = new Set<(s: Snapshot) => void>();

  constructor() {
    // Restore the player's standing from the last visit. In production this
    // state lives on the server and on-chain; locally it just means a refresh
    // doesn't wipe your wallet, tickets, and the jackpot pool.
    const save = loadSave();
    this.jackpot = new BonanzaPool(DEFAULT_CONFIG.bonanza, save?.pool ?? 412.7);
    this.revShare = new RevShareLedger(DEFAULT_CONFIG.revShare);
    if (save) {
      this.wallet = save.wallet;
      this.session = save.session;
      if (save.bTickets > 0) this.jackpot.credit(YOU_ID, save.bTickets);
      this.revShare.restore(YOU_ID, save.revLifetime, save.revWeight, Date.now());
      // The crowd's side comes back too, or you are the only holder in both
      // economies after a reload — 100% displayed bonanza odds, and the next
      // seal's rakeback distributed almost entirely to you (see SaveState).
      if ((save.crowdBTickets ?? 0) > 0) this.jackpot.credit(CROWD_ID, save.crowdBTickets!);
      if ((save.crowdRevWeight ?? 0) > 0) {
        this.revShare.restore(CROWD_ID, 0, save.crowdRevWeight!, Date.now());
      }
      if (typeof save.autoTarget === "number" && save.autoTarget >= 1.05) {
        this.auto.target = save.autoTarget;
      }
      this.auto.enabled = save.autoEnabled === true;
      this.auto.plates = Math.min(MAX_PLATES, Math.max(1, Math.round(num(save.autoPlates, 1))));
      // charById falls back to the default character on any unknown slug.
      if (save.charId) this.charId = charById(save.charId).id;
      // Display lifetime only. The claim marker (rakebackClaimed) must NOT be
      // restored: the ledger's earnings counter restarts at zero each session,
      // and a restored marker would sit above it, silently blocking claims.
      this.revStreamedLifetime = save.revStreamed ?? 0;
      // Nested objects get the same scrubbing as the flat fields, and for the
      // same reason: an older or edited save missing one stat yields
      // `undefined + entry` = NaN on the next round, which is then persisted.
      // A NaN that survives reloads is the exact failure the scrub exists for,
      // and stopping at the top level left two doors open.
      if (save.teamWins && typeof save.teamWins === "object") {
        const wins: Record<string, number> = {};
        for (const [k, v] of Object.entries(save.teamWins)) {
          if (typeof v === "number" && Number.isFinite(v)) wins[k] = v;
        }
        this.teamWins = wins;
      }
      if (save.stats && typeof save.stats === "object") {
        const st = save.stats as Partial<PlayerStats>;
        this.stats = {
          roundsPlayed: num(st.roundsPlayed),
          roundsWon: num(st.roundsWon),
          wagered: num(st.wagered),
          returned: num(st.returned),
          bestMultiple: num(st.bestMultiple),
          revEarned: num(st.revEarned),
          bonanzaWon: num(st.bonanzaWon),
        };
      }
      // The round counter keeps climbing across refreshes instead of the
      // site appearing to reset to round one every visit.
      if (typeof save.roundId === "number" && save.roundId > 0) {
        this.roundId = save.roundId;
      }
      // Restored AFTER roundId so the drought (roundId - lastFireRound)
      // reads the real gap, not the whole round count since day one.
      this.lastFireRound = Math.min(num(save.lastFire), this.roundId);
    }

    this.openLobby();
    this.startLoop();
  }

  /**
   * One wall-clock loop drives everything: phase changes, ticks and repaints.
   *
   * An earlier version chained setTimeout per phase and cleared them on
   * teardown, which meant a single stray cleanup — React StrictMode's
   * mount/unmount/remount, for one — permanently stopped the clock. Deriving
   * every transition from Date.now() means the game cannot get stuck, and a
   * paused or backgrounded tab catches straight back up.
   */
  private startLoop(): void {
    if (this.loopTimer !== null) return;
    this.loopTimer = window.setInterval(() => this.loop(), 50);
  }

  private loop(): void {
    const now = Date.now();

    if (this.phase === "lobby") {
      if (now >= this.phaseEnd) {
        this.seal();
        return;
      }
    } else if (this.phase === "live") {
      if (now >= this.nextTickAt) {
        this.nextTickAt = Math.max(now + 20, this.nextTickAt + this.config.timing.tickMs);
        this.tick();
        return;
      }
    } else if (now >= this.phaseEnd) {
      this.openLobby();
      return;
    }

    // Repaint only when something visible changed: the countdown second, a
    // lobby arrival, a tick. The previous unconditional emit re-rendered the
    // entire React tree 12.5 times a second for a game that advances twice.
    const secs = Math.ceil(Math.max(0, this.phaseEnd - now) / 1000);
    const arrived = this.phase === "lobby" ? this.arrived().length : 0;
    const sig = `${this.phase}:${this.round?.currentTick ?? 0}:${secs}:${arrived}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.emit();
    }
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  /** Bots aim for a target multiple, with nerve deciding who bails when it gets hot. */
  private makeBotStrategy(): Strategy {
    const r = this.rng.next();
    const target =
      r < 0.32
        ? 1.15 + this.rng.next() * 0.35
        : r < 0.8
          ? 1.5 + -Math.log(Math.max(1e-9, this.rng.next())) * 1.0
          : 2.6 + -Math.log(Math.max(1e-9, this.rng.next())) * 3.2;
    const nerve = Math.pow(this.rng.next(), 1.3);
    // Expressed on the shared risk scale rather than as a raw rate. On the
    // knee scale these cover the same real-world hazards as always
    // (~1.7% to ~4.2%).
    const panicAt = 0.43 + this.rng.next() * 0.25;
    // Balances are quoted against the post-rake starting stake, so break-even
    // on the entry actually paid sits just above 1. Derived from the config,
    // not hardcoded — this was pinned at 0.07 and would have silently gone
    // stale the moment the rake moved.
    const breakEven = 1 / (1 - totalRake(this.config));

    return (ctx) => {
      // Nobody bails while the air still holds — there is nothing to flee.
      if (ctx.tick <= this.config.hazard.graceTicks) return false;
      // And nobody locks in a certain loss out of nerves.
      if (ctx.multiple < breakEven) return false;
      if (ctx.multiple >= target) return true;
      // Bot nerves roll on the CLIENT stream, never the round's. A strategy
      // that drew from the round RNG would shift the elimination sequence and
      // break replay verification.
      return riskScale(ctx.q) > panicAt && this.rng.next() < nerve * 0.16;
    };
  }

  /**
   * One decision per tick, shared by every plate an owner holds. A real
   * multi-bettor's cash-out extracts all their plates together; letting each
   * plate decide alone would split the stack and read as separate players.
   */
  private makeOwnerStrategy(plates: number): Strategy {
    const base = this.makeBotStrategy();
    if (plates <= 1) return base;
    let decidedTick = -1;
    let decision = false;
    return (ctx) => {
      if (ctx.tick !== decidedTick) {
        decidedTick = ctx.tick;
        decision = base(ctx);
      }
      return decision;
    };
  }

  private openLobby(): void {
    this.phase = "lobby";
    this.roundId++;
    this.youPlates = 0;
    this.soleOwnerKey = null;
    this.outlastedKey = null;
    this.round = null;
    this.names.clear();
    this.phaseEnd = Date.now() + this.config.timing.lobbyMs;

    // Commit-reveal: draw the round's seed from the CSPRNG and publish its
    // hash before anyone is even sealed in.
    // 128 bits. A 32-bit seed is enumerable against the published commitment
    // inside a lobby, which would turn the fairness proof into the exploit.
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    this.roundSeedHex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.roundCommit = "";
    const seedHex = this.roundSeedHex;
    const roundId = this.roundId;
    void (async () => {
      if (!this.rulesHash) this.rulesHash = (await sha256Hex(canonicalConfig(this.config))) ?? "";
      const h = await sha256Hex(commitPreimage(roundId, seedHex, this.rulesHash));
      // A late hash from a round that has already rolled must not overwrite
      // the current one.
      if (this.roundSeedHex !== seedHex) return;
      this.roundCommit = h ?? "";
      this.emit();
    })();

    const n = drawFieldSize(this.config, this.rng.next());
    const now = Date.now();
    this.bonanza = null;
    this.winner = null;
    this.lobbyEntrants = [];
    this.arrivals.clear();
    this.charMap.clear();
    // The field is generated as OWNERS, not plates: most walk in with one,
    // but some are multi-bettors holding a stack — one wallet, one face, one
    // shared cash-out — so the demo shows what other people's clusters look
    // like, exactly as the live game renders a real multi-plate wallet.
    let i = 0;
    while (i < n) {
      const take = Math.min(
        n - i,
        this.rng.next() < 0.8 ? 1 : 2 + Math.floor(this.rng.next() * 4),
      );
      // Every player is a wallet, shown ends-only like any on-chain platform.
      const name = shortAddress(fakeAddress(() => this.rng.next()));
      const char = CHARACTERS[Math.floor(this.rng.next() * CHARACTERS.length)]!.id;
      const strategy = this.makeOwnerStrategy(take);
      // Spread arrivals across most of the lobby so the shaft visibly fills
      // rather than blinking into existence fully populated. The draw leaves
      // room for the stack stagger below: at 0.78 a late-drawn multi-plate
      // stack's tail overran the lobby and popped in at the seal — the exact
      // blink the stagger exists to prevent.
      const spread =
        this.config.timing.lobbyMs * 0.78 - (take - 1) * 420;
      const arrive = now + this.rng.next() * Math.max(0, spread);
      for (let k = 0; k < take; k++, i++) {
        this.names.set(i, name);
        this.charMap.set(i, char);
        this.lobbyEntrants.push({ id: i, strategyId: "bot", strategy });
        // A stack's plates land seconds apart, like someone mashing bond.
        this.arrivals.set(i, arrive + k * 420);
      }
    }
    // Auto-entry walks in the moment the lobby opens, wallet permitting.
    if (this.auto.enabled) this.autoBuy();
    this.emit();
  }

  /** Buys plates until auto's count is held, the cap bites, or money runs out. */
  private autoBuy(): void {
    while (this.youPlates < this.auto.plates) {
      const before = this.youPlates;
      this.join();
      if (this.youPlates === before) break;
    }
  }

  /**
   * The rate the NEXT roll runs at, given the field as it stands right now.
   * Every risk channel — ring, seams, cracking, audio — reads this one number,
   * so they cannot disagree with each other.
   */
  private forwardHazard(): number {
    const round = this.round;
    if (!round || this.phase !== "live" || round.finished) return 0;
    const live = round.players.filter((p) => p.outcome === "in").length;
    if (live <= 0) return 0;
    // The round's own config, not the client's: an immortal test round runs
    // with the hazard zeroed, and reading the global config would show danger
    // on a lattice where nobody can actually fall through.
    return hazardAt(
      round.config.hazard,
      round.currentTick + 1,
      live,
      round.players.length,
    );
  }

  /** Bots that have walked in so far this lobby. */
  private arrived(): Entrant[] {
    const now = Date.now();
    return this.lobbyEntrants.filter((e) => (this.arrivals.get(e.id) ?? 0) <= now);
  }

  private seal(): void {
    for (let i = 0; i < this.youPlates; i++) {
      const id = YOU_BASE + i;
      this.names.set(id, "YOU");
      this.lobbyEntrants.push({ id, strategyId: "you", strategy: () => false });
    }
    this.roundRules = this.config;
    this.round = new Round(this.config, rngFromSeedHex(this.roundSeedHex), this.lobbyEntrants);
    this.phase = "live";
    this.nextTickAt = Date.now() + this.config.timing.tickMs;

    // Rakeback pays at the SEAL, same as the server: the rake is collected
    // the moment the field locks, so the guaranteed drip lands now and the
    // round's own win/loss arrives separately at the end — two legible money
    // moments instead of one muddled sum.
    const sealMs = Date.now();
    for (const e of this.lobbyEntrants) {
      this.revShare.credit(isYou(e.id) ? YOU_ID : e.id, sealMs);
    }
    this.revShare.distribute(
      this.lobbyEntrants.length * this.config.entry * this.config.rake.revShare,
      sealMs,
    );
    const owed = this.revShare.earningsOf(YOU_ID);
    const delta = owed - this.rakebackClaimed;
    if (delta > 0) {
      this.wallet += delta;
      this.session += delta;
      this.rakebackClaimed = owed;
      this.revStreamedLifetime += delta;
      this.stats.revEarned = this.revStreamedLifetime;
    }

    sfxSeal();
    this.emit();
  }

  private tick(): void {
    const round = this.round;
    if (!round || round.finished) {
      this.finish();
      return;
    }
    const before = new Map(round.players.map((p) => [p.id, p.outcome]));
    round.step();

    let deaths = 0;
    let youDied = false;
    for (const p of round.players) {
      const was = before.get(p.id);
      if (was === p.outcome) continue;
      if (p.outcome === "dead") {
        deaths++;
        if (isYou(p.id)) youDied = true;
      }
    }
    if (deaths > 0) {
      sfxShatter(deaths);
    } else {
      // The forward-looking rate, matching every visual. `round.hazard` is the
      // tick that already resolved, so after a mass shatter the ring and the
      // seams cool instantly while the next tick still *sounds* like the
      // pre-shatter danger — the two channels riskScale exists to unify,
      // disagreeing for one tick after every death wave.
      sfxTick(this.forwardHazard());
    }
    if (youDied) sfxYouDied();

    // Auto-exit fires the first tick the multiple crosses the target. The
    // steps are discrete, so this banks the actual crossing value: never
    // under the target, sometimes above it.
    if (this.auto.enabled && !round.finished) {
      // Any live plate reads the shared multiple; walkOut extracts them all.
      const you = round.players.find((p) => isYou(p.id) && p.outcome === "in");
      if (you && you.balance / this.config.entry >= this.auto.target) {
        this.walkOut();
        if (this.round?.finished) return;
      }
    }

    // This tick may have left every live plate with one owner; the round is
    // decided, so it ends now (same rule as the server).
    if (!round.finished) this.bankSoleOwner();

    if (round.finished) {
      this.finish();
      return;
    }
    this.emit();
  }

  /** Owner identity for the sole-owner rule: you, or the bot wallet name. */
  private ownerOf(id: number): string {
    return isYou(id) ? "YOU" : (this.names.get(id) ?? String(id));
  }

  /**
   * Ends the hollow endgame, same rule as the server: once one owner holds
   * every live plate the outcome is decided (their deaths only pass money
   * between their own plates), so all their plates bank now. Genuine engine
   * cash-outs, so the round's record replays exactly as it was played.
   */
  private bankSoleOwner(): void {
    const round = this.round;
    if (!round || round.finished || this.phase !== "live") return;
    const live = round.players.filter((p) => p.outcome === "in");
    if (live.length === 0) return;
    const owners = new Set(live.map((p) => this.ownerOf(p.id)));
    if (owners.size !== 1) return;
    this.soleOwnerKey = [...owners][0]!;
    for (const p of live) round.cashOut(p.id);
  }

  private currentMultiplier(): number {
    const round = this.round;
    if (!round) return 1 - totalRake(this.config);
    const live = round.players.find((p) => p.outcome === "in");
    if (live) return live.balance / this.config.entry;
    // Round is over: report the highest multiple anyone reached.
    let best = 0;
    for (const p of round.players) best = Math.max(best, p.cashedOut / this.config.entry);
    return best || 1 - totalRake(this.config);
  }

  private finish(): void {
    const round = this.round;
    if (round) {
      const res = round.result();
      const nowMs = Date.now();

      // The engine's accounting, not a parallel copy of it. Tickets credited
      // are the tickets the engine actually awarded (so risk-weighted accrual
      // or forfeit-on-death would flow through untouched), and the jackpot is
      // funded with the wipe leak included — the sim counts that money as
      // player money, so the client must not destroy it.
      for (const p of res.players) {
        // Your plates all credit the ONE ledger identity, so tickets and the
        // rakeback stream see a single player however many plates they held.
        // (Rev-share tickets and the stream itself were handled at the seal.)
        this.jackpot.credit(isYou(p.id) ? YOU_ID : p.id, p.bonanzaTickets);
      }
      this.jackpot.fund(res.toBonanza + res.wipeLeak);

      const yours = res.players.filter((p) => isYou(p.id));
      for (const p of yours) {
        this.wallet += p.cashedOut;
        this.session += p.cashedOut - this.config.entry;
        const mult = p.cashedOut / this.config.entry;
        this.stats.returned += p.cashedOut;
        this.stats.bestMultiple = Math.max(this.stats.bestMultiple, mult);
        if (mult >= 1) this.stats.roundsWon++;
      }

      // The winner scene's subject, same crown priority as the server: the
      // engine's survivor; else a sole-owner ending's owner; else the best
      // extraction with ties going to the longest stander, so the face on
      // the scene matches the plates still visibly up on the board.
      // A total wipe (nobody banked anything) leaves no winner at all.
      const cashedPlayers = res.players.filter((p) => p.outcome === "cashed");

      // Same rule as the server: the owner who banked on the very tick every
      // other standing player died faced the final roll and survived it —
      // last one standing in spirit, though the engine flagged nobody.
      if (
        !res.players.some((p) => p.lastStanding) &&
        res.players.some((p) => p.outcome === "dead" && p.ticksSurvived === res.ticks)
      ) {
        const finalExits = new Set<string>();
        for (const p of res.players)
          if (p.outcome === "cashed" && p.ticksSurvived === res.ticks)
            finalExits.add(this.ownerOf(p.id));
        if (finalExits.size === 1) this.outlastedKey = [...finalExits][0]!;
      }

      const champ =
        res.players.find((p) => p.lastStanding) ??
        (this.soleOwnerKey !== null
          ? cashedPlayers.find((p) => this.ownerOf(p.id) === this.soleOwnerKey)
          : undefined) ??
        (this.outlastedKey !== null
          ? cashedPlayers.find((p) => this.ownerOf(p.id) === this.outlastedKey)
          : undefined) ??
        [...cashedPlayers].sort(
          (a, b) => b.cashedOut - a.cashedOut || b.ticksSurvived - a.ticksSurvived,
        )[0];
      // Distinct owners at the champion's exact extraction — same rule as
      // the server: a shared top exit renders "dead heat", never a coin-flip
      // "best", and one owner's multi-plate cash-out never ties itself.
      let tied = 1;
      if (champ && champ.lastStanding !== true) {
        const owners = new Set<string>();
        for (const p of res.players) {
          if (p.outcome !== "cashed") continue;
          if (Math.abs(p.cashedOut - champ.cashedOut) > 1e-9) continue;
          owners.add(this.ownerOf(p.id));
        }
        tied = Math.max(1, owners.size);
      }
      this.winner = champ
        ? {
            name: this.names.get(champ.id) ?? "player",
            charId: this.charOf(champ.id),
            you: isYou(champ.id),
            multiple: champ.cashedOut / this.config.entry,
            amount: champ.cashedOut,
            // Sole-owner endings are last-one-standing in spirit — but only
            // when the champion IS that owner, not an earlier bigger exit.
            lastStanding:
              champ.lastStanding === true ||
              (this.soleOwnerKey !== null && this.ownerOf(champ.id) === this.soleOwnerKey) ||
              (this.outlastedKey !== null && this.ownerOf(champ.id) === this.outlastedKey),
            tied,
          }
        : null;
      if (this.winner) {
        const t = this.winner.charId;
        this.teamWins[t] = (this.teamWins[t] ?? 0) + 1;
      }

      // The round's fairness record: enough to replay and verify it locally.
      let best = 0;
      for (const p of res.players) best = Math.max(best, p.cashedOut / this.config.entry);
      this.history.unshift({
        roundId: this.roundId,
        entrants: res.players.length,
        ticks: res.ticks,
        joined: yours.length > 0,
        yourOutcome:
          yours.length === 0
            ? "none"
            : yours.some((p) => p.cashedOut > 0)
              ? "cashed"
              : "dead",
        // Blended across your plates, matching the server's aggregation.
        yourMultiple:
          yours.length > 0
            ? yours.reduce((a, p) => a + p.cashedOut, 0) / (this.config.entry * yours.length)
            : null,
        yourSeats: yours.length > 0 ? yours.map((p) => p.id) : null,
        bestMultiple: best,
        commit: this.roundCommit,
        observedCommit: this.roundCommit,
        seedHex: this.roundSeedHex,
        verified: null,
        seedOk: null,
        replayOk: null,
        rulesOk: null,
        bonanzaOk: null,
        payoutOk: null,
        record: {
          seedHex: this.roundSeedHex,
          config: this.roundRules ?? this.config,
          entrantIds: res.players.map((p) => p.id),
          cashOuts: res.cashOuts,
        },
        digest: outcomeDigest(res),
        winnerChar: this.winner?.charId ?? null,
        winnerYou: this.winner?.you ?? false,
      });
      if (this.history.length > 40) this.history.pop();
    }
    this.phase = "result";
    this.phaseEnd = Date.now() + this.config.timing.resultMs;
    this.rollBonanza();
    this.saveState();
    this.emit();
  }

  /**
   * Folds the jackpot draw into the round's record. The roll happens after the
   * history entry is built (the pool has to be funded by the round first), so
   * the record is patched rather than rebuilt — the entry is still the object
   * verifyRound will later replay.
   */
  private recordBonanza(winnerId: number | null): void {
    const draws = this.jackpot.lastDraws;
    const entry = this.history[0];
    if (!draws || !entry || entry.roundId !== this.roundId) return;
    entry.record.bonanza = { ...draws, winnerId };
  }

  private saveState(): void {
    try {
      const now = Date.now();
      const s: SaveState = {
        wallet: this.wallet,
        session: this.session,
        pool: this.jackpot.pool,
        bTickets: this.jackpot.ticketsOf(YOU_ID),
        revLifetime: this.revShare.lifetimeOf(YOU_ID),
        revWeight: this.revShare.weightOf(YOU_ID, now),
        autoEnabled: this.auto.enabled,
        autoTarget: this.auto.target,
        autoPlates: this.auto.plates,
        charId: this.charId,
        revStreamed: this.revStreamedLifetime,
        teamWins: this.teamWins,
        roundId: this.roundId,
        stats: this.stats,
        lastFire: this.lastFireRound,
        crowdBTickets: this.jackpot.totalTickets - this.jackpot.ticketsOf(YOU_ID),
        crowdRevWeight: this.revShare.totalWeight(now) - this.revShare.weightOf(YOU_ID, now),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    } catch {
      /* refresh simply starts fresh */
    }
  }

  /**
   * The jackpot draw, through the engine's pool: fires on the per-round
   * chance, picks the winner weighted by every ticket accrued since the last
   * fire — including players sitting this round out — then wipes all tickets.
   */
  private rollBonanza(): void {
    // Off the committed seed, on its own tagged stream — never off the
    // presentation RNG. The jackpot is the biggest single payout in the game
    // and must be as checkable as any elimination.
    const fire = this.jackpot.roll(deriveRng(this.roundSeedHex, BONANZA_TAG));
    this.recordBonanza(fire?.winnerId ?? null);
    if (!fire) return;

    const youWon = fire.winnerId === YOU_ID;
    if (youWon) {
      this.wallet += fire.amount;
      this.session += fire.amount;
      this.stats.bonanzaWon = (this.stats.bonanzaWon ?? 0) + fire.amount;
    }
    this.lastFireRound = this.roundId;
    this.bonanza = {
      amount: fire.amount,
      winner: this.names.get(fire.winnerId) ?? "a ticket holder",
      youWon,
      at: Date.now(),
    };
    sfxBonanza();
    // The jackpot sequence needs room to play out before the next lobby.
    this.phaseEnd = Date.now() + this.config.timing.bonanzaMs;
  }

  /**
   * Re-runs a finished round from its revealed seed and exit schedule, then
   * checks three things: the outcome matches what was watched live, the
   * revealed seed hashes to the commitment published before the round sealed,
   * and the rules it ran under are the rules this build advertises. All three
   * must hold — a round can replay perfectly under rigged numbers, so the
   * first two alone prove only that the operator is self-consistent.
   */
  async verifyRound(roundId: number): Promise<void> {
    const h = this.history.find((x) => x.roundId === roundId);
    if (!h) return;
    await verifyEntry(h, this.config);
    this.emit();
  }

  setCharacter(id: string): void {
    this.charId = charById(id).id;
    this.saveState();
    this.emit();
  }

  /**
   * Local echo only. The demo's opponents are simulations and simulations do
   * not speak — inventing replies would be faking a crowd, which is the one
   * thing this product must never do. The panel labels the mode honestly.
   */
  sendChat(text: string): void {
    const t = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 160);
    if (!t) return;
    this.chatLog.push({
      id: this.nextChatId++,
      name: "YOU",
      charId: this.charId,
      text: t,
      at: Date.now(),
      you: true,
    });
    if (this.chatLog.length > 80) this.chatLog.shift();
    this.emit();
  }

  setAuto(patch: Partial<AutoSettings>): void {
    this.auto = { ...this.auto, ...patch };
    if (!Number.isFinite(this.auto.target) || this.auto.target < 1.05) {
      this.auto.target = 1.05;
    }
    this.auto.plates = Number.isFinite(this.auto.plates)
      ? Math.min(MAX_PLATES, Math.max(1, Math.round(this.auto.plates)))
      : 1;
    // Flipping auto on mid-lobby should not miss the current round, and
    // raising the count mid-lobby tops the position up to it.
    if (this.auto.enabled && this.phase === "lobby") this.autoBuy();
    this.saveState();
    this.emit();
  }

  /** Buys a plate — or another one, up to the cap. Same price every time. */
  join(): void {
    if (this.phase !== "lobby" || this.youPlates >= MAX_PLATES) return;
    if (this.wallet < this.config.entry) return;
    this.wallet -= this.config.entry;
    this.youPlates++;
    this.stats.roundsPlayed++;
    this.stats.wagered += this.config.entry;
    sfxJoin();
    this.emit();
  }

  /**
   * Steps off during the lobby: every plate refunded as if never bought, and
   * auto play switches off — stepping off IS the statement that you are done.
   */
  stepOff(): void {
    if (this.phase !== "lobby" || this.youPlates === 0) return;
    this.wallet += this.youPlates * this.config.entry;
    this.stats.roundsPlayed -= this.youPlates;
    this.stats.wagered -= this.youPlates * this.config.entry;
    this.youPlates = 0;
    this.auto.enabled = false;
    this.saveState();
    this.emit();
  }

  /** Extracts every live plate you hold, together, at the shared multiple. */
  walkOut(): void {
    const round = this.round;
    if (!round || this.phase !== "live") return;
    let any = false;
    for (const p of round.players) {
      if (!isYou(p.id) || p.outcome !== "in") continue;
      if (round.cashOut(p.id) !== null) any = true;
    }
    if (!any) return;
    sfxExtract();
    // Your exit may have left a single bot owner holding the whole field.
    if (!round.finished) this.bankSoleOwner();
    if (round.finished) this.finish();
    else this.emit();
  }

  destroy(): void {
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
  }

  /**
   * Your standing in both ticket economies. The engine ledgers are the source:
   * bonanza odds are exactly tickets over the circulating total (wiped each
   * fire), and the rev-share slice is decayed weight over total decayed weight,
   * which is precisely the fraction of the next distribution you receive —
   * whether or not you are in the round it comes from.
   */
  private ticketStandings(): Snapshot["tickets"] {
    const now = Date.now();
    const bonYours = this.jackpot.ticketsOf(YOU_ID);
    const bonTotal = this.jackpot.totalTickets;
    const revTotal = this.revShare.totalWeight(now);
    return {
      bonYours,
      bonTotal,
      bonShare: bonTotal > 0 ? bonYours / bonTotal : 0,
      revShare: revTotal > 0 ? this.revShare.weightOf(YOU_ID, now) / revTotal : 0,
      revStreamed: this.revStreamedLifetime,
    };
  }

  /** Yours is read live so a mid-lobby switch shows everywhere instantly. */
  private charOf(id: number): string {
    return isYou(id) ? this.charId : (this.charMap.get(id) ?? CHARACTERS[0]!.id);
  }

  /**
   * Lifetime record for the profile card. Yours is your real local record;
   * a bot's is synthesized deterministically from its wallet name — the demo
   * already invents the wallet, so it invents a history consistent with the
   * economics (flat entries, RTP-shaped net) rather than showing a blank
   * card that reads as broken.
   */
  private lifetimeOf(id: number): PlayerView["lifetime"] {
    if (isYou(id)) {
      const s = this.stats;
      return {
        wagered: s.wagered,
        net: s.returned + s.revEarned + (s.bonanzaWon ?? 0) - s.wagered,
        hitRate: s.roundsPlayed > 0 ? s.roundsWon / s.roundsPlayed : 0,
        best: s.bestMultiple,
        jackpots: s.bonanzaWon ?? 0,
        tickets: {
          bon: this.jackpot.ticketsOf(YOU_ID),
          rev: this.revShare.lifetimeOf(YOU_ID),
        },
      };
    }
    const name = this.names.get(id) ?? "player";
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
    const plates = 20 + (h % 4800);
    const wagered = plates * this.config.entry;
    const rtp = 0.9 + ((h >>> 8) % 1600) / 10000;
    // One style axis drives both tells, so the invented record is internally
    // coherent: a nit banks often and never rides far, a degen almost never
    // banks but has one enormous multiple to show for it. Independent random
    // numbers would produce players who cash 70% of plates AND hold a 40×,
    // which no exit strategy can actually produce.
    const style = ((h >>> 18) % 1000) / 1000;
    return {
      wagered,
      net: wagered * (rtp - 1),
      hitRate: 0.74 - style * 0.56,
      best: 1.6 + style * style * 38 + ((h >>> 4) % 100) / 100,
      jackpots: (h >>> 28) === 0 ? 20 + ((h >>> 6) % 9000) / 100 : 0,
      // Rev tickets never wipe, so lifetime plates times the per-entry award
      // is the truth by construction. Bonanza tickets wipe on every fire, so
      // only a small recent slice of that history is still circulating.
      tickets: {
        bon: Math.round(plates * (0.005 + ((h >>> 12) % 80) / 1000)) *
          this.config.bonanza.ticketBase,
        rev: plates * this.config.revShare.ticketsPerEntry,
      },
    };
  }

  private viewOf(p: Player): PlayerView {
    return {
      id: p.id,
      name: this.names.get(p.id) ?? "player",
      you: isYou(p.id),
      charId: this.charOf(p.id),
      outcome: p.outcome,
      multiple: (p.outcome === "in" ? p.balance : p.cashedOut) / this.config.entry,
      balance: p.outcome === "in" ? p.balance : p.cashedOut,
      ticksSurvived: p.ticksSurvived,
      lastStanding:
        p.lastStanding === true ||
        ((this.soleOwnerKey !== null && this.ownerOf(p.id) === this.soleOwnerKey) ||
          (this.outlastedKey !== null && this.ownerOf(p.id) === this.outlastedKey)
          ? p.outcome === "cashed"
          : false),
      lifetime: this.lifetimeOf(p.id),
    };
  }

  snapshot(): Snapshot {
    const round = this.round;
    const cfg = this.config;

    // Before the seal there is no Round yet, so the waiting crowd is built from
    // whoever has arrived. Without this the shaft sits empty through the whole
    // lobby and the countdown looks broken.
    const players: PlayerView[] = round
      ? round.players.map((p) => this.viewOf(p))
      : this.phase === "lobby"
        ? [
            ...this.arrived().map((e) => ({
              id: e.id,
              name: this.names.get(e.id) ?? "player",
              you: false,
              charId: this.charOf(e.id),
              outcome: "in" as const,
              multiple: 1 - totalRake(cfg),
              balance: cfg.entry * (1 - totalRake(cfg)),
              ticksSurvived: 0,
              lifetime: this.lifetimeOf(e.id),
            })),
            ...Array.from({ length: this.youPlates }, (_, i) => ({
              id: YOU_BASE + i,
              name: "YOU",
              you: true,
              charId: this.charId,
              outcome: "in" as const,
              multiple: 1 - totalRake(cfg),
              balance: cfg.entry * (1 - totalRake(cfg)),
              ticksSurvived: 0,
              lifetime: this.lifetimeOf(YOU_BASE + i),
            })),
          ]
        : [];
    const live = players.filter((p) => p.outcome === "in").length;
    const dead = players.filter((p) => p.outcome === "dead").length;
    const cashed = players.filter((p) => p.outcome === "cashed").length;
    // Same aggregation the server runs: live plates share one balance, so the
    // blended multiple IS the per-plate multiple while any are standing.
    const yours = round ? round.players.filter((p) => isYou(p.id)) : [];
    const aliveMine = yours.filter((p) => p.outcome === "in").length;
    const cashedMine = yours.filter((p) => p.outcome === "cashed").length;
    const deadMine = yours.filter((p) => p.outcome === "dead").length;
    const myTotal = yours.reduce(
      (a, p) => a + (p.outcome === "in" ? p.balance : p.cashedOut),
      0,
    );
    const myStake = this.youPlates * cfg.entry;

    const graceLeft = round
      ? Math.max(0, cfg.hazard.graceTicks - round.currentTick)
      : cfg.hazard.graceTicks;

    const hazard = this.forwardHazard();

    return {
      phase: this.phase,
      roundId: this.roundId,
      tick: round?.currentTick ?? 0,
      multiplier: this.currentMultiplier(),
      hazard,
      grace: this.phase === "live" && graceLeft > 0,
      graceRemaining: graceLeft,
      msToPhaseEnd: Math.max(0, this.phaseEnd - Date.now()),
      players,
      liveCount: live,
      totalCount: players.length,
      deadCount: dead,
      cashedCount: cashed,
      potInPlay: round ? round.pot : 0,
      entry: cfg.entry,
      you: {
        joined: this.youPlates > 0,
        outcome:
          this.youPlates === 0
            ? "out"
            : yours.length === 0 || aliveMine > 0
              ? "in"
              : cashedMine > 0
                ? "cashed"
                : "dead",
        balance: myTotal,
        multiple: yours.length > 0 && myStake > 0 ? myTotal / myStake : 0,
        lockedMultiple:
          yours.length > 0 && aliveMine === 0 && cashedMine > 0 && myStake > 0
            ? myTotal / myStake
            : null,
        plates: {
          total: this.youPlates,
          alive: round ? aliveMine : this.youPlates,
          cashed: cashedMine,
          dead: deadMine,
          max: MAX_PLATES,
        },
      },
      wallet: this.wallet,
      session: this.session,
      bonanzaPool: this.jackpot.pool,
      bonanzaDrought: Math.max(0, this.roundId - this.lastFireRound),
      bonanzaTickets: this.jackpot.ticketsOf(YOU_ID),
      revShareTickets: this.revShare.lifetimeOf(YOU_ID),
      bonanza: this.bonanza,
      charId: this.charId,
      winner: this.winner,
      teamWins: this.teamWins,
      tickets: this.ticketStandings(),
      chat: this.chatLog,
      history: this.history,
      nextCommit: this.roundCommit,
      auto: this.auto,
      stats: this.stats,
      online: 1,
      connected: true,
    };
  }
}

/**
 * Single shared instance. React StrictMode mounts, unmounts and remounts every
 * component in development, so a per-component client would be thrown away and
 * rebuilt mid-round, resetting the wallet and the round in the process.
 */
let instance: GameClient | null = null;

export function getGameClient(): GameClient {
  if (!instance) instance = new GameClient();
  return instance;
}

// Without this a hot reload strands the previous client's interval and two
// game loops run at once, double-ticking every round.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    instance?.destroy();
    instance = null;
  });
}
