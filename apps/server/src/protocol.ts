export interface NetPlayer {
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

export interface NetStats {
  roundsPlayed: number;
  roundsWon: number;
  wagered: number;
  returned: number;
  bestMultiple: number;
}

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
  yourSeats: number[];
  commit: string;
  seedHex: string;
  winnerChar: string | null;
  winnerYou: boolean;
  record: string;
  digest: string;
}

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
    tied?: number;
  } | null;
  teamWins: Record<string, number>;
  nextCommit: string;
  auto: { enabled: boolean; target: number; plates: number };
  stats: NetStats;
  online: number;
}

export type ClientMessage =
  | { t: "auth"; wallet: string; sig: string }
  | { t: "arcade"; token: string }
  | { t: "resume"; wallet: string; token: string }
  | { t: "logout" }
  | { t: "spectate" }
  | { t: "sync" }
  | { t: "join" }
  | { t: "unjoin" }
  | { t: "cashout" }
  | { t: "setAuto"; enabled: boolean; target: number; plates: number }
  | { t: "setChar"; charId: string }
  | { t: "chat"; text: string };

export type ServerMessage =
  | { t: "challenge"; nonce: string; text: string }
  | {
      t: "ready";
      wallet: string;
      spectator: boolean;
      token?: string;
    }
  | { t: "state"; state: NetState }
  | { t: "history"; history: NetHistory[] }
  | { t: "chat"; msgs: NetChat[] }
  | { t: "error"; message: string };
