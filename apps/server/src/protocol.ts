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
  /** Stood to the very end (sole survivor / sole owner) — see PlayerView. */
  lastStanding?: boolean;
  /**
   * The wallet's lifetime record as of joining this round, for the plate
   * profile card. Net is returned minus wagered — the honest "versus the
   * house" number.
   *
   * No plate count: entry is fixed, so it is `wagered / entry` — the same
   * fact in different units, and the card is small. The style tells are what
   * actually distinguish one stranger from another.
   */
  lifetime?: {
    wagered: number;
    net: number;
    /** Share of plates that came back at or above the entry, 0-1. */
    hitRate: number;
    /** Best multiple ever banked. */
    best: number;
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
  charId: string;
  winner: {
    name: string;
    charId: string;
    you: boolean;
    multiple: number;
    amount: number;
    lastStanding: boolean;
    /** Distinct wallets sharing the top extraction; >1 renders "dead heat". */
    tied?: number;
  } | null;
  teamWins: Record<string, number>;
  nextCommit: string;
  auto: { enabled: boolean; target: number; plates: number };
  stats: NetStats;
  /** Humans currently connected, so a lobby of one is visibly a lobby of one. */
  online: number;
}

export type ClientMessage =
  | { t: "auth"; wallet: string; sig: string }
  /**
   * Seat a wallet on a session the ARCADE minted, with no signature here at
   * all. The whole arcade signs once, at one issuer, and every game verifies
   * what comes out of it -- six games each issuing their own challenge would
   * be six signatures to walk around one building, which is exactly what
   * putting every world on one origin was for. The token is checked against
   * that issuer over the loopback, never trusted on its face.
   */
  | { t: "arcade"; token: string }
  /**
   * Resumes a wallet session with the bearer token minted at the last
   * signature. Same trust model as guest ids (which are bearer tokens for
   * their balances already): fine for play money, revisit for mainnet.
   * Kills the Phantom popup on every reload, reconnect and server restart.
   */
  | { t: "resume"; wallet: string; token: string }
  | { t: "guest"; id: string }
  | { t: "join" }
  /** Steps off during the lobby: every plate refunded, as if never bought. */
  | { t: "unjoin" }
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
  /** `house` is where deposits go. Absent for guests, who have no chain identity.
      `token` arrives once, after a fresh signature: the client stores it and
      resumes with it instead of asking Phantom to sign every connection. */
  | {
      t: "ready";
      wallet: string;
      guest: boolean;
      house?: string;
      token?: string;
    }
  | { t: "state"; state: NetState }
  | { t: "history"; history: NetHistory[] }
  /** New chat line(s). The backlog on connect and live lines use one shape. */
  | { t: "chat"; msgs: NetChat[] }
  /** Outcome of a deposit or withdrawal, for the bank panel to display. */
  | { t: "tx"; kind: "deposit" | "withdraw"; ok: boolean; sol: number; note: string }
  | { t: "error"; message: string };
