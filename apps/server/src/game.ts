import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_CONFIG,
  Round,
  canonicalConfig,
  hazardAt,
  outcomeDigest,
  rngFromSeedHex,
  roundSeedPreimage,
  totalRake,
  type Entrant,
  type GameConfig,
} from "@zinc/engine";
import { CONFIG, toLamports, toSol } from "./config.ts";
import { Database, type PlayerRow } from "./db.ts";
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
 * THE CEREMONY THIS SERVER RUNS, as a version number inside the commitment.
 *
 * A round that binds its entrant set (see `roundSeedPreimage`) and one that
 * does not are different promises, and a verifier has to be able to tell which
 * promise it is holding. Without the tag an operator could commit under the
 * strong ceremony and then ship a record shaped like the weak one -- the
 * record's own `sealNonce` would be missing, the verifier would fall back to
 * the old chain, and the downgrade would render as three green ticks. With it,
 * the fallback simply does not hash to the published commitment.
 *
 * Rounds published before this existed carry no version and verify under the
 * ceremony they were played under, which is the same rule `RoundRecord.config`
 * already applies to the rules.
 */
export const CEREMONY = 2;

/**
 * What the published hash is a hash of. The rules hash is in here alongside
 * the secret so the commitment covers the game that was actually played, not
 * just the dice it was played with.
 *
 * `secretHex` IS NOT THE SEED THE ROUND RUNS ON, and has not been since the
 * entrant set was bound into the draw. It is the half of the seed that is
 * committed to before anybody joins; the other half is drawn when the lobby
 * seals and the two are hashed together with the entrant list. See
 * `roundSeedPreimage` in the engine for why the seed cannot be known while
 * the entrant set is still being decided.
 *
 * EXPORTED SO IT CAN BE TESTED, not because anything else calls it. This
 * string is the whole ceremony: a verifier recomputes it from the revealed
 * secret and checks it against the hash published before the round sealed. It
 * used to be private, which meant the only way to cover it was to restate the
 * format in a test -- a second copy that would keep agreeing with itself long
 * after the real one moved.
 */
export function commitPreimage(roundId: number, secretHex: string, rulesHash: string): string {
  return `thinice:${CEREMONY}:${roundId}:${secretHex}:${rulesHash}`;
}

/** The rules every round is committed under, hashed over their canonical form. */
export function rulesHashOf(config: GameConfig): string {
  return sha256Hex(canonicalConfig(config));
}

/** The hash published before a round seals. Revealed secret + these rules = this. */
export function commitmentFor(roundId: number, secretHex: string, rulesHash: string): string {
  return sha256Hex(commitPreimage(roundId, secretHex, rulesHash));
}

/**
 * The seed the round actually runs on, once the lobby has sealed.
 *
 * Derived rather than drawn, so the entrant list is inside it: see
 * `roundSeedPreimage` in the engine, which is the string both this server and
 * every player's browser build. The full digest is stored and only its first
 * 128 bits reach the RNG -- `rngFromSeedHex` takes four 32-bit words -- so the
 * recorded seed is the whole hash and nothing about it is a truncation
 * somebody has to remember.
 */
