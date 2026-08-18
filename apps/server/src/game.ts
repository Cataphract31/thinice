import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_CONFIG,
  Round,
  canonicalConfig,
  hazardAt,
  outcomeDigest,
  rngFromSeedHex,
  totalRake,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { CONFIG, toLamports, toSol } from "./config.ts";
import { Database } from "./db.ts";
import { LedgerError, type ArcadeLedger } from "./arcade.ts";
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

  /*
   * WHAT A WALLET HAS, AS LAST REPORTED BY THE BOOKS.
   *
   * The state frame carries a balance and is sent on every broadcast, so it
   * cannot ask the ledger each time. This is a CACHE and nothing decides
   * anything from it: a stake is admitted or refused by `ledger.hold`, inside
   * the arcade's own transaction, and this number is only what the screen says.
   * It is refreshed whenever the ledger answers -- every hold and every settle
   * comes back with the wallet's position -- and on attach.
   *
   * `free` is spendable; `held` is staked in rounds that have not settled yet,
   * anywhere on this box. Kept apart because a player whose money is in flight
   * is not broke, and a screen showing only the free half says they are.
   */
  private balances = new Map<string, { free: number; held: number }>();

  /** Seats whose ledger settlement has not been confirmed. Retried at close. */
  private unsettled = new Set<number>();

  constructor(private db: Database, private ledger: ArcadeLedger) {
    this.rulesHash = sha256Hex(canonicalConfig(this.config));
    this.roundId = db.lastRoundId();
    this.teamWins = db.teamWins();
  }

  /**
   * The player record behind a session -- REAL FOR A PLAYER, SYNTHETIC FOR A
   * SPECTATOR.
   *
   * `db.player()` inserts when it does not find a row, which is right for a
   * wallet and wrong for somebody who is only watching. Every path that reached
   * for a row went through it, so the auto-play sweep alone was enough to mint
   * a `players` row for a spectator who had done nothing but connect -- which
   * is exactly what it did until a file-backed database was checked instead of
   * an in-memory one.
   *
   * One accessor, so there is no second place to forget.
   */
  private rowFor(s: Session) {
    return s.guest ? Database.spectatorRow(s.wallet) : this.db.player(s.wallet);
  }

  /** Remember what the books last said about a wallet. Display only. */
  private noteBalance(wallet: string, b: { freeLamports: number; heldLamports: number }): void {
    this.balances.set(wallet, { free: b.freeLamports, held: b.heldLamports });
  }

  /** Ask the books where a wallet stands, and tell the screen. Never decides. */
  private async refreshBalance(wallet: string): Promise<void> {
    try {
      this.noteBalance(wallet, await this.ledger.balanceOf(wallet));
      for (const s of this.sessions) if (s.wallet === wallet) s.send(this.stateFor(s));
    } catch {
      // The books being briefly unreachable must not take the table down. The
      // screen keeps whatever it last knew, and no decision rests on it.
    }
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
    void this.refreshBalance(s.wallet);
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
    const row = this.rowFor(s);
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

  /**
   * Re-read the books for one session, then push what they said.
   *
   * For after a deposit or a withdrawal, neither of which happens here: money
   * enters and leaves at the arcade's custody edge, so nothing in this process
   * observes it. This used to push the CACHED balance, which is the one thing
   * it must not do on this path — the whole reason to call it is that the
   * cached number is the stale one.
   */
  refresh(s: Session): void {
    if (!this.sessions.has(s)) return;
    void this.refreshBalance(s.wallet);
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
      if (s.guest) continue;
      const row = this.rowFor(s);
      // Deliberately not awaited: this runs from the lobby tick, which is
      // synchronous and must stay that way. Each buy settles on its own and a
      // failure is already a normal outcome -- see autoBuy.
      if (row.autoEnabled) void this.autoBuy(s, row.autoPlates ?? 1).catch(() => {});
    }
  }

  /**
   * Buys up to auto's plate count, stopping at any refusal (cap, funds).
   *
   * Async now, because buying a plate moves money and money lives across an
   * HTTP call. Its callers run inside the lobby, which is a waiting phase with
   * seconds to spare, so the buy landing a moment later is invisible -- and a
   * refusal was always the normal outcome for a wallet that cannot cover it.
   */
  private async autoBuy(s: Session, want: number): Promise<void> {
    const target = Math.min(Math.max(1, want), CONFIG.maxPlatesPerWallet);
    while ((this.seatsOf.get(s.wallet)?.length ?? 0) < target) {
      if (this.phase !== "lobby") break;
      if ((await this.join(s)) !== null) break;
    }
  }

  /**
   * A human buys a seat — or another one. Pressing bond again while already
   * standing buys an additional plate, up to the per-wallet cap. EV per plate
   * is identical however many one wallet holds (multi-study.ts measures it);
   * the cap protects the LOBBY, because the field is finite and one whale
   * filling it locks everyone else out of the round.
   */
  async join(s: Session): Promise<string | null> {
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
    // Read BEFORE the stake moves, so the lifetime snapshot on the profile card
    // is "as of stepping on" rather than dipping by one unsettled stake.
    const row = this.rowFor(s);

    /*
     * THE MONEY MOVES FIRST, AND IN THE ARCADE'S BOOKS.
     *
     * The hold IS the affordability check: it refuses atomically inside the
     * ledger's own transaction, so there is no window in which this game
     * believes a wallet can cover a stake that another game on this box has
     * just taken. Reading a balance and then deciding would have exactly that
     * window.
     *
     * If it throws for any other reason -- the books unreachable, no service
     * key -- the seat is NOT sold. Failing closed costs a player one refused
     * join; failing open costs the house a round it never took payment for.
     */
    try {
      this.noteBalance(s.wallet, await this.ledger.hold(s.wallet, stake, this.roundId, id));
    } catch (err) {
      if (err instanceof LedgerError && err.isBroke) return "not enough balance";
      /*
       * A GUEST HAS NO WALLET, AND THEREFORE NO MONEY.
       *
       * Guest ids are namespaced `guest:...` so they can never collide with a
       * real address -- which also means the ledger has no account for them and
       * refuses with BAD_ACCOUNT. That is correct and permanent: money is keyed
       * by wallet across this whole arcade, and an id minted by this server is
       * not one. Said plainly here, because the generic message below would
       * blame the books for a player simply not having signed in.
       */
      if (err instanceof LedgerError && err.code === "BAD_ACCOUNT") {
        return "connect a wallet to play for real -- a guest id holds no money";
      }
      const why = err instanceof LedgerError ? err.code : "unknown";
      console.error(`[thin-ice] hold failed for ${s.wallet} r${this.roundId}s${id}: ${why}`);
      return "the books are unreachable -- your money has not been touched";
    }

    /*
     * And only then the local record. If THIS throws the money is already held
     * with no seat to show for it -- so it is given straight back, and the
     * player is told nothing happened. The release is idempotent, so a second
     * attempt during the startup sweep is free.
     */
    try {
      this.db.takeEntry(this.roundId, s.wallet, stake, id);
    } catch (err) {
      void this.ledger.release(this.roundId, id, "seat could not be recorded").catch(() => {});
      console.error(`[thin-ice] takeEntry failed after a hold: ${(err as Error).message}`);
      return "the table could not record that seat -- nothing was staked";
    }

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
  async unjoin(s: Session): Promise<string | null> {
    if (this.phase !== "lobby") return "the lattice is already sealed";
    const mine = this.seatsOf.get(s.wallet);
    if (!mine || mine.length === 0) return null;
    for (const id of mine) {
      if (this.db.refundLobbyEntry(this.roundId, s.wallet, id)) {
        this.seats.delete(id);
        // The stake goes back in the books. Idempotent, so the startup sweep
        // finding the same hold later is free rather than a double refund.
        try {
          await this.ledger.release(this.roundId, id, "stepped off before the seal");
        } catch (err) {
          // The row is already gone locally and the hold is still open; the
          // sweep will return it. Logged rather than shown, because from the
          // player's side stepping off did work.
          console.error(`[thin-ice] release failed r${this.roundId}s${id}: ${(err as Error).message}`);
        }
      }
    }
    void this.refreshBalance(s.wallet);
    this.seatsOf.delete(s.wallet);
    const row = this.rowFor(s);
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

    /*
     * AND THE MONEY, WHICH IS NOT AWAITED HERE ON PURPOSE.
     *
     * This runs inside the tick loop -- a player cashing out, or dying, while
     * the round is still walking. Awaiting an HTTP call in there would put the
     * arcade's latency inside the game's clock, and a slow ledger would stretch
     * the tick every player is watching.
     *
     * It is safe to fire because the ref makes it exactly-once: `settleRound`
     * retries every seat that has not confirmed when the round closes, and the
     * startup sweep catches anything after a crash. The worst case is that a
     * payout lands a moment late in the books, never that it lands twice or not
     * at all.
     */
    this.unsettled.add(seat);
    void this.ledger
      .settle(this.roundId, seat, lamports)
      .then(() => {
        this.unsettled.delete(seat);
        void this.refreshBalance(wallet);
      })
      .catch((err) => {
        console.error(`[thin-ice] settle deferred r${this.roundId}s${seat}: ${(err as Error).message}`);
      });
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
      if (this.seatsOf.has(s.wallet) || s.guest) continue;
      const row = this.rowFor(s);
      if (row.autoEnabled) void this.autoBuy(s, row.autoPlates ?? 1).catch(() => {});
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

    // Anything the tick loop fired and did not get confirmation for. Idempotent
    // by ref, so retrying a settle that actually succeeded costs one request
    // and changes nothing.
    void this.reconcileRound(this.roundId);
  }

  /**
   * Make the books agree with the round that just ended.
   *
   * Settlement is fired from the tick loop without awaiting, so a slow or
   * briefly unreachable ledger leaves seats marked unsettled. This retries
   * them once the round is over and nothing is watching the clock. What it
   * cannot fix -- the ledger still down -- is left to the startup sweep, which
   * releases every hold this game still has open.
   */
  private async reconcileRound(roundId: number): Promise<void> {
    if (this.unsettled.size === 0) return;
    const pending = [...this.unsettled];
    for (const seat of pending) {
      const owed = this.db.owedFor(roundId, seat);
      if (owed === null) continue;
      try {
        await this.ledger.settle(roundId, seat, owed);
        this.unsettled.delete(seat);
      } catch (err) {
        console.error(`[thin-ice] reconcile r${roundId}s${seat} failed: ${(err as Error).message}`);
      }
    }
    for (const s of this.sessions) void this.refreshBalance(s.wallet);
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
    const row = this.rowFor(s);
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
      wallet: toSol(this.balances.get(s.wallet)?.free ?? 0),
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
