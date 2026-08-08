import { createHash, randomBytes } from "node:crypto";
import {
  BONANZA_TAG,
  BonanzaPool,
  DEFAULT_CONFIG,
  RevShareLedger,
  Round,
  canonicalConfig,
  deriveRng,
  hazardAt,
  mulberry32,
  outcomeDigest,
  rngFromSeedHex,
  totalRake,
  type Entrant,
  type GameConfig,
  type Rng,
} from "@zinc/engine";
import { CONFIG, toLamports, toSol } from "./config.ts";
import type { Database } from "./db.ts";
import type { NetChat, NetHistory, NetPlayer, NetState } from "./protocol.ts";

/** The roster. Also the whitelist for what a client may set as its character. */
export const CHARS = ["chad", "soyjak", "wojak", "ansem", "saylor", "pepe", "chud", "bogdanoff"];

export function shortAddress(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * What the published hash is a hash of. The rules hash is in here alongside
 * the seed so the commitment covers the game that was actually played, not
 * just the dice it was played with.
 */
function commitPreimage(roundId: number, seedHex: string, rulesHash: string): string {
  return `thinice:${roundId}:${seedHex}:${rulesHash}`;
}

/**
 * One occupant of the lattice for one round. Every seat is a human with a
 * wallet — this game has no house players, by design and on purpose: a bot in
 * a PvP round is the house playing its own customers.
 */
interface Seat {
  id: number;
  wallet: string;
  name: string;
  charId: string;
}

/** A connected human. The socket layer owns the transport; this owns the money. */
export interface Session {
  wallet: string;
  guest: boolean;
  /** Net SOL this visit, purely for display. */
  session: number;
  send(state: NetState): void;
  sendHistory(h: NetHistory[]): void;
  sendChat(msgs: NetChat[]): void;
}

/**
 * The authoritative game.
 *
 * Everything that decides an outcome happens here and only here: the round
 * seed, the elimination rolls, the balances, the clock. Clients receive
 * results and send intents. A client cannot make itself survive a tick, pay
 * itself, or learn a seed before the round it belongs to has ended, because it
 * is never given the chance to hold any of that.
 */
export class GameServer {
  private config: GameConfig = DEFAULT_CONFIG;
  private phase: "lobby" | "live" | "result" = "lobby";
  private roundId: number;
  private round: Round | null = null;
  private phaseEnd = 0;
  private nextTickAt = 0;
  private timer: NodeJS.Timeout | null = null;

  private seats = new Map<number, Seat>();
  private seatOf = new Map<string, number>();
  /** Seat ids already paid out this round. Exits must book exactly once. */
  private settled = new Set<number>();
  private nextSeatId = 1;

  /** Wallet -> stable numeric key for the engine's ledgers. */
  private ledgerIds = new Map<string, number>();
  private nextLedgerId = 1;

  private jackpot: BonanzaPool;
  private revShare: RevShareLedger;

  private sessions = new Set<Session>();
  /**
   * Presentation randomness only — nothing that decides money may touch this.
   * It is a 32-bit stream seeded from a wall clock, which is to say it is
   * predictable to anyone who knows roughly when the process started.
   */
  private rng: Rng = mulberry32((Date.now() & 0xffffffff) >>> 0);

  private seedHex = "";
  private commit = "";
  /** Hash of the rules every round is committed under. Fixed for the process. */
  private readonly rulesHash: string;
  private winner: NetState["winner"] = null;
  /** Full wallet of the winner — identity is never matched by display name. */
  private winnerWallet: string | null = null;
  private bonanza: NetState["bonanza"] = null;
  private bonanzaWallet: string | null = null;
  private lastBroadcast = 0;
  private teamWins: Record<string, number>;

  /**
   * The room's recent table talk, kept in memory only. Chat is atmosphere, not
   * a ledger: it does not survive a restart and does not need to. The wallet
   * rides along so `you` can be stamped per recipient — it is stripped before
   * anything leaves the server.
   */
  private chatLog: Array<NetChat & { wallet: string }> = [];
  private nextChatId = 1;

  constructor(private db: Database) {
    this.rulesHash = sha256Hex(canonicalConfig(this.config));
    this.roundId = db.lastRoundId();
    this.teamWins = db.teamWins();
    this.jackpot = new BonanzaPool(
      this.config.bonanza,
      toSol(Number(db.getMeta("bonanzaPool") ?? 0)),
    );
    this.revShare = new RevShareLedger(this.config.revShare);
    this.restoreLedgers();
  }

  /**
   * Ticket state lives in the database, so a restart does not wipe everyone's
   * standing in the two economies. Weights are restored as their decayed
   * value, which is exact: decay only depends on time since the grant.
   */
  private restoreLedgers(): void {
    const now = Date.now();
    for (const row of this.db.allPlayersWithTickets()) {
      const id = this.ledgerId(row.wallet);
      if (row.bonanzaTickets > 0) this.jackpot.credit(id, row.bonanzaTickets);
      if (row.revTickets > 0 || row.revWeight > 0 || row.revClaimed > 0) {
        // revClaimed is what this server has actually paid this wallet. The
        // ledger needs it or its lifetime total restarts at zero and the
        // rakeback stream stops paying everyone who was owed anything.
        this.revShare.restore(
          id,
          row.revTickets,
          row.revWeight,
          now,
          toSol(row.revClaimed),
        );
      }
    }
  }

  /**
   * Stable ledger key for a wallet, minted on first use.
   *
   * Only ever called for wallets that actually take part in an economy —
   * entering a round, or restored as an existing ticket holder. It used to be
   * called from `stateFor`, i.e. on every broadcast for every connected
   * socket, which permanently enrolled anyone who merely opened the page: and
   * both `finish` and `persistTickets` walk this map doing one synchronous
   * SELECT and one UPDATE per entry, every round, forever. Guest ids are free.
   */
  private ledgerId(wallet: string): number {
    let id = this.ledgerIds.get(wallet);
    if (id === undefined) {
      id = this.nextLedgerId++;
      this.ledgerIds.set(wallet, id);
    }
    return id;
  }

  /** Read-only lookup for display: never enrols a wallet in the ledgers. */
  private ledgerIdIfAny(wallet: string): number | undefined {
    return this.ledgerIds.get(wallet);
  }

  start(): void {
    if (this.timer) return;
    this.openLobby();
    this.timer = setInterval(() => this.loop(), 50);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  attach(s: Session): void {
    this.sessions.add(s);
    this.pushHistory(s);
    // The backlog, so a fresh arrival lands in a room mid-conversation
    // instead of one that looks empty until somebody happens to speak.
    if (this.chatLog.length > 0) {
      s.sendChat(this.chatLog.map((m) => this.chatView(m, s.wallet)));
    }
    s.send(this.stateFor(s));
  }

  /**
   * A line for the room. The text arrives already cleaned and capped by the
   * socket layer; this fans it out to everyone connected, sender included —
   * the sender's own copy coming back is the delivery receipt.
   */
  chat(s: Session, text: string): void {
    const row = this.db.player(s.wallet);
    const msg: NetChat & { wallet: string } = {
      id: this.nextChatId++,
      wallet: s.wallet,
      name: shortAddress(s.wallet),
      charId: row.charId,
      text,
      at: Date.now(),
    };
    this.chatLog.push(msg);
    if (this.chatLog.length > 50) this.chatLog.shift();
    for (const sess of this.sessions) sess.sendChat([this.chatView(msg, sess.wallet)]);
  }

  /** The recipient's copy: `you` on the full wallet, the wallet itself dropped. */
  private chatView(m: NetChat & { wallet: string }, wallet: string): NetChat {
    const { wallet: w, ...pub } = m;
    return { ...pub, you: w === wallet };
  }

  /** Pushes a fresh state to one session — after a deposit or withdrawal. */
  refresh(s: Session): void {
    if (this.sessions.has(s)) s.send(this.stateFor(s));
  }

  detach(s: Session): void {
    this.sessions.delete(s);
  }

  // ---------------------------------------------------------------- lifecycle

  private openLobby(): void {
    this.phase = "lobby";
    this.roundId++;
    this.round = null;
    this.seats.clear();
    this.seatOf.clear();
    this.nextSeatId = 1;
    this.winner = null;
    this.winnerWallet = null;
    this.bonanza = null;
    this.bonanzaWallet = null;
    this.phaseEnd = Date.now() + this.config.timing.lobbyMs;

    // Commit-reveal, run server side: the seed is drawn from the OS CSPRNG and
    // its hash is published before anybody is sealed in. The seed itself is
    // released only once the round is over, so nobody — including whoever runs
    // this process — can know an outcome in advance and act on it.
    // 128 bits, not 32. A 32-bit seed makes the published commitment an oracle
    // an attacker can simply enumerate during the lobby — see rngFromSeedHex.
    this.seedHex = randomBytes(16).toString("hex");
    this.commit = sha256Hex(commitPreimage(this.roundId, this.seedHex, this.rulesHash));
    this.db.openRound(this.roundId, this.commit, Date.now());

    this.autoJoin();
    this.broadcast(true);
  }

  /**
   * Distinct humans. One person can hold several sockets — two tabs, a
   * reconnect racing its own close — and counting sockets reports a crowd
   * that is not there, which on a PvP game is a lie about the only number
   * that tells a player whether it is worth waiting for the lobby.
   */
  private onlineWallets(): number {
    const seen = new Set<string>();
    for (const s of this.sessions) seen.add(s.wallet);
    return seen.size;
  }

  /** One session per wallet, so per-wallet work is not done N times over. */
  private uniqueSessions(): Session[] {
    const byWallet = new Map<string, Session>();
    for (const s of this.sessions) if (!byWallet.has(s.wallet)) byWallet.set(s.wallet, s);
    return [...byWallet.values()];
  }

  private autoJoin(): void {
    for (const s of this.uniqueSessions()) {
      const row = this.db.player(s.wallet);
      if (row.autoEnabled) this.join(s);
    }
  }

  /** A human buys a seat. The debit happens here or the seat does not exist. */
  join(s: Session): string | null {
    if (this.phase !== "lobby") return "the lattice is already sealed";
    if (this.seatOf.has(s.wallet)) return null;
    // The lobby cap is a game rule, not a simulation detail: the hazard curve
    // reads crowding off the field size, and every economic guarantee is
    // certified over the configured range. An uncapped lobby runs the game
    // outside the numbers that were verified.
    if (this.seats.size >= this.config.field.max) return "the lattice is full";
    const stake = toLamports(this.config.entry);
    const id = this.nextSeatId++;
    // Debit and entry row commit together, or the seat does not exist.
    if (!this.db.takeEntry(this.roundId, s.wallet, stake, id)) return "not enough balance";

    this.db.touch(s.wallet);
    const row = this.db.player(s.wallet);
    this.seats.set(id, {
      id,
      wallet: s.wallet,
      name: shortAddress(s.wallet),
      charId: row.charId,
    });
    this.seatOf.set(s.wallet, id);
    this.broadcast(true);
    return null;
  }

  cashOut(s: Session): void {
    const round = this.round;
    const id = this.seatOf.get(s.wallet);
    if (!round || id === undefined || this.phase !== "live") return;
    const banked = round.cashOut(id);
    if (banked === null) return;
    this.settled.add(id);
    const p = round.players.find((x) => x.id === id);
    this.settleExit(s.wallet, banked, p?.ticksSurvived ?? round.currentTick, "cashed");
    // An exit that empties the lattice ends the round right here, between
    // ticks. `finish` is otherwise only reachable from `tick`, and the tick
    // loop refuses to run a finished round — so without this the server sits
    // in "live" forever on a dead round: no close, no seed reveal, no ticket
    // credit, no next lobby, and every future join rejected. One player
    // cashing out last is enough to freeze the whole game.
    if (round.finished) this.finish();
    else this.broadcast(true);
  }

  private settleExit(wallet: string, sol: number, ticks: number, outcome: string): void {
    const lamports = toLamports(sol);
    if (lamports > 0) this.db.adjustBalance(wallet, lamports);
    const multiple = sol / this.config.entry;
    this.db.settleEntry(
      this.roundId,
      wallet,
      lamports,
      multiple,
      ticks,
      outcome,
      multiple >= 1,
    );
    for (const s of this.sessions) {
      if (s.wallet === wallet) s.session += sol - this.config.entry;
    }
  }

  private seal(): void {
    // Every entrant is a human whose exits arrive over the wire, so the
    // engine-side strategy never fires. The round consumes RNG only for
    // eliminations, which is exactly what the replay a player verifies re-runs.
    const entrants: Entrant[] = [];
    for (const seat of this.seats.values()) {
      entrants.push({ id: seat.id, strategyId: "human", strategy: () => false });
    }
    this.settled.clear();
    this.round = new Round(this.config, rngFromSeedHex(this.seedHex), entrants);
    this.phase = "live";
    this.nextTickAt = Date.now() + this.config.timing.tickMs;
    this.broadcast(true);
  }

  private loop(): void {
    const now = Date.now();
    if (this.phase === "lobby") {
      this.autoEnter();
      if (now >= this.phaseEnd) {
        if (this.seats.size >= CONFIG.minEntrants) this.seal();
        // Too thin to be a game: roll the lobby rather than run a round in
        // which the only entrant is guaranteed their money back.
        else this.phaseEnd = now + this.config.timing.lobbyMs;
      }
    } else if (this.phase === "live") {
      // One tick per pass, and a hard resync when the clock has run away.
      //
      // Replaying every missed tick in a single burst turns any stall — a GC
      // pause, a laptop lid, a slow disk — directly into elimination rolls
      // nobody saw and nobody could react to, because no state is pushed until
      // the burst ends and queued cash-outs are handled after it, by which
      // time the player is already dead.
      if (this.round && !this.round.finished && now >= this.nextTickAt) {
        this.tick();
        this.nextTickAt += this.config.timing.tickMs;
        if (now - this.nextTickAt > this.config.timing.tickMs * 4) {
          this.nextTickAt = now + this.config.timing.tickMs;
        }
      }
    } else if (now >= this.phaseEnd) {
      this.openLobby();
      return;
    }
    this.broadcast();
  }

  /** Late auto-players who connected mid-lobby still get pulled in. */
  private autoEnter(): void {
    for (const s of this.uniqueSessions()) {
      if (this.seatOf.has(s.wallet)) continue;
      const row = this.db.player(s.wallet);
      if (row.autoEnabled) this.join(s);
    }
  }

  private tick(): void {
    const round = this.round;
    if (!round) return;
    round.step();

    // Settle from player state rather than the tick event: the event carries
    // a COUNT of the eliminated, not their ids, and every exit must be booked
    // exactly once. The settled set is what guarantees the "exactly once".
    for (const p of round.players) {
      if (p.outcome === "dead" && !this.settled.has(p.id)) {
        this.settled.add(p.id);
        const seat = this.seats.get(p.id);
        if (seat) this.settleExit(seat.wallet, 0, p.ticksSurvived, "dead");
      }
    }

    // Server-side auto cash-out: the exit fires on the tick the multiple
    // crosses the target, so it banks the crossing value — never below the
    // target, sometimes above it. Iterates seats, not sessions: the whole
    // point of auto is that it still saves you when your connection dies
    // mid-round, and a session is exactly the thing a disconnect removes.
    for (const seat of this.seats.values()) {
      const p = round.players.find((x) => x.id === seat.id);
      if (!p || p.outcome !== "in") continue;
      const row = this.db.player(seat.wallet);
      if (row.autoEnabled && p.balance / this.config.entry >= row.autoTarget) {
        const banked = round.cashOut(seat.id);
        if (banked !== null) {
          this.settled.add(seat.id);
          this.settleExit(seat.wallet, banked, p.ticksSurvived, "cashed");
        }
      }
    }

    if (round.finished) this.finish();
  }

  private finish(): void {
    const round = this.round;
    if (!round) return;
    const res = round.result();
    const now = Date.now();

    // Anyone the engine settled that the tick loop did not already pay —
    // sole survivors auto-banked at the end of the round.
    for (const p of res.players) {
      const seat = this.seats.get(p.id);
      if (!seat) continue;
      const id = this.ledgerId(seat.wallet);
      this.jackpot.credit(id, p.bonanzaTickets);
      this.revShare.credit(id, now);
      if (!this.settled.has(p.id)) {
        this.settled.add(p.id);
        this.settleExit(
          seat.wallet,
          p.cashedOut,
          p.ticksSurvived,
          p.outcome === "dead" ? "dead" : "cashed",
        );
      }
    }

    this.jackpot.fund(res.toBonanza + res.wipeLeak);
    this.revShare.distribute(res.toRevShare, now);

    // The rakeback stream pays out continuously, including to players sitting
    // the round out. Without this the house charges the rev-share rake and
    // never returns it, which is a build advertising 98% while paying 96%.
    //
    // The credit and the claimed marker are one transaction: separately, a
    // crash between them pays the money and forgets it was paid, and the next
    // round pays the whole lifetime total again.
    for (const [wallet, id] of this.ledgerIds) {
      const owed = this.revShare.earningsOf(id);
      const claimed = toSol(this.db.revClaimed(wallet));
      const delta = owed - claimed;
      if (delta > 1e-12) {
        const lamports = toLamports(delta);
        if (lamports > 0) {
          this.db.payRakeback(wallet, lamports, toLamports(owed));
          for (const s of this.sessions) if (s.wallet === wallet) s.session += delta;
        }
      }
    }

    let best = 0;
    for (const p of res.players) best = Math.max(best, p.cashedOut / this.config.entry);
    const champ =
      res.players.find((p) => p.lastStanding) ??
      [...res.players].filter((p) => p.outcome === "cashed").sort((a, b) => b.cashedOut - a.cashedOut)[0];
    const champSeat = champ ? this.seats.get(champ.id) : undefined;
    this.winnerWallet = champSeat?.wallet ?? null;
    this.winner = champ && champSeat
      ? {
          name: champSeat.name,
          charId: champSeat.charId,
          you: false,
          multiple: champ.cashedOut / this.config.entry,
          amount: champ.cashedOut,
          lastStanding: champ.lastStanding === true,
        }
      : null;

    if (champSeat) {
      this.teamWins[champSeat.charId] = (this.teamWins[champSeat.charId] ?? 0) + 1;
    }

    // Rolled BEFORE the round is written, so the draw goes into the record
    // and a player can recompute it from the revealed seed. A jackpot decided
    // after the record is sealed is a jackpot nobody can check.
    const bonanzaTrace = this.rollBonanza();

    this.db.closeRound(
      this.roundId,
      this.seedHex,
      res.players.length,
      res.ticks,
      best,
      champSeat?.wallet ?? null,
      champSeat?.charId ?? null,
      toLamports(res.pot),
      JSON.stringify({
        seedHex: this.seedHex,
        config: this.config,
        entrantIds: res.players.map((p) => p.id),
        cashOuts: res.cashOuts,
        ...(bonanzaTrace ? { bonanza: bonanzaTrace } : {}),
      }),
      outcomeDigest(res),
    );

    this.persistTickets();

    this.phase = "result";
    // A fire earns the longer result phase the celebration was written for.
    // bonanzaMs was configured, documented, and read by nobody on the server.
    this.phaseEnd =
      now + (this.bonanza ? this.config.timing.bonanzaMs : this.config.timing.resultMs);
    for (const s of this.sessions) this.pushHistory(s);
    this.broadcast(true);
  }

  /**
   * The jackpot draw.
   *
   * On a stream derived from the round's already-committed seed, never on the
   * presentation RNG. The bonanza is the single largest payout in the game and
   * it was being decided by a 32-bit wall-clock-seeded generator sitting
   * entirely outside the fairness ceremony — unverifiable by any player and
   * predictable to anyone who knew when the process booted. Now the draws are
   * fixed by the same hash published before the round sealed, and they are
   * written into the round record so a player can recompute them.
   */
  private rollBonanza(): { fire: number; winner: number; totalTickets: number; winnerId: number | null } | null {
    const fire = this.jackpot.roll(deriveRng(this.seedHex, BONANZA_TAG));
    const draws = this.jackpot.lastDraws;
    const trace = draws ? { ...draws, winnerId: fire?.winnerId ?? null } : null;
    if (!fire) return trace;

    let winnerWallet = "";
    for (const [wallet, id] of this.ledgerIds) {
      if (id === fire.winnerId) winnerWallet = wallet;
    }
    // Credit, ticket wipe and the pool's persisted value move together or not
    // at all. Split across three autocommits, a crash between the payout and
    // the meta write left the winner paid AND the pool restored at full value
    // on restart — the house minting an entire second jackpot from nothing.
    this.db.settleBonanza(
      winnerWallet || null,
      winnerWallet ? toLamports(fire.amount) : 0,
      String(toLamports(this.jackpot.pool)),
    );
    if (winnerWallet) {
      for (const s of this.sessions) {
        if (s.wallet === winnerWallet) s.session += fire.amount;
      }
    }
    this.bonanzaWallet = winnerWallet || null;
    this.bonanza = {
      amount: fire.amount,
      winner: shortAddress(winnerWallet || "?"),
      youWon: false,
      at: Date.now(),
    };
    return trace;
  }

  private persistTickets(): void {
    const now = Date.now();
    for (const [wallet, id] of this.ledgerIds) {
      this.db.setTickets(
        wallet,
        this.jackpot.ticketsOf(id),
        this.revShare.lifetimeOf(id),
        this.revShare.weightOf(id, now),
      );
    }
    this.db.setMeta("bonanzaPool", String(toLamports(this.jackpot.pool)));
  }

  // ------------------------------------------------------------------ output

  private pushHistory(s: Session): void {
    const rows = this.db.historyFor(s.wallet, 40);
    s.sendHistory(
      rows.map((r) => ({
        roundId: r.roundId,
        entrants: r.entrants,
        ticks: r.ticks,
        bestMultiple: r.bestMult,
        yourOutcome: r.outcome === "dead" ? "dead" : "cashed",
        yourMultiple: r.multiple,
        yourSeat: r.seat > 0 ? r.seat : null,
        commit: r.commit,
        seedHex: r.seedHex,
        winnerChar: r.winnerCh,
        winnerYou: r.winner === s.wallet,
        record: r.record,
        digest: r.digest,
      })),
    );
  }

  private viewOf(seat: Seat, wallet: string): NetPlayer {
    const p = this.round?.players.find((x) => x.id === seat.id);
    const rake = 1 - totalRake(this.config);
    if (!p) {
      return {
        id: seat.id,
        name: seat.wallet === wallet ? "YOU" : seat.name,
        you: seat.wallet === wallet,
        charId: seat.charId,
        outcome: "in",
        multiple: rake,
        balance: this.config.entry * rake,
        ticksSurvived: 0,
      };
    }
    return {
      id: seat.id,
      name: seat.wallet === wallet ? "YOU" : seat.name,
      you: seat.wallet === wallet,
      charId: seat.charId,
      outcome: p.outcome,
      multiple: (p.outcome === "in" ? p.balance : p.cashedOut) / this.config.entry,
      balance: p.outcome === "in" ? p.balance : p.cashedOut,
      ticksSurvived: p.ticksSurvived,
    };
  }

  private stateFor(s: Session): NetState {
    const cfg = this.config;
    const round = this.round;
    const row = this.db.player(s.wallet);
    const players = [...this.seats.values()].map((seat) => this.viewOf(seat, s.wallet));
    const live = players.filter((p) => p.outcome === "in").length;
    const dead = players.filter((p) => p.outcome === "dead").length;
    const cashed = players.filter((p) => p.outcome === "cashed").length;

    const seatId = this.seatOf.get(s.wallet);
    const you = seatId === undefined ? undefined : round?.players.find((p) => p.id === seatId);
    const joined = seatId !== undefined;

    const graceLeft = round ? Math.max(0, cfg.hazard.graceTicks - round.currentTick) : cfg.hazard.graceTicks;
    const hazard =
      round && this.phase === "live" && !round.finished && live > 0
        ? hazardAt(cfg.hazard, round.currentTick + 1, live, round.players.length)
        : 0;

    let multiplier = 1 - totalRake(cfg);
    if (round) {
      const anyLive = round.players.find((p) => p.outcome === "in");
      if (anyLive) multiplier = anyLive.balance / cfg.entry;
      else {
        let best = 0;
        for (const p of round.players) best = Math.max(best, p.cashedOut / cfg.entry);
        multiplier = best || multiplier;
      }
    }

    // Read-only: a spectator who never entered a round must not be enrolled
    // in the ledgers just for having the page open.
    const id = this.ledgerIdIfAny(s.wallet);
    const bonTotal = this.jackpot.totalTickets;
    const revTotal = this.revShare.totalWeight(Date.now());
    const bonYours = id === undefined ? 0 : this.jackpot.ticketsOf(id);

    return {
      phase: this.phase,
      roundId: this.roundId,
      tick: round?.currentTick ?? 0,
      multiplier,
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
        joined,
        outcome: !joined ? "out" : (you?.outcome ?? "in"),
        balance: you ? (you.outcome === "in" ? you.balance : you.cashedOut) : 0,
        multiple: you ? (you.outcome === "in" ? you.balance : you.cashedOut) / cfg.entry : 0,
        lockedMultiple: you && you.outcome === "cashed" ? you.cashedOut / cfg.entry : null,
      },
      wallet: toSol(row.balance),
      session: s.session,
      bonanzaPool: this.jackpot.pool,
      bonanzaTickets: bonYours,
      revShareTickets: id === undefined ? 0 : this.revShare.lifetimeOf(id),
      // Both of these are compared on the full wallet, never the display name:
      // shortAddress collapses to 4+4 characters, and two players sharing an
      // abbreviation would each be told they had won.
      bonanza: this.bonanza
        ? { ...this.bonanza, youWon: this.bonanzaWallet === s.wallet }
        : null,
      charId: row.charId,
      winner: this.winner ? { ...this.winner, you: this.winnerWallet === s.wallet } : null,
      teamWins: this.teamWins,
      tickets: {
        bonYours,
        bonTotal,
        bonShare: bonTotal > 0 ? bonYours / bonTotal : 0,
        revShare:
          id !== undefined && revTotal > 0
            ? this.revShare.weightOf(id, Date.now()) / revTotal
            : 0,
        revStreamed: toSol(row.revEarned),
      },
      nextCommit: this.commit,
      auto: { enabled: row.autoEnabled === 1, target: row.autoTarget },
      stats: {
        roundsPlayed: row.roundsPlayed,
        roundsWon: row.roundsWon,
        wagered: toSol(row.wagered),
        returned: toSol(row.returned),
        bestMultiple: row.bestMultiple,
        revEarned: toSol(row.revEarned),
        bonanzaWon: toSol(row.bonanzaWon ?? 0),
      },
      online: this.onlineWallets(),
    };
  }

  /**
   * Push state to everyone.
   *
   * The main loop runs at 50ms, but building a state costs a database read and
   * a walk of every seat *per session*, so broadcasting on every pass was 20
   * full serialisations per player per second to show a countdown that changes
   * ten times slower than that. Anything that actually changes the game — a
   * tick, a seal, an entry, a settlement — forces the send; the loop's routine
   * heartbeat is rate limited.
   */
  private broadcast(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastBroadcast < 200) return;
    this.lastBroadcast = now;
    for (const s of this.sessions) s.send(this.stateFor(s));
  }
}
