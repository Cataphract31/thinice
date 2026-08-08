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

export interface NetHistory {
  roundId: number;
  entrants: number;
  ticks: number;
  bestMultiple: number;
  yourOutcome: "none" | "cashed" | "dead";
  yourMultiple: number | null;
  /**
   * The seat this player held in that round. Without it the replay proves the
   * round happened as committed but says nothing about YOUR result: the row
   * claiming what you were paid stays pure server assertion, unverifiable
   * against the round it supposedly came from.
   */
  yourSeat: number | null;
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
  auto: { enabled: boolean; target: number };
  stats: NetStats;
  /** Humans currently connected, so a lobby of one is visibly a lobby of one. */
  online: number;
}

export type ClientMessage =
  | { t: "auth"; wallet: string; sig: string }
  | { t: "guest"; id: string }
  | { t: "join" }
  | { t: "cashout" }
  | { t: "setAuto"; enabled: boolean; target: number }
  | { t: "setChar"; charId: string }
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
  /** Outcome of a deposit or withdrawal, for the bank panel to display. */
  | { t: "tx"; kind: "deposit" | "withdraw"; ok: boolean; sol: number; note: string }
  | { t: "error"; message: string };
