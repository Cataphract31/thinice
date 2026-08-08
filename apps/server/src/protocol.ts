/**
 * The wire format.
 *
 * The server is the only authority: it owns the rounds, the RNG, the balances
 * and the clock. A client sends intents ("I want in", "get me out") and
 * renders whatever comes back. Nothing a client says is trusted beyond who it
 * is, and even that is proved by signature.
 */

export interface NetPlayer {
  id: number;
  name: string;
  you: boolean;
  charId: string;
  outcome: "in" | "cashed" | "dead";
  multiple: number;
  balance: number;
  ticksSurvived: number;
  /**
   * The wallet's lifetime record as of joining this round, for the plate
   * profile card. Net includes rakeback and jackpot winnings — the honest
   * "versus the house" number, not just round settlements.
   *
   * `plates` and `wagered` are ONE fact at a fixed entry (wagered = plates ×
   * entry), so the card prints them as one line. The style tells — how often
   * they finish a plate ahead, and how far they have ever ridden one — are
   * what actually distinguish one stranger from another.
   */
  lifetime?: {
    plates: number;
    wagered: number;
    net: number;
    /** Share of plates that came back at or above the entry, 0-1. */
    hitRate: number;
    /** Best multiple ever banked. */
    best: number;
    /** Lifetime jackpot winnings, shown only when they have taken one. */
    jackpots: number;
  };
}

/** Lifetime record, straight out of the database. */
export interface NetStats {
  roundsPlayed: number;
  roundsWon: number;
  /** Total staked across every round ever entered. */
  wagered: number;
  /** Total paid back out across every round ever entered. */
  returned: number;
  bestMultiple: number;
  revEarned: number;
  /** Lifetime jackpot winnings, which never pass through a round settlement. */
  bonanzaWon: number;
}

/**
 * One line of table talk. `you` is stamped per recipient at send time and is
 * compared on the full wallet server-side — never the display name, which
 * collapses to 4+4 characters two addresses can share. The wallet itself
 * never leaves the server: a guest id is a bearer token for its balance.
 */
export interface NetChat {
  id: number;
  name: string;
  charId: string;
  text: string;
  at: number;
  you?: boolean;
}

export interface NetHistory {
  roundId: number;
  entrants: number;
  ticks: number;
  bestMultiple: number;
  yourOutcome: "none" | "cashed" | "dead";
  yourMultiple: number | null;
  /**
   * Every seat this wallet held in that round (multi-betting is several).
   * Without them the replay proves the round happened as committed but says
   * nothing about YOUR result: the row claiming what you were paid stays pure
   * server assertion, unverifiable against the round it supposedly came from.
   */
  yourSeats: number[];
  commit: string;
  seedHex: string;
  winnerChar: string | null;
  winnerYou: boolean;
  /** JSON RoundRecord: seed, entrants, exits. Enough to replay it yourself. */
  record: string;
  /** The server's own fingerprint of the outcome, to check the replay against. */
  digest: string;
}

/** Pushed on every tick. Everything the screen needs, nothing it does not. */
export interface NetState {
  phase: "lobby" | "live" | "result";
  roundId: number;
  tick: number;
  multiplier: number;
  hazard: number;
  grace: boolean;
  graceRemaining: number;
  msToPhaseEnd: number;
  players: NetPlayer[];
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
    /** The wallet's plates this round, and the per-round ceiling. */
    plates: { total: number; alive: number; cashed: number; dead: number; max: number };
  };
  wallet: number;
  session: number;
  bonanzaPool: number;
  bonanzaTickets: number;
  revShareTickets: number;
  bonanza: { amount: number; winner: string; youWon: boolean; at: number } | null;
  charId: string;
  winner: {
    name: string;
    charId: string;
    you: boolean;
    multiple: number;
    amount: number;
    lastStanding: boolean;
  } | null;
  teamWins: Record<string, number>;
  tickets: {
    bonYours: number;
    bonTotal: number;
    bonShare: number;
    revShare: number;
    revStreamed: number;
  };
  nextCommit: string;
  auto: { enabled: boolean; target: number; plates: number };
  stats: NetStats;
  /** Humans currently connected, so a lobby of one is visibly a lobby of one. */
  online: number;
}

export type ClientMessage =
  | { t: "auth"; wallet: string; sig: string }
  | { t: "guest"; id: string }
  | { t: "join" }
  | { t: "cashout" }
  | { t: "setAuto"; enabled: boolean; target: number; plates: number }
  | { t: "setChar"; charId: string }
  /** A line for the room. Cleaned, capped and rate-limited server-side. */
  | { t: "chat"; text: string }
  /** Presents a confirmed on-chain transaction to be credited. */
  | { t: "deposit"; sig: string }
  /** Asks the house to pay this much of the ledger balance on-chain. */
  | { t: "withdraw"; sol: number };

export type ServerMessage =
  | { t: "challenge"; nonce: string }
  /** `house` is where deposits go. Absent for guests, who have no chain identity. */
  | { t: "ready"; wallet: string; guest: boolean; house?: string }
  | { t: "state"; state: NetState }
  | { t: "history"; history: NetHistory[] }
  /** New chat line(s). The backlog on connect and live lines use one shape. */
  | { t: "chat"; msgs: NetChat[] }
  /** Outcome of a deposit or withdrawal, for the bank panel to display. */
  | { t: "tx"; kind: "deposit" | "withdraw"; ok: boolean; sol: number; note: string }
  | { t: "error"; message: string };