export function roundSeedFrom(
  secretHex: string,
  sealNonce: string,
  entrantIds: number[],
): string {
  return sha256Hex(roundSeedPreimage(secretHex, sealNonce, entrantIds));
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
  /** The committed half of the seed, drawn at lobby open and revealed at close. */
  private secretHex = "";
  /** The other half, drawn when the lobby seals. Empty until then, on purpose. */
  private sealNonce = "";
  /** The seed the round runs on: derived from both halves plus the entrants. */
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

  /*
   * SEATS WHOSE LEDGER SETTLEMENT HAS NOT BEEN CONFIRMED, KEYED BY ROUND AND
   * SEAT BECAUSE A SEAT NUMBER ALONE IS NOT AN IDENTITY.
   *
   * `nextSeatId` restarts at 1 every lobby, so seat 3 exists in almost every
   * round and this set held only the number. Round R's seat 3 wins 8x, the
   * settle is fired and the books are briefly down, so `3` stays pending.
   * Round R+1 opens, a different player takes seat 3, dies, settles for zero,
   * and its `.then()` deleted `3` -- round R's entry, for round R+1's event.
   * `reconcileRound` did the same from the other side: `owedFor(R+1, 3)` looks
   * up by round and seat and would have answered for the wrong round entirely.
   *
   * Either way round R's winner was never paid, their hold stayed open until a
   * restart, and the startup sweep then RELEASED it -- handing back a 0.1 SOL
   * stake in place of 0.8 SOL of winnings. Keyed properly, the two entries
   * cannot touch each other.
   */
  private unsettled = new Map<string, { roundId: number; seat: number }>();

  /*
   * HOLDS THE BOOKS WOULD NOT GIVE BACK, WAITING FOR ANOTHER ASK.
   *
   * A settlement has a durable retry -- `unsettled` plus `reconcileBooks` --
   * and a release had nothing but the startup sweep, which only runs when the
   * process next restarts. That is a player who stepped off in the lobby,
   * whose local row is already deleted, watching their stake sit in escrow for
   * however long this process happens to stay up. Same shape, same retry.
   */
  private unreleased = new Map<string, { roundId: number; seat: number; why: string }>();

  /*
   * WHAT A WALLET HAS ASKED FOR RIGHT NOW, INCLUDING MONEY STILL IN FLIGHT.
   *
   * `seatsOf` is written AFTER the ledger answers, which leaves a whole
   * network round trip in which the server's honest answer to "how many plates
   * does this wallet hold" is zero. Everything that guards a wallet read that
   * number, so during the gap every guard was open at once:
   *
   *   ten `join` messages in one tick all passed the plate cap and sent ten
   *   holds, because each of them read an empty list;
   *
   *   `unjoin` found nothing to refund, answered "nothing was wrong", and the
   *   holds landed anyway -- the player pressed step off, was told it worked,
   *   and was bonded five deep in a round they had explicitly left;
   *
   *   `autoEnter` runs every 50ms and skips a wallet only once `seatsOf` has
   *   it, so a 250ms ledger -- ordinary, since the arcade's books are one
   *   SQLite IMMEDIATE transaction shared with every other game on the box --
   *   fired five auto-buys for a player who had configured one plate.
   *
   * One structure closes all three, because they are one bug. `inFlight` is
   * counted as if it were a seat, so the caps hold across the await.
   * `generation` is bumped by `unjoin`: a join that started under an older
   * generation has had its consent withdrawn while its money was moving, and
   * gives the stake straight back rather than seating somebody who left.
   * `autoBusy` is what stops auto from racing itself.
   */
  private intents = new Map<string, { inFlight: number; generation: number; autoBusy: boolean }>();

  /** Seats being paid for right now, across every wallet: the field cap's half. */
  private seatsInFlight = 0;

  /*
   * PLAYER ROWS FOR THE PASS CURRENTLY BEING BUILT, AND NO LONGER.
   *
   * `stateFor` reads a row per session and `broadcast` calls it per session,
   * so a full lattice was 250 SQLite reads every 200ms to render numbers that
   * change once a round. Set for the duration of one broadcast or one tick and
   * dropped in a `finally`: a cache that outlived the pass would be a second
   * answer to "what are this player's settings", which is exactly what
   * `rowFor` exists to prevent.
   */
  private passRows: Map<string, PlayerRow> | null = null;

  constructor(private db: Database, private ledger: ArcadeLedger) {
    this.rulesHash = rulesHashOf(this.config);
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
  private rowFor(s: Session): PlayerRow {
    const cached = this.passRows?.get(s.wallet);
    if (cached) return cached;
    const row = s.guest ? Database.spectatorRow(s.wallet) : this.db.player(s.wallet);
    this.passRows?.set(s.wallet, row);
    return row;
  }

  /** The intent record for a wallet, created on first use. */
  private intentFor(wallet: string): { inFlight: number; generation: number; autoBusy: boolean } {
    let i = this.intents.get(wallet);
    if (!i) {
      i = { inFlight: 0, generation: 0, autoBusy: false };
      this.intents.set(wallet, i);
    }
    return i;
  }

  /**
   * Plates a wallet holds THIS ROUND, counting the ones still being paid for.
   *
   * The whole point: a stake whose hold is in the air is a plate the player
   * has committed to, and every cap in this file has to see it that way or it
   * is not a cap at all -- it is a cap on how fast the ledger answers.
   */
  private platesOf(wallet: string): number {
    return (this.seatsOf.get(wallet)?.length ?? 0) + (this.intents.get(wallet)?.inFlight ?? 0);
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
   * The emergency exit for a round the loop could not finish.
   *
   * IT DOES WHAT THE STARTUP PATH DOES, AND IT USED TO DO HALF OF IT. The
   * comment here claimed it rolled a round back "exactly like the startup
   * sweep would after a crash". Startup (index.ts) does two things:
   * `db.refundOpenEntries()` AND `await ledger.sweep()`. This did only the
   * first. So on any throw inside `loop()` the local rows were stamped
   * 'refunded' with `returned = staked` while every lamport of every stake
   * stayed in arcade escrow -- the books and the game disagreeing, in writing,
   * until somebody restarted the process. From the player's side that is their
   * money reading `held` rather than `free` in every game on the box, with no
   * round anywhere behind it.
   *
   * Four things happen here now, and the round comes out of it verifiable:
   *
   *   the local entries are rolled back;
   *   the round is CLOSED as interrupted, revealing its seed, so it does not
   *     become a round that took real money and can never be proved (see
   *     db.closeInterrupted);
   *   the holds are swept, which is the half that was missing;
   *   and the in-memory round is actually cleared -- `seats` and `unsettled`
   *     stayed populated, so `viewOf` reported every player as still "in" for
   *     the whole 6.5s result phase of a round that had already died.
   *
   * The startup sweep remains the backstop for whatever cannot be reached from
   * a process that is already in trouble.
   */
  private abortRound(err: unknown): void {
    const aborted = this.roundId;
    console.error("round aborted", aborted, err);
    try {
      this.db.refundOpenEntries();
    } catch (e) {
      console.error("abort refund failed", e);
    }
    // Reveal what was committed. A round that published a commitment and ran
    // is one an operator can be asked to prove; leaving it unclosed made every
    // crash and every deploy restart mint a round outside the ceremony.
    try {
      this.closeInterrupted(aborted);
    } catch (e) {
      console.error("abort reveal failed", e);
    }
    /*
     * AND THE MONEY, WHICH IS THE HALF THIS USED TO SKIP.
     *
     * Not awaited, because this runs inside the interval callback's catch and
     * there is nothing here that can wait. Idempotent on the arcade's side, so
     * the startup sweep repeating it later costs one request.
     *
     * HOLDS FIRST, THEN THE EXPOSURE ROW, IN THAT ORDER. The arcade treats a
     * stake still sitting in `~escrow` as proof that the round is still in
     * flight -- one shared service key means the books have to stand in for
     * identity -- so the register refuses to drop this game's rows while any
     * hold is open. Releasing the room before the money would be asking in the
     * order that cannot work.
     */
    void this.ledger
      .sweep()
      .then((n) => {
        if (n > 0) console.log(`[thin-ice] abort released ${n} stranded holds`);
        for (const s of this.sessions) void this.refreshBalance(s.wallet);
      })
      .catch((e) =>
        console.error(
          `[thin-ice] ABORT COULD NOT RELEASE HOLDS for r${aborted}: ${(e as Error).message}` +
            " -- stakes stay in escrow until this process restarts",
        ),
      )
      .finally(() => void this.releaseExposure(aborted));
    try {
      this.round = null;
      this.seats.clear();
      this.seatsOf.clear();
      this.settled.clear();
      // The sweep above releases every hold this game has open -- not only
      // this round's -- so any settlement still queued is a payout against a
      // hold that no longer exists. Retrying them would ask the books to pay
      // against refs that have just been closed, forever and to no effect.
      this.unsettled.clear();
      this.winner = null;
      this.winnerWallet = null;
      this.soleOwnerWallet = null;
      this.outlastedWallet = null;
      this.phase = "result";
      this.phaseEnd = Date.now() + this.config.timing.resultMs;
      this.broadcast(true);
    } catch (e) {
      console.error("abort reset failed", e);
    }
  }

  /**
   * Close a round nobody finished, so it stays inside the ceremony.
   *
   * An interrupted round never reaches `closeRound`, so it never had a seed
   * written and `historyFor` excluded it -- which made it a round that
   * published a commitment, ran, moved real SOL, and can never be checked by
   * anybody. For a product whose fairness claim IS the commit-reveal, that is
   * the worst possible thing to leave behind, and every crash and every deploy
   * restart minted one.
   *
   * What is revealed is what is true: the secret behind the published hash,
   * the seal nonce and entrant list if the round had sealed, and the exits it
   * managed before it died. There is no outcome digest because there is no
   * outcome; the record says `interrupted` so a verifier checks the
   * commitment and reports the replay as not applicable rather than failed.
   */
  private closeInterrupted(roundId: number): void {
    const round = this.round;
    const entrantIds = round ? round.players.map((p) => p.id) : [...this.seats.keys()];
    this.db.closeInterrupted(
      roundId,
      this.secretHex,
      entrantIds.length,
      round?.currentTick ?? 0,
      JSON.stringify({
        interrupted: true,
        // Empty while the round was still in the lobby: there was no seed yet,
        // which is the point of drawing it at the seal. The commitment is
        // still checkable, and that is the whole of what such a round promised.
        seedHex: this.seedHex,
        sealNonce: this.sealNonce,
        config: this.config,
        entrantIds,
        cashOuts: round ? round.cashOutLog : [],
      }),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A CLEAN STOP CLOSES THE ROUND INSTEAD OF JUST STOPPING THE CLOCK.
   *
   * `stop()` only cancels the timer, so a deploy restart left the open round
   * exactly as a crash would: entries still 'in', stakes still in escrow, and
   * -- worst -- a published commitment with no reveal, excluded from history
   * forever. The startup sweep makes that survivable, but a shutdown we chose
   * should not need rescuing, and the reveal is the part the sweep alone
   * cannot do honestly for anybody watching.
   *
   * Synchronous, because a signal handler has no time to await anything. The
   * local half is done here; the escrow is handed back by the next boot's
   * sweep, which is the same guarantee a crash gets.
   */
  shutdown(): void {
    this.stop();
    if (this.phase === "result" && !this.round) return;
    try {
      this.db.refundOpenEntries();
      this.closeInterrupted(this.roundId);
    } catch (err) {
      console.error("shutdown could not close the open round", err);
    }
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

    // Intents for wallets with nothing in the air are last round's business.
    // Anything still in flight keeps its entry: its `generation` is what a
    // landing hold compares against, and dropping the record would tell a join
    // whose consent was withdrawn that it still had it.
    for (const [wallet, i] of this.intents) {
      if (i.inFlight === 0 && !i.autoBusy) this.intents.delete(wallet);
    }

    /*
     * COMMIT-REVEAL, RUN SERVER SIDE, IN TWO HALVES.
     *
     * The half drawn here is a SECRET, not the seed: 128 bits from the OS
     * CSPRNG whose hash is published before anybody is sealed in, and which is
     * revealed once the round is over. 128 bits and not 32, because a 32-bit
     * value makes the published commitment an oracle an attacker enumerates
     * inside the lobby -- see rngFromSeedHex.
     *
     * THE SEED ITSELF IS NOT DRAWN UNTIL THE LOBBY SEALS, and that is the fix
     * for something the commitment never covered. Elimination consumes one
     * draw per live player in join order and the hazard curve reads
     * live/total, so a seed known during the lobby makes who dies a pure
     * function of join order and entrant count -- both of which this server
     * decides, after seeing it. No grinding required; one honest seed and a
     * free choice of ordering picks the winner, and the replay still verifies
     * because the record honestly states the order that was used. There is now
     * nothing to steer with while the lobby is open. See seal().
     */
    this.secretHex = randomBytes(16).toString("hex");
    this.sealNonce = "";
    this.seedHex = "";
    this.commit = commitmentFor(this.roundId, this.secretHex, this.rulesHash);
    // The secret rides along, unpublished, so a round this process dies inside
    // can still be revealed by the process that replaces it. See db.openRound.
    this.db.openRound(this.roundId, this.commit, Date.now(), this.secretHex);

    // Anything the books refused last round, asked again now that nothing is
    // watching the clock. Lobby-time releases especially: a player who stepped
    // off has no round left to reconcile them against.
    void this.reconcileBooks();

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
   *
   * ONE OF THESE PER WALLET AT A TIME, AND THE TARGET IS CARRIED INTO THE BUY.
   *
   * Neither guard existed, and together they charged honest players five times
   * what they had configured. `autoEnter` runs off the 50ms loop and skipped a
   * wallet only once `seatsOf` had it -- which happens after the ledger
   * answers -- so a hold taking T ms fired ceil(T/50) independent auto-buys
   * before the first recorded anything, plus one more from `autoJoin` at the
   * top of the lobby. Each survived its own post-await re-check because that
   * check enforced the GLOBAL cap of five and never the caller's own target.
   * A player with auto on and one plate configured was charged 0.5 SOL a round
   * instead of 0.1, for as long as the ledger was busy, without touching
   * anything. 250ms is enough to saturate the cap, and the arcade's books are
   * one SQLite IMMEDIATE transaction shared with every game on the box.
   */
  private async autoBuy(s: Session, want: number): Promise<void> {
    const intent = this.intentFor(s.wallet);
    if (intent.autoBusy) return;
    intent.autoBusy = true;
    try {
      const target = Math.min(Math.max(1, want), CONFIG.maxPlatesPerWallet);
      // Counted with the in-flight holds, so the loop cannot lap itself either.
      while (this.platesOf(s.wallet) < target) {
        if (this.phase !== "lobby") break;
        if ((await this.join(s, target)) !== null) break;
      }
    } finally {
      intent.autoBusy = false;
    }
  }

  /**
   * A human buys a seat — or another one. Pressing bond again while already
   * standing buys an additional plate, up to the per-wallet cap. EV per plate
   * is identical however many one wallet holds (multi-study.ts measures it);
   * the cap protects the LOBBY, because the field is finite and one whale
   * filling it locks everyone else out of the round.
   */
  async join(s: Session, ceiling = CONFIG.maxPlatesPerWallet): Promise<string | null> {
    if (this.phase !== "lobby") return "the lattice is already sealed";
    /*
     * A GUEST IS TURNED AWAY HERE, NOT BY THE BOOKS.
     *
     * Guest ids are namespaced `guest:...`, the ledger has no account for one,
     * and it refuses with BAD_ACCOUNT -- correctly, and after a full HTTP round
     * trip and a write attempt against the SQLite file every other game on this
     * box shares. `{t:"guest"}` needs no signature at all, so that round trip
     * was free, unauthenticated amplification aimed at the arcade's books: a
     * wallet that never gets a seat never populates `seatsOf`, so no cap ever
     * tripped and every message bought a fresh POST. The answer has never
     * depended on anything the ledger knows, so it is given before the call.
     */
    if (s.guest) return "connect a wallet to play for real -- a guest id holds no money";
    // The caller's own ceiling as well as the global one. `autoBuy` passes the
    // plate count the player configured, and without it every concurrent
    // auto-buy re-checked only the cap of five and bought to it.
    const cap = Math.max(1, Math.min(ceiling, CONFIG.maxPlatesPerWallet));
    const intent = this.intentFor(s.wallet);
    // Read before the await, and compared after it. `unjoin` bumps this the
    // instant a player steps off, which is the only way for a hold already in
    // the air to learn that the person who authorised it has withdrawn.
    const generation = intent.generation;
    // Plates in hand PLUS plates being paid for. Counting only the first is
    // what let ten concurrent joins each see an empty list and send ten holds.
    if (this.platesOf(s.wallet) >= cap) {
      return cap < CONFIG.maxPlatesPerWallet
        ? `auto play is set to ${cap} plate${cap === 1 ? "" : "s"}`
        : `plate limit is ${CONFIG.maxPlatesPerWallet} per round`;
    }
    // The lobby cap is a game rule, not a simulation detail: the hazard curve
    // reads crowding off the field size, and every economic guarantee is
    // certified over the configured range. An uncapped lobby runs the game
    // outside the numbers that were verified. In-flight seats count here too:
    // a field that fills while stakes are moving is a field that overfills.
    if (this.seats.size + this.seatsInFlight >= this.config.field.max) return "the lattice is full";
    const stake = toLamports(this.config.entry);
    const id = this.nextSeatId++;
    /*
     * WHICH ROUND THIS STAKE IS FOR, READ BEFORE IT MOVES.
     *
     * `openLobby` resets `nextSeatId` to 1. If it ran during the hold below,
     * everything after the await would be writing into the NEW round under a
     * seat number that round may have already issued: `takeEntry` would land
     * on somebody else's row and `this.seats.set(id, ...)` would overwrite
     * their seat outright, redirecting their payout to this wallet. Only about
     * three seconds of timing margin -- held by config values in two different
     * repositories -- stood between that and a live bug.
     */
    const roundAtHold = this.roundId;
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
    intent.inFlight++;
    this.seatsInFlight++;
    /** Did the books answer with an EXISTING hold rather than a new one? */
    let replayed = false;
    try {
      const held = await this.ledger.hold(s.wallet, stake, roundAtHold, id);
      this.noteBalance(s.wallet, held);
      replayed = held.replayed;
    } catch (err) {
      if (err instanceof LedgerError && err.isBroke) return "not enough balance";
      /*
       * A GUEST HAS NO WALLET, AND THEREFORE NO MONEY.
       *
       * Guest ids are namespaced `guest:...` so they can never collide with a
       * real address -- which also means the ledger has no account for them and
       * refuses with BAD_ACCOUNT. Turned away at the top of this function now,
       * before the round trip, but the answer is kept here because the ledger
       * is the authority on what is an account and the generic message below
       * would blame the books for somebody simply not having signed in.
       */
      if (err instanceof LedgerError && err.code === "BAD_ACCOUNT") {
        return "connect a wallet to play for real -- a guest id holds no money";
      }
      const why = err instanceof LedgerError ? err.code : "unknown";
      console.error(`[thin-ice] hold failed for ${s.wallet} r${roundAtHold}s${id}: ${why}`);
      /*
       * A REF THAT ALREADY MEANS SOMETHING IS NOT OURS TO CLEAN UP.
       *
       * The arcade refuses a ref that is taken (REF_CONFLICT) or no longer
       * open (HOLD_CLOSED) rather than quietly answering yes. Both say the
       * same thing: a stake exists under this round and seat number and this
       * join did not create it. Release is idempotent, so "tidying up" here
       * would hand back a stranger's live stake in the middle of their round.
       * Refuse, say so, and let the seat id move on -- the same reasoning as
       * the replayed-hold branch below.
       */
      if (err instanceof LedgerError && (err.code === "REF_CONFLICT" || err.code === "HOLD_CLOSED")) {
        return "that plate could not be issued -- nothing was staked";
      }
      /*
       * "YOUR MONEY HAS NOT BEEN TOUCHED" IS A CLAIM THIS CODE CANNOT MAKE.
       *
       * A LedgerError arrives from the client side of the call. The common one
       * is a timeout, and `AbortSignal.timeout(5000)` aborts US -- if the
       * request arrived and only the response was lost, the hold exists, under
       * this exact ref, and the stake is in escrow. Saying otherwise is the
       * one sentence a player would act on: they see the balance move, are
       * told it did not, and file a support ticket about a bug that is only in
       * the message. So the release is attempted -- idempotent, and free if
       * there was never a hold to release -- and the wording says what is
       * actually known.
       */
      void this.releaseSeat(roundAtHold, id, "hold failed or its answer was lost");
      return "the books did not answer -- if the stake moved it is being returned";
    } finally {
      intent.inFlight--;
      this.seatsInFlight--;
    }

    /*
     * A REPLAYED HOLD IS NOT A HOLD THIS JOIN MADE, AND MUST NOT BUY A SEAT.
     *
     * Refs are idempotent by design -- `thin-ice:r{R}:s{N}` asked for twice
     * returns the first answer instead of moving money again -- which is what
     * makes retries and crash replays safe. It also means a 200 does not by
     * itself mean "this stake just moved". If this round and seat number have
     * ever been used before, the answer is somebody else's escrowed stake and
     * seating on it sells a plate nobody paid for.
     *
     * NOTHING IS RELEASED HERE. The hold that came back belongs to whatever
     * made it, and release is idempotent: giving it back would return a
     * stranger's live stake in the middle of their round. Fail closed, loudly,
     * and let the seat id move on.
     */
    if (replayed) {
      console.error(
        `[thin-ice] REPLAYED HOLD r${roundAtHold}s${id} for ${s.wallet}: a seat id has been` +
          " re-issued, so this join is refused and the existing hold left alone",
      );
      return "that plate could not be issued -- nothing was staked";
    }

    /*
     * EVERY GUARD AT THE TOP OF THIS FUNCTION IS ASKED AGAIN, BECAUSE THE
     * AWAIT ABOVE THREW THE FIRST ANSWERS AWAY.
     *
     * `index.ts` dispatches with `void handle(msg)` and the rate limit is a
     * burst budget rather than a lock, so two bond presses in one tick both
     * enter this function. Before this block they both read the caps, both
     * awaited the hold, and both wrote -- and the write at the bottom used
     * `mine`, a snapshot taken BEFORE the await, so the second `set` landed on
     * top of the first and one seat id vanished from `seatsOf`.
     *
     * That is not a cap being loose, it is a plate the player cannot reach.
     * `unjoin` and `cashOut` both walk `seatsOf`, so an orphaned seat cannot be
     * refunded in the lobby and cannot be banked during the round -- it rides
     * to whatever the ice does to it, having been paid for. Measured before the
     * fix: two presses, two holds, two seats, one id in `seatsOf`.
     *
     * CURSORS solved this first and this is its shape. `commitDeploy` re-runs
     * the whole of `checkDeploy` after the hold returns and hands the money
     * back if it now fails; see server/sim.js. Everything from here to the end
     * of this function is synchronous, so the re-check and the write cannot be
     * split by another join the way the original pair was.
     */
    const mineNow = this.seatsOf.get(s.wallet) ?? [];
    const stale =
      /*
       * THE ROUND, ASKED FIRST, BECAUSE EVERY OTHER ANSWER IS ABOUT THE WRONG
       * ONE IF IT MOVED. Seat numbers restart at 1 every lobby, so a stake
       * held for round R and written into round R+1 lands on a seat id that
       * round has already sold -- overwriting a stranger's seat and their
       * payout with it.
       */
      this.roundId !== roundAtHold
        ? "that round sealed while the stake was moving"
        : /*
           * AND CONSENT, WHICH THE PLAYER IS ALLOWED TO WITHDRAW MID-FLIGHT.
           *
           * `unjoin` bumps the generation the moment step-off arrives. Before
           * this, a step-off during the hold found `seatsOf` still empty,
           * returned null -- which index.ts reports as success -- and the holds
           * landed afterwards: the player was told nothing was wrong and was
           * bonded anyway, up to five deep, in a round they had explicitly
           * left. Timed at the last second of the lobby they were then sealed
           * into it.
           */
          intent.generation !== generation
          ? "stepped off while the stake was moving -- nothing was staked"
          : this.phase !== "lobby"
            ? "the lattice is already sealed"
            : // The caller's own ceiling as well as the global cap: this is the
              // check that used to let concurrent auto-buys reach five plates
              // for a player who had asked for one.
              mineNow.length >= cap
              ? cap < CONFIG.maxPlatesPerWallet
                ? `auto play is set to ${cap} plate${cap === 1 ? "" : "s"}`
                : `plate limit is ${CONFIG.maxPlatesPerWallet} per round`
              : this.seats.size >= this.config.field.max
                ? "the lattice is full"
                : null;
    if (stale) {
      void this.releaseSeat(roundAtHold, id, "the lattice changed while the stake was moving");
      return stale;
    }

    /*
     * And only then the local record. If THIS throws the money is already held
     * with no seat to show for it -- so it is given straight back, and the
     * player is told nothing happened. The release is idempotent, so a second
     * attempt during the startup sweep is free.
     */
    try {
      this.db.takeEntry(roundAtHold, s.wallet, stake, id);
    } catch (err) {
      void this.releaseSeat(roundAtHold, id, "seat could not be recorded");
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
    // `mineNow`, never `mine`: the list read before the await is the whole bug.
    this.seatsOf.set(s.wallet, [...mineNow, id]);
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

    /*
     * CONSENT IS WITHDRAWN FIRST, SYNCHRONOUSLY, BEFORE ANYTHING IS READ.
     *
     * A wallet's seats are recorded only after the ledger answers, so a player
     * who pressed bond and then step-off inside one round trip had an empty
     * `seatsOf` here -- this returned null, index.ts read that as success and
     * said nothing, and the holds landed a moment later. They were told
     * stepping off worked and were bonded up to five plates deep in a round
     * they had explicitly left; timed at the end of the lobby, sealed into it.
     *
     * The generation bump is what a landing hold checks. It has to happen
     * before the first `await` in this function and before the early return
     * below, because both of those are places the old version gave up.
     */
    const intent = this.intentFor(s.wallet);
    intent.generation++;

    /*
     * AND AUTO GOES OFF EVEN WHEN THERE IS NOTHING TO REFUND YET.
     *
     * Stepping off IS the statement that you are done. It used to be the last
     * thing this function did, so the early return above skipped it entirely
     * and auto play stayed on in the database while the client had already
     * shown it off -- the next lobby tick then bought the seat straight back.
     */
    const row = this.rowFor(s);
    if (row.autoEnabled) {
      this.db.setAuto(s.wallet, false, row.autoTarget, row.autoPlates ?? 1);
    }

    const mine = this.seatsOf.get(s.wallet);
    if (!mine || mine.length === 0) {
      // Nothing bought yet, but a hold may be in the air; the generation bump
      // above is what turns it back. The screen still needs the auto switch.
      this.broadcast(true);
      return null;
    }

    /*
     * DECIDE AND MUTATE FIRST, WITH NO AWAIT ANYWHERE IN IT. THEN MOVE MONEY.
     *
     * This loop used to await the ledger release for every plate, in the middle
     * of deciding. `seal()` is fully synchronous and fires off a timer, so it
     * lands between two of those awaits whenever a countdown expires while a
     * release is in the air -- and the loop carried on refunding against a
     * round that was already live. `refundLobbyEntry` still found the row, the
     * stake still went back, and the seat was ALREADY an entrant.
     *
     * That is a solvency leak rather than an accounting oddity, because the
     * prize is sized off the entrant count:
     *
     *     grossHandle = entrants.length * config.entry
     *     pot         = grossHandle * (1 - rake)
     *
     * so a seat sealed in and then refunded inflates the pot by one entry the
     * house does not hold. The phantom's balance redistributes to whoever
     * survives and `~house` pays the difference. Measured before this change:
     * three seats, one wallet steps off as the lobby seals, and the round pays
     * a pot sized on two entries with one stake behind it -- 0.1 SOL of prize
     * nobody put in.
     *
     * Splitting it in two closes the window rather than narrowing it. There is
     * no await between reading the phase and finishing every mutation, so
     * `seal()` cannot run inside the decision at all -- and neither can a
     * concurrent `join`, which is what used to make the blanket
     * `seatsOf.delete` below wipe a plate bought while this was awaiting.
     */
    const refunded: number[] = [];
    for (const id of mine) {
      if (this.db.refundLobbyEntry(this.roundId, s.wallet, id)) {
        this.seats.delete(id);
        refunded.push(id);
      }
    }

    // Exactly what was refunded, never the whole wallet: anything bought while
    // this was running is somebody's live plate and is not ours to forget.
    const left = (this.seatsOf.get(s.wallet) ?? []).filter((id) => !refunded.includes(id));
    if (left.length > 0) this.seatsOf.set(s.wallet, left);
    else this.seatsOf.delete(s.wallet);

    // And only now the books. The stake goes back; idempotent, so the startup
    // sweep finding the same hold later is free rather than a double refund.
    // A refusal is queued and asked again -- see releaseSeat.
    const round = this.roundId;
    for (const id of refunded) {
      await this.releaseSeat(round, id, "stepped off before the seal");
    }
    void this.refreshBalance(s.wallet);
    this.broadcast(true);
    return null;
  }

  /**
   * Hand one seat's stake back, and keep asking until the books take it.
   *
   * Settlement has had a durable retry for a long time -- `unsettled` plus
   * `reconcileBooks` -- and release had nothing but the startup sweep. That is
   * not symmetric: by the time this is called the local entry row is already
   * deleted, so a refusal leaves a player's stake sitting in escrow with
   * nothing in this game still pointing at it, and the only thing that would
   * ever free it is somebody restarting the process. Same failure, same retry.
   *
   * Awaitable, but every caller on a hot path fires it without waiting: the
   * queue is what makes that safe.
   */
  private async releaseSeat(roundId: number, seat: number, why: string): Promise<void> {
    const key = `r${roundId}:s${seat}`;
    try {
      await this.ledger.release(roundId, seat, why);
      this.unreleased.delete(key);
    } catch (err) {
      this.unreleased.set(key, { roundId, seat, why });
      // Logged rather than shown: from the player's side stepping off did work,
      // and the retry is already booked.
      console.error(`[thin-ice] release failed r${roundId}s${seat}, queued: ${(err as Error).message}`);
    }
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
    /*
     * THE GRACE LOCK IS A RULE, SO THE SERVER HOLDS IT.
     *
     * The HUD hides the extract button for the opening grace ticks: the same
     * button was "bond another" half a second earlier, and a player still
     * hammering it would bank 0.98x -- less than the entry they had just paid.
     * Nothing can shatter during grace, so the lock costs them nothing.
     *
     * It was ONLY the HUD, which makes it a suggestion. A scripted client sent
     * `cashout` on tick 0 and extracted below its own stake. Their money and
     * their bad trade, but a rule the server does not own is not a rule -- and
     * this one is inside the rules hash every round is committed under. The
     * same tick boundary the client draws: it unlocks once the round has
     * walked past the grace ticks. Server-side auto exits and the sole-owner
     * ending are settlements rather than player extractions, and are
     * deliberately not gated here.
     */
    if (round.currentTick < this.config.hazard.graceTicks) return;
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
    // Captured, never re-read: everything below can outlive the round it
    // belongs to, and `this.roundId` will have moved on by the time a slow
    // settle answers.
    const roundId = this.roundId;
    this.db.settleEntry(
      roundId,
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
     * It is safe to fire because the ref makes it exactly-once: `reconcileBooks`
     * retries every seat that has not confirmed when the round closes, and the
     * startup sweep catches anything after a crash. The worst case is that a
     * payout lands a moment late in the books, never that it lands twice or not
     * at all.
     *
     * ROUND AND SEAT, NOT SEAT. The pending set was keyed by the bare seat
     * number, which is re-issued from 1 every lobby -- so a settle landing for
     * round R+1's seat 3 deleted round R's still-pending seat 3 and its winner
     * was never paid. See the field's own comment.
     */
    const key = `r${roundId}:s${seat}`;
    this.unsettled.set(key, { roundId, seat });
    void this.ledger
      .settle(roundId, seat, lamports)
      .then(() => {
        this.unsettled.delete(key);
        void this.refreshBalance(wallet);
      })
      .catch((err) => {
        console.error(`[thin-ice] settle deferred r${roundId}s${seat}: ${(err as Error).message}`);
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

    /*
     * AND ONLY NOW IS THERE A SEED, WHICH IS THE POINT.
     *
     * The nonce is drawn here, after the entrant list above is final and
     * before a single roll, and the seed is the hash of it with the committed
     * secret and that list. Three consequences, in the order they matter:
     *
     *   nobody held a seed while the lobby was open, so join order and entrant
     *   count could not be chosen against one;
     *
     *   the entrant list is INSIDE the seed, so the order the record claims is
     *   the order the round was played in -- change, add, drop or swap one id
     *   and the replay stops matching the published outcome;
     *
     *   and the lobby's commitment is untouched, so the client still pins the
     *   hash it saw on screen before it was sealed in.
     *
     * What remains is an operator willing to redraw this nonce until it likes
     * the simulated result -- seed grinding, which is one open box on
     * MAINNET.md and is closed by entropy the house does not choose. The point
     * of this change is that grinding is now the ONLY way in; before it, one
     * honest seed and a free choice of ordering was enough.
     */
    this.sealNonce = randomBytes(16).toString("hex");
    this.seedHex = roundSeedFrom(
      this.secretHex,
      this.sealNonce,
      entrants.map((e) => e.id),
    );
    this.db.sealRound(this.roundId, this.sealNonce);
    this.round = new Round(this.config, rngFromSeedHex(this.seedHex), entrants);
    this.phase = "live";
    this.nextTickAt = Date.now() + this.config.timing.tickMs;

    void this.reserveExposure(this.roundId, this.round.pot);
    this.broadcast(true);
  }

  /*
   * ── THE BOX-WIDE EXPOSURE REGISTER ─────────────────────────────────────
   *
   * WHAT THIS TABLE COULD COST THE HOUSE, WHICH IS NORMALLY NOTHING.
   *
   * Thin Ice is self-funding: the pot is the entrants' own stakes less rake,
   * every payout is settled against the hold that funded it, and the house
   * nets the rake. So this game never appeared in the arcade's exposure
   * register at all, and for the ordinary round that is honest.
   *
   * It stops being honest on the recovery paths. If holds are released while
   * a payout has already been made -- a crash after a big extraction, a deploy
   * restart timed the same way -- `ledger.settle` funds the difference from
   * `~house` with `overdraft: true`, and nothing caps it. The worst case is
   * one seat banking the whole pot while every other stake goes back: pot
   * minus that seat's own entry. That is the number reserved.
   *
   * NOT FAIL-CLOSED, AND THIS IS THE ONE PLACE IN THIS FILE WHERE THAT IS
   * RIGHT. A stake refused because the books are unreachable costs a player
   * one join. A round refused because a BACKSTOP is unreachable costs every
   * player at a table whose payouts are already fully funded by stakes the
   * arcade is holding. So the reservation is fired, loudly logged when it
   * fails, and the register is dropped for the life of the process if the
   * arcade turns out not to have the route at all -- the same bargain Thin
   * Line makes, for the same reason: this client and the register's routes
   * deploy from repositories that are pulled separately.
   */
  private async reserveExposure(roundId: number, pot: number): Promise<void> {
    const worst = Math.max(0, toLamports(pot) - toLamports(this.config.entry));
    if (worst === 0) return;
    try {
      await this.ledger.exposure.reserve(roundId, worst);
    } catch (err) {
      const e = err as LedgerError;
      if (e.status === 404) {
        console.warn(
          "[thin-ice] this arcade has no exposure register, so this table is not in the" +
            " box-wide total. Update the arcade and restart to join it.",
        );
        return;
      }
      console.error(`[thin-ice] exposure not reserved for r${roundId}: ${e.message}`);
    }
  }

  /** Give the room back. Idempotent on the arcade's side; never fatal here. */
  private async releaseExposure(roundId: number): Promise<void> {
    try {
      await this.ledger.exposure.release(roundId);
    } catch (err) {
      console.error(
        `[thin-ice] the arcade still thinks r${roundId} is in flight: ${(err as Error).message}`,
      );
    }
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
      if (s.guest) continue;
      // Any plate means auto already ran (or the player bought by hand); auto
      // never tops up a position the player chose themselves. PLATES, not
      // seats: a stake still moving is a plate, and this test reading only
      // `seatsOf` is what let a 50ms loop fire five auto-buys into one ledger
      // round trip. `autoBusy` is the same guard for the loop inside autoBuy.
      if (this.platesOf(s.wallet) > 0 || this.intents.get(s.wallet)?.autoBusy) continue;
      const row = this.rowFor(s);
      if (row.autoEnabled) void this.autoBuy(s, row.autoPlates ?? 1).catch(() => {});
    }
  }

  private tick(): void {
    const round = this.round;
    if (!round) return;
    // One read per WALLET for this tick, not one per seat. The auto sweep
    // below asks for a player row per seat, so a full lattice at two ticks a
    // second was 500 SQLite reads a second to check settings that change once
    // in a session -- and a five-plate wallet was read five times over.
    const rows = new Map<string, PlayerRow>();
    const rowOf = (wallet: string): PlayerRow => {
      let r = rows.get(wallet);
      if (!r) {
        r = this.db.player(wallet);
        rows.set(wallet, r);
      }
      return r;
    };
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
      const row = rowOf(seat.wallet);
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
      // THE REVEAL IS THE SECRET, not the seed the round ran on. It is what
      // hashes to the commitment published during the lobby; the seed is
      // derived from it and is inside the record below, where the replay
      // rebuilds it from the entrant list and checks the two agree.
      this.secretHex,
      res.players.length,
      res.ticks,
      best,
      champSeat?.wallet ?? null,
      champSeat?.charId ?? null,
      toLamports(res.pot),
      JSON.stringify({
        seedHex: this.seedHex,
        sealNonce: this.sealNonce,
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
    void this.reconcileBooks();
    // The round is over, so the room it was holding in the box-wide register
    // is room nobody needs. Told unconditionally, exactly like Thin Line's
    // settle path: a table that keeps its reservation after the round ends
    // shrinks every other table's headroom for nothing.
    void this.releaseExposure(this.roundId);
  }

  /**
   * Make the books agree with this game, for every round still owed anything.
   *
   * Settlement is fired from the tick loop without awaiting, so a slow or
   * briefly unreachable ledger leaves seats marked unsettled; releases are
   * fired the same way from the lobby. This retries both once a round is over
   * and nothing is watching the clock, and again at the top of every lobby.
   *
   * IT IS NOT LIMITED TO ONE ROUND, AND THAT IS THE FIX. The old version took
   * a round id, retried only what was pending for it, and left everything else
   * behind forever -- so a payout the books refused during round R had exactly
   * one attempt at the end of round R and then waited for a restart, at which
   * point the sweep RELEASED the hold and paid the winner their stake back
   * instead of their winnings. Every pending entry now carries the round it
   * belongs to, so all of them can be asked again.
   *
   * What this still cannot fix -- the ledger down for the life of the process
   * -- is left to the startup sweep.
   */
  private async reconcileBooks(): Promise<void> {
    if (this.unsettled.size === 0 && this.unreleased.size === 0) return;
    for (const [key, { roundId, seat }] of [...this.unsettled]) {
      const owed = this.db.owedFor(roundId, seat);
      if (owed === null) continue;
      try {
        await this.ledger.settle(roundId, seat, owed);
        this.unsettled.delete(key);
      } catch (err) {
        console.error(`[thin-ice] reconcile r${roundId}s${seat} failed: ${(err as Error).message}`);
      }
    }
    for (const [key, { roundId, seat, why }] of [...this.unreleased]) {
      try {
        await this.ledger.release(roundId, seat, why);
        this.unreleased.delete(key);
      } catch (err) {
        console.error(`[thin-ice] re-release r${roundId}s${seat} failed: ${(err as Error).message}`);
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
    // One player row per WALLET for this pass. Two tabs are two sessions and
    // were two identical reads; a full lattice was 250 of them every 200ms.
    // Dropped in the `finally`, so nothing outside this pass can ever read a
    // row this pass cached -- see `passRows`.
    this.passRows = new Map();
    try {
      for (const s of this.sessions) s.send(this.stateFor(s));
    } finally {
      this.passRows = null;
    }
  }
}
