import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_CONFIG,
  Round,
  canonicalConfig,
  hazardAt,
  mulberry32,
  outcomeDigest,
  rngFromSeedHex,
  totalRake,
  type Entrant,
  type GameConfig,
  type Rng,
  type Strategy,
} from "@zinc/engine";
import { CHARS, CONFIG, toLamports, toSol } from "./config.ts";
import type { Database } from "./db.ts";
import type { NetChat, NetHistory, NetPlayer, NetState } from "./protocol.ts";

/** The roster. Also the whitelist for what a client may set as its character. */
export { CHARS } from "./config.ts";

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
 * wallet — this game has no house players, by design and on purpose: a seat in
 * a PvP round is the house playing its own customers.
 */
interface Seat {
  id: number;
  wallet: string;
  name: string;
  charId: string;
  /** Lifetime record snapshot from join time, shown on the profile card. */
  lifetime: NonNullable<NetPlayer["lifetime"]>;
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
  /** Every seat a wallet holds this round. Multi-betting is several plates. */
  private seatsOf = new Map<string, number[]>();
  /** Seat ids already paid out this round. Exits must book exactly once. */
  private settled = new Set<number>();
  private nextSeatId = 1;

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
  /** Set when the round ended because one wallet owned every live plate. */
  private soleOwnerWallet: string | null = null;
  /** Wallet that banked on the very tick every other standing player died.
   *  It faced the final roll and survived it — the survivor's claim, even
   *  though the walk-out left the engine with nobody to flag. */
  private outlastedWallet: string | null = null;
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
  }

  start(): void {
    if (this.timer) return;
    this.openLobby();
    // The catch is load-bearing. Without it a throw anywhere in the tick or
    // close path unwinds to the process-level uncaughtException handler,
    // which keeps the server alive — with the round wedged "live" forever
    // and every stake locked, because the state that gates the next tick was
    // already half-advanced. Staying up is only safe if the round dies too.
    this.timer = setInterval(() => {
      try {
        this.loop();
      } catch (err) {
        this.abortRound(err);
      }
    }, 50);
  }

  /**
   * The emergency exit for a round the loop could not finish: roll it back
   * exactly like the startup sweep would after a crash — every entry
   * refunded, cash-outs clawed back, the round row left open as the audit
   * trail — then reopen the lobby. The in-memory ticket ledgers may briefly
   * carry the aborted round's accruals (they re-sync from the database on
   * the next restart); that dust is accepted, because the alternative was a
   * room that sits in "live" forever with everyone's stake locked.
   */
  private abortRound(err: unknown): void {
    console.error("round aborted", this.roundId, err);
    try {
      this.db.refundOpenEntries();
    } catch (e) {
      console.error("abort refund failed", e);
    }
    try {
      this.round = null;
      this.settled.clear();
      this.phase = "result";
      this.phaseEnd = Date.now() + this.config.timing.resultMs;
      this.broadcast(true);
    } catch (e) {
      console.error("abort reset failed", e);
    }
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
    this.seatsOf.clear();
    this.nextSeatId = 1;
    this.winner = null;
    this.winnerWallet = null;
    this.soleOwnerWallet = null;
    this.outlastedWallet = null;
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
      if (row.autoEnabled) this.autoBuy(s, row.autoPlates ?? 1);
    }
  }

  /** Buys up to auto's plate count, stopping at any refusal (cap, funds). */
  private autoBuy(s: Session, want: number): void {
    const target = Math.min(Math.max(1, want), CONFIG.maxPlatesPerWallet);
    while ((this.seatsOf.get(s.wallet)?.length ?? 0) < target) {
      if (this.join(s) !== null) break;
    }
  }

  /**
   * A human buys a seat — or another one. Pressing bond again while already
   * standing buys an additional plate, up to the per-wallet cap. EV per plate
   * is identical however many one wallet holds (multi-study.ts measures it);
   * the cap protects the LOBBY, because the field is finite and one whale
   * filling it locks everyone else out of the round.
   */
  join(s: Session): string | null {
    if (this.phase !== "lobby") return "the lattice is already sealed";
    const mine = this.seatsOf.get(s.wallet) ?? [];
    if (mine.length >= CONFIG.maxPlatesPerWallet) {
      return `plate limit is ${CONFIG.maxPlatesPerWallet} per round`;
    }
    // The lobby cap is a game rule, not a simulation detail: the hazard curve
    // reads crowding off the field size, and every economic guarantee is
    // certified over the configured range. An uncapped lobby runs the game
    // outside the numbers that were verified.
    if (this.seats.size >= this.config.field.max) return "the lattice is full";
    const stake = toLamports(this.config.entry);
    const id = this.nextSeatId++;
    // Read BEFORE the debit, so the lifetime snapshot on the profile card is
    // "as of stepping on" rather than dipping by one unsettled stake.
    const row = this.db.player(s.wallet);
    // Debit and entry row commit together, or the seat does not exist.
    if (!this.db.takeEntry(this.roundId, s.wallet, stake, id)) return "not enough balance";

    this.db.touch(s.wallet);
    this.seats.set(id, {
      id,
      wallet: s.wallet,
      name: shortAddress(s.wallet),
      charId: row.charId,
      lifetime: {
        wagered: toSol(row.wagered),
        // Everything paid back minus everything staked: the wallet's true
        // lifetime result against this house.
        net: toSol(row.returned - row.wagered),
        hitRate: row.roundsPlayed > 0 ? row.roundsWon / row.roundsPlayed : 0,
        best: row.bestMultiple,
      },
    });
    this.seatsOf.set(s.wallet, [...mine, id]);
    this.broadcast(true);
    return null;
  }

  /**
   * Steps a wallet off the ice DURING THE LOBBY: every plate refunded in
   * full, as if never bought. Without this a player whose lobby never fills
   * is locked in indefinitely — bonded, unsealed, waiting on strangers.
   * Auto play switches off with it: stepping off IS the statement that you
   * are done, and auto re-buying the seat back would make the button a lie.
   */
  unjoin(s: Session): string | null {
    if (this.phase !== "lobby") return "the lattice is already sealed";
    const mine = this.seatsOf.get(s.wallet);
    if (!mine || mine.length === 0) return null;
    for (const id of mine) {
      if (this.db.refundLobbyEntry(this.roundId, s.wallet, id)) {
        this.seats.delete(id);
      }
    }
    this.seatsOf.delete(s.wallet);
    const row = this.db.player(s.wallet);
    if (row.autoEnabled) {
      this.db.setAuto(s.wallet, false, row.autoTarget, row.autoPlates ?? 1);
    }
    this.broadcast(true);
    return null;
  }

  /**
   * One press extracts EVERY live plate the wallet holds, at the same tick and
   * therefore the same multiple — live plates always share one balance, so
   * per-plate management would be buttons with nothing to decide.
   */
  cashOut(s: Session): void {
    const round = this.round;
    const mine = this.seatsOf.get(s.wallet);
    if (!round || !mine || this.phase !== "live") return;
    let any = false;
    for (const id of mine) {
      const banked = round.cashOut(id);
      if (banked === null) continue;
      any = true;
      this.settled.add(id);
      const p = round.players.find((x) => x.id === id);
      this.settleExit(s.wallet, id, banked, p?.ticksSurvived ?? round.currentTick, "cashed");
    }
    if (!any) return;
    // This exit may have left every live plate in one wallet's hands.
    if (!round.finished) this.bankSoleOwner();
    // An exit that empties the lattice ends the round right here, between
    // ticks. `finish` is otherwise only reachable from `tick`, and the tick
    // loop refuses to run a finished round — so without this the server sits
    // in "live" forever on a dead round: no close, no seed reveal, no ticket
    // credit, no next lobby, and every future join rejected. One player
    // cashing out last is enough to freeze the whole game.
    if (round.finished) this.finish();
    else this.broadcast(true);
  }

  /**
   * Ends the hollow endgame: once every live plate belongs to ONE wallet, the
   * round's outcome is already decided. A death among their plates only moves
   * money between their own hands, and the survivor rule guarantees the last
   * plate banks — so the sole owner takes exactly the same money whether the
   * clock runs out or not, and making them watch it run is dead air. Mirrors
   * the engine's sole-SURVIVOR rule, one level up: no opponent, no game.
   *
   * Implemented as genuine engine cash-outs, never a shortcut settlement:
   * each exit lands in the round's cash-out log, so the fairness record
   * replays byte-for-byte and the ceremony never learns the word "owner".
   */
  private bankSoleOwner(): void {
    const round = this.round;
    if (!round || round.finished || this.phase !== "live") return;
    const live = round.players.filter((p) => p.outcome === "in");
    if (live.length === 0) return;
    const owners = new Set(live.map((p) => this.seats.get(p.id)?.wallet ?? `?${p.id}`));
    if (owners.size !== 1) return;
    this.soleOwnerWallet = [...owners][0]!;
    for (const p of live) {
      const banked = round.cashOut(p.id);
      if (banked === null) continue;
      this.settled.add(p.id);
      const seat = this.seats.get(p.id);
      if (seat) this.settleExit(seat.wallet, p.id, banked, p.ticksSurvived, "cashed");
    }
  }

  private settleExit(wallet: string, seat: number, sol: number, ticks: number, outcome: string): void {
    const lamports = toLamports(sol);
    // The balance credit rides INSIDE settleEntry's transaction: credited
    // separately, a crash between the two made the startup sweep re-credit
    // the stake on top of the payout (see settleEntry).
    const multiple = sol / this.config.entry;
    this.db.settleEntry(
      this.roundId,
      wallet,
      seat,
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
      // Every exit arrives over the wire, so the engine-side strategy never
      // fires. It is kept as a no-op because the engine's Entrant shape wants
      // one; nothing in this game decides in-tick any more.
      entrants.push({
        id: seat.id,
        strategyId: "human",
        strategy: () => false,
      });
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
        // Distinct WALLETS, not seats: with multi-betting one wallet can hold
        // several plates, and a round whose every plate is one person is not
        // PvP — it is one player paying rake to shuffle money between their
        // own hands. Too thin to be a game: roll the lobby instead.
        //
        // Nothing pads this number any more. The room used to be kept alive
        // by practice bots that counted toward the minimum and could carry a
        // round alone; with them gone, an empty lobby simply rolls over until
        // real players arrive, which is the honest behaviour.
        if (this.seatsOf.size >= CONFIG.minEntrants) this.seal();
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

  /** Late auto-players who connected mid-lobby still get pulled in.
      Auto play buys exactly ONE plate per round; extra breadth is a choice. */
  private autoEnter(): void {
    for (const s of this.uniqueSessions()) {
      // Any seat means auto already ran (or the player bought by hand); auto
      // never tops up a position the player chose themselves.
      if (this.seatsOf.has(s.wallet)) continue;
      const row = this.db.player(s.wallet);
      if (row.autoEnabled) this.autoBuy(s, row.autoPlates ?? 1);
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
        if (seat) this.settleExit(seat.wallet, p.id, 0, p.ticksSurvived, "dead");
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
          this.settleExit(seat.wallet, seat.id, banked, p.ticksSurvived, "cashed");
        }
      }
    }

    // Deaths or auto-exits this tick may have left one wallet owning every
    // live plate; the round is decided, so it ends now.
    if (!round.finished) this.bankSoleOwner();

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
      if (!this.settled.has(p.id)) {
        this.settled.add(p.id);
        this.settleExit(
          seat.wallet,
          p.id,
          p.cashedOut,
          p.ticksSurvived,
          p.outcome === "dead" ? "dead" : "cashed",
        );
      }
    }

    let best = 0;
    for (const p of res.players) best = Math.max(best, p.cashedOut / this.config.entry);
    // Crown priority: the engine's survivor; else a sole-owner ending's
    // owner (they outlasted every other WALLET, the same claim the survivor
    // flag makes); else best extraction, ties broken by ticks survived so
    // the face on the scene is the plate still visibly standing on the
    // board. Seat-order ties crowned a wallet that left ten ticks earlier
    // while the board showed someone else's plates as the last ones up.
    const cashed = res.players.filter((p) => p.outcome === "cashed");

    // The third "last one standing" in spirit: the engine flagged nobody
    // (a walk-out emptied the ice), but ONE wallet banked on the very tick
    // every other standing player died. Deaths roll before exits, so that
    // wallet faced the final roll, survived it, and left with the pot —
    // mechanically an extraction, narratively the survivor. Needs a death
    // on that tick (a mutual final-tick walk-out is a dead heat, not a
    // survival) and exactly one such wallet.
    if (
      !res.players.some((p) => p.lastStanding) &&
      res.players.some((p) => p.outcome === "dead" && p.ticksSurvived === res.ticks)
    ) {
      const finalExits = new Set<string>();
      for (const p of res.players) {
        if (p.outcome !== "cashed" || p.ticksSurvived !== res.ticks) continue;
        const s = this.seats.get(p.id);
        if (s) finalExits.add(s.wallet);
      }
      if (finalExits.size === 1) this.outlastedWallet = [...finalExits][0]!;
    }

    const champ =
      res.players.find((p) => p.lastStanding) ??
      (this.soleOwnerWallet !== null
        ? cashed.find((p) => this.seats.get(p.id)?.wallet === this.soleOwnerWallet)
        : undefined) ??
      (this.outlastedWallet !== null
        ? cashed.find((p) => this.seats.get(p.id)?.wallet === this.outlastedWallet)
        : undefined) ??
      [...cashed].sort(
        (a, b) => b.cashedOut - a.cashedOut || b.ticksSurvived - a.ticksSurvived,
      )[0];
    const champSeat = champ ? this.seats.get(champ.id) : undefined;
    this.winnerWallet = champSeat?.wallet ?? null;

    // A sole-owner ending is "last one standing" in spirit: they outlasted
    // every other WALLET. Only claimed when the champion IS that wallet — an
    // earlier extraction at a higher multiple still wins the scene as an
    // extraction. Decided BEFORE the tie count: a last-one-standing has no
    // peers by definition, and computing ties anyway rendered "last one
    // standing · YOU +2 more" over a walk-out.
    const lastStanding =
      champ !== undefined &&
      champSeat !== undefined &&
      (champ.lastStanding === true ||
        (this.soleOwnerWallet !== null && champSeat.wallet === this.soleOwnerWallet) ||
        (this.outlastedWallet !== null && champSeat.wallet === this.outlastedWallet));

    // Distinct wallets that banked exactly the champion's extraction ON the
    // champion's tick. A simultaneous exit ties to the lamport, and calling
    // one of them "best" is a coin flip dressed as a verdict — the scene says
    // "dead heat". Same tick matters: the multiple sits flat across ticks
    // where nothing changes, so an earlier exit at the same price is the same
    // ride sold sooner, not a dead heat.
    // Distinct WALLETS: one player's multi-plate cash-out always ties itself.
    let tied = 1;
    if (champ && champSeat && !lastStanding) {
      const wallets = new Set<string>();
      for (const p of res.players) {
        if (p.outcome !== "cashed") continue;
        if (p.ticksSurvived !== champ.ticksSurvived) continue;
        if (Math.abs(p.cashedOut - champ.cashedOut) > 1e-9) continue;
        const s2 = this.seats.get(p.id);
        if (s2) wallets.add(s2.wallet);
      }
      tied = Math.max(1, wallets.size);
    }
    this.winner = champ && champSeat
      ? {
          name: champSeat.name,
          charId: champSeat.charId,
          you: false,
          multiple: champ.cashedOut / this.config.entry,
          amount: champ.cashedOut,
          lastStanding,
          tied,
        }
      : null;

    if (champSeat) {
      this.teamWins[champSeat.charId] = (this.teamWins[champSeat.charId] ?? 0) + 1;
    }

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
      }),
      outcomeDigest(res),
    );

    this.phase = "result";
    this.phaseEnd = now + this.config.timing.resultMs;
    for (const s of this.sessions) this.pushHistory(s);
    this.broadcast(true);
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
        yourOutcome: r.anyBanked > 0 ? "cashed" : "dead",
        // Blended across the wallet's plates: total out over total in.
        yourMultiple: r.staked > 0 ? r.returned / r.staked : null,
        yourSeats: String(r.seats ?? "")
          .split(",")
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x) && x > 0),
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
        lifetime: seat.lifetime,
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
      // Sole-owner and outlasted endings count: those plates stood until
      // every other wallet was gone, which is the same claim the flag
      // makes — and the flag keeps them standing on the end-screen board.
      lastStanding:
        p.lastStanding === true ||
        ((this.soleOwnerWallet !== null && seat.wallet === this.soleOwnerWallet) ||
          (this.outlastedWallet !== null && seat.wallet === this.outlastedWallet)
          ? p.outcome === "cashed"
          : false),
      lifetime: seat.lifetime,
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

    // All the wallet's plates, aggregated: live plates always share one
    // balance, so the blended multiple is the per-plate multiple while any
    // are standing, and total-out over total-in once they are not.
    const mySeats = this.seatsOf.get(s.wallet) ?? [];
    const joined = mySeats.length > 0;
    const myPlayers = round
      ? mySeats.flatMap((id) => round.players.filter((p) => p.id === id))
      : [];
    const alive = myPlayers.filter((p) => p.outcome === "in").length;
    const cashedMine = myPlayers.filter((p) => p.outcome === "cashed").length;
    const deadMine = myPlayers.filter((p) => p.outcome === "dead").length;
    const myTotal = myPlayers.reduce(
      (a, p) => a + (p.outcome === "in" ? p.balance : p.cashedOut),
      0,
    );
    const myStake = mySeats.length * cfg.entry;
    const youOutcome: "out" | "in" | "cashed" | "dead" = !joined
      ? "out"
      : myPlayers.length === 0 || alive > 0
        ? "in"
        : cashedMine > 0
          ? "cashed"
          : "dead";

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
        outcome: youOutcome,
        balance: myTotal,
        multiple: myPlayers.length > 0 && myStake > 0 ? myTotal / myStake : 0,
        lockedMultiple:
          joined && alive === 0 && cashedMine > 0 && myStake > 0 ? myTotal / myStake : null,
        plates: {
          total: mySeats.length,
          alive: round ? alive : mySeats.length,
          cashed: cashedMine,
          dead: deadMine,
          max: CONFIG.maxPlatesPerWallet,
        },
      },
      wallet: toSol(row.balance),
      session: s.session,
      charId: row.charId,
      // Compared on the full wallet, never the display name: shortAddress
      // collapses to 4+4 characters, and two players sharing an abbreviation
      // would each be told they had won.
      winner: this.winner ? { ...this.winner, you: this.winnerWallet === s.wallet } : null,
      teamWins: this.teamWins,
      nextCommit: this.commit,
      auto: {
        enabled: row.autoEnabled === 1,
        target: row.autoTarget,
        plates: row.autoPlates ?? 1,
      },
      stats: {
        roundsPlayed: row.roundsPlayed,
        roundsWon: row.roundsWon,
        wagered: toSol(row.wagered),
        returned: toSol(row.returned),
        bestMultiple: row.bestMultiple,
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
