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

export { CHARS } from "./config.ts";

export function shortAddress(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export const CEREMONY = 2;

export function commitPreimage(roundId: number, secretHex: string, rulesHash: string): string {
  return `thinice:${CEREMONY}:${roundId}:${secretHex}:${rulesHash}`;
}

export function rulesHashOf(config: GameConfig): string {
  return sha256Hex(canonicalConfig(config));
}

export function commitmentFor(roundId: number, secretHex: string, rulesHash: string): string {
  return sha256Hex(commitPreimage(roundId, secretHex, rulesHash));
}

export function roundSeedFrom(
  secretHex: string,
  sealNonce: string,
  entrantIds: number[],
): string {
  return sha256Hex(roundSeedPreimage(secretHex, sealNonce, entrantIds));
}

interface Seat {
  id: number;
  wallet: string;
  name: string;
  charId: string;
  lifetime: NonNullable<NetPlayer["lifetime"]>;
}

export interface Session {
  wallet: string;
  spectator: boolean;
  session: number;
  send(state: NetState): void;
  sendHistory(h: NetHistory[]): void;
  sendChat(msgs: NetChat[]): void;
}

export class GameServer {
  private config: GameConfig = DEFAULT_CONFIG;
  private phase: "lobby" | "live" | "result" = "lobby";
  private roundId: number;
  private round: Round | null = null;
  private phaseEnd = 0;
  private nextTickAt = 0;
  private timer: NodeJS.Timeout | null = null;

  private seats = new Map<number, Seat>();
  private seatsOf = new Map<string, number[]>();
  private settled = new Set<number>();
  private nextSeatId = 1;

  private sessions = new Set<Session>();
  private secretHex = "";
  private sealNonce = "";
  private seedHex = "";
  private commit = "";
  private readonly rulesHash: string;
  private winner: NetState["winner"] = null;
  private winnerWallet: string | null = null;
  private soleOwnerWallet: string | null = null;
  private outlastedWallet: string | null = null;
  private lastBroadcast = 0;
  private teamWins: Record<string, number>;

  private chatLog: Array<NetChat & { wallet: string }> = [];
  private nextChatId = 1;

  private balances = new Map<string, { free: number; held: number }>();

  private unsettled = new Map<string, { roundId: number; seat: number }>();

  private unreleased = new Map<string, { roundId: number; seat: number; why: string }>();

  private intents = new Map<string, { inFlight: number; generation: number; autoBusy: boolean }>();

  private seatsInFlight = 0;

  private passRows: Map<string, PlayerRow> | null = null;

  constructor(private db: Database, private ledger: ArcadeLedger) {
    this.rulesHash = rulesHashOf(this.config);
    this.roundId = db.lastRoundId();
    this.teamWins = db.teamWins();
  }

  private rowFor(s: Session): PlayerRow {
    const cached = this.passRows?.get(s.wallet);
    if (cached) return cached;
    const row = s.spectator ? Database.spectatorRow(s.wallet) : this.db.player(s.wallet);
    this.passRows?.set(s.wallet, row);
    return row;
  }

  private intentFor(wallet: string): { inFlight: number; generation: number; autoBusy: boolean } {
    let i = this.intents.get(wallet);
    if (!i) {
      i = { inFlight: 0, generation: 0, autoBusy: false };
      this.intents.set(wallet, i);
    }
    return i;
  }

  private platesOf(wallet: string): number {
    return (this.seatsOf.get(wallet)?.length ?? 0) + (this.intents.get(wallet)?.inFlight ?? 0);
  }

  private noteBalance(wallet: string, b: { freeLamports: number; heldLamports: number }): void {
    this.balances.set(wallet, { free: b.freeLamports, held: b.heldLamports });
  }

  private async refreshBalance(wallet: string): Promise<void> {
    try {
      this.noteBalance(wallet, await this.ledger.balanceOf(wallet));
      for (const s of this.sessions) if (s.wallet === wallet) s.send(this.stateFor(s));
    } catch {
    }
  }

  start(): void {
    if (this.timer) return;
    this.openLobby();
    this.timer = setInterval(() => {
      try {
        this.loop();
      } catch (err) {
        this.abortRound(err);
      }
    }, 50);
  }

  private abortRound(err: unknown): void {
    const aborted = this.roundId;
    console.error("round aborted", aborted, err);
    try {
      this.db.refundOpenEntries();
    } catch (e) {
      console.error("abort refund failed", e);
    }
    try {
      this.closeInterrupted(aborted);
    } catch (e) {
      console.error("abort reveal failed", e);
    }
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
    if (!s.spectator) void this.refreshBalance(s.wallet);
    this.pushHistory(s);
    if (this.chatLog.length > 0) {
      s.sendChat(this.chatLog.map((m) => this.chatView(m, s.wallet)));
    }
    s.send(this.stateFor(s));
  }

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

  private chatView(m: NetChat & { wallet: string }, wallet: string): NetChat {
    const { wallet: w, ...pub } = m;
    return { ...pub, you: w === wallet };
  }

  refresh(s: Session): void {
    if (!this.sessions.has(s)) return;
    void this.refreshBalance(s.wallet);
  }

  detach(s: Session): void {
    this.sessions.delete(s);
  }

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

    for (const [wallet, i] of this.intents) {
      if (i.inFlight === 0 && !i.autoBusy) this.intents.delete(wallet);
    }

    this.secretHex = randomBytes(16).toString("hex");
    this.sealNonce = "";
    this.seedHex = "";
    this.commit = commitmentFor(this.roundId, this.secretHex, this.rulesHash);
    this.db.openRound(this.roundId, this.commit, Date.now(), this.secretHex);

    void this.reconcileBooks();

    this.autoJoin();
    this.broadcast(true);
  }

  private onlineWallets(): number {
    const seen = new Set<string>();
    for (const s of this.sessions) seen.add(s.wallet);
    return seen.size;
  }

  private uniqueSessions(): Session[] {
    const byWallet = new Map<string, Session>();
    for (const s of this.sessions) if (!byWallet.has(s.wallet)) byWallet.set(s.wallet, s);
    return [...byWallet.values()];
  }

  private autoJoin(): void {
    for (const s of this.uniqueSessions()) {
      if (s.spectator) continue;
      const row = this.rowFor(s);
      if (row.autoEnabled) void this.autoBuy(s, row.autoPlates ?? 1).catch(() => {});
    }
  }

  private async autoBuy(s: Session, want: number): Promise<void> {
    const intent = this.intentFor(s.wallet);
    if (intent.autoBusy) return;
    intent.autoBusy = true;
    try {
      const target = Math.min(Math.max(1, want), CONFIG.maxPlatesPerWallet);
      while (this.platesOf(s.wallet) < target) {
        if (this.phase !== "lobby") break;
        if ((await this.join(s, target)) !== null) break;
      }
    } finally {
      intent.autoBusy = false;
    }
  }

  async join(s: Session, ceiling = CONFIG.maxPlatesPerWallet): Promise<string | null> {
    if (this.phase !== "lobby") return "the lattice is already sealed";
    if (s.spectator) return "connect a wallet to play for real -- a spectator seat holds no money";
    const cap = Math.max(1, Math.min(ceiling, CONFIG.maxPlatesPerWallet));
    const intent = this.intentFor(s.wallet);
    const generation = intent.generation;
    if (this.platesOf(s.wallet) >= cap) {
      return cap < CONFIG.maxPlatesPerWallet
        ? `auto play is set to ${cap} plate${cap === 1 ? "" : "s"}`
        : `plate limit is ${CONFIG.maxPlatesPerWallet} per round`;
    }
    if (this.seats.size + this.seatsInFlight >= this.config.field.max) return "the lattice is full";
    const stake = toLamports(this.config.entry);
    const id = this.nextSeatId++;
    const roundAtHold = this.roundId;
    const row = this.rowFor(s);

    intent.inFlight++;
    this.seatsInFlight++;
    let replayed = false;
    try {
      const held = await this.ledger.hold(s.wallet, stake, roundAtHold, id);
      this.noteBalance(s.wallet, held);
      replayed = held.replayed;
    } catch (err) {
      if (err instanceof LedgerError && err.isBroke) return "not enough balance";
      if (err instanceof LedgerError && err.code === "BAD_ACCOUNT") {
        return "connect a wallet to play for real -- a spectator seat holds no money";
      }
      const why = err instanceof LedgerError ? err.code : "unknown";
      console.error(`[thin-ice] hold failed for ${s.wallet} r${roundAtHold}s${id}: ${why}`);
      if (err instanceof LedgerError && (err.code === "REF_CONFLICT" || err.code === "HOLD_CLOSED")) {
        return "that plate could not be issued -- nothing was staked";
      }
      void this.releaseSeat(roundAtHold, id, "hold failed or its answer was lost");
      return "the books did not answer -- if the stake moved it is being returned";
    } finally {
      intent.inFlight--;
      this.seatsInFlight--;
    }

    if (replayed) {
      console.error(
        `[thin-ice] REPLAYED HOLD r${roundAtHold}s${id} for ${s.wallet}: a seat id has been` +
          " re-issued, so this join is refused and the existing hold left alone",
      );
      return "that plate could not be issued -- nothing was staked";
    }

    const mineNow = this.seatsOf.get(s.wallet) ?? [];
    const stale =
      this.roundId !== roundAtHold
        ? "that round sealed while the stake was moving"
        :
          intent.generation !== generation
          ? "stepped off while the stake was moving -- nothing was staked"
          : this.phase !== "lobby"
            ? "the lattice is already sealed"
            :
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
        net: toSol(row.returned - row.wagered),
        hitRate: row.roundsPlayed > 0 ? row.roundsWon / row.roundsPlayed : 0,
        best: row.bestMultiple,
      },
    });
    this.seatsOf.set(s.wallet, [...mineNow, id]);
    this.broadcast(true);
    return null;
  }

  async unjoin(s: Session): Promise<string | null> {
    if (this.phase !== "lobby") return "the lattice is already sealed";

    const intent = this.intentFor(s.wallet);
    intent.generation++;

    const row = this.rowFor(s);
    if (row.autoEnabled) {
      this.db.setAuto(s.wallet, false, row.autoTarget, row.autoPlates ?? 1);
    }

    const mine = this.seatsOf.get(s.wallet);
    if (!mine || mine.length === 0) {
      this.broadcast(true);
      return null;
    }

    const refunded: number[] = [];
    for (const id of mine) {
      if (this.db.refundLobbyEntry(this.roundId, s.wallet, id)) {
        this.seats.delete(id);
        refunded.push(id);
      }
    }

    const left = (this.seatsOf.get(s.wallet) ?? []).filter((id) => !refunded.includes(id));
    if (left.length > 0) this.seatsOf.set(s.wallet, left);
    else this.seatsOf.delete(s.wallet);

    const round = this.roundId;
    for (const id of refunded) {
      await this.releaseSeat(round, id, "stepped off before the seal");
    }
    void this.refreshBalance(s.wallet);
    this.broadcast(true);
    return null;
  }

  private async releaseSeat(roundId: number, seat: number, why: string): Promise<void> {
    const key = `r${roundId}:s${seat}`;
    try {
      await this.ledger.release(roundId, seat, why);
      this.unreleased.delete(key);
    } catch (err) {
      this.unreleased.set(key, { roundId, seat, why });
      console.error(`[thin-ice] release failed r${roundId}s${seat}, queued: ${(err as Error).message}`);
    }
  }

  cashOut(s: Session): void {
    const round = this.round;
    const mine = this.seatsOf.get(s.wallet);
    if (!round || !mine || this.phase !== "live") return;
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
    if (!round.finished) this.bankSoleOwner();
    if (round.finished) this.finish();
    else this.broadcast(true);
  }

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
    const entrants: Entrant[] = [];
    for (const seat of this.seats.values()) {
      entrants.push({
        id: seat.id,
        strategyId: "human",
        strategy: () => false,
      });
    }
    this.settled.clear();

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
        if (this.seatsOf.size >= CONFIG.minEntrants) this.seal();
        else this.phaseEnd = now + this.config.timing.lobbyMs;
      }
    } else if (this.phase === "live") {
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

  private autoEnter(): void {
    for (const s of this.uniqueSessions()) {
      if (s.spectator) continue;
      if (this.platesOf(s.wallet) > 0 || this.intents.get(s.wallet)?.autoBusy) continue;
      const row = this.rowFor(s);
      if (row.autoEnabled) void this.autoBuy(s, row.autoPlates ?? 1).catch(() => {});
    }
  }

  private tick(): void {
    const round = this.round;
    if (!round) return;
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

    for (const p of round.players) {
      if (p.outcome === "dead" && !this.settled.has(p.id)) {
        this.settled.add(p.id);
        const seat = this.seats.get(p.id);
        if (seat) this.settleExit(seat.wallet, p.id, 0, p.ticksSurvived, "dead");
      }
    }

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

    if (!round.finished) this.bankSoleOwner();

    if (round.finished) this.finish();
  }

  private finish(): void {
    const round = this.round;
    if (!round) return;
    const res = round.result();
    const now = Date.now();

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
    const cashed = res.players.filter((p) => p.outcome === "cashed");

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

    const lastStanding =
      champ !== undefined &&
      champSeat !== undefined &&
      (champ.lastStanding === true ||
        (this.soleOwnerWallet !== null && champSeat.wallet === this.soleOwnerWallet) ||
        (this.outlastedWallet !== null && champSeat.wallet === this.outlastedWallet));

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

    void this.reconcileBooks();
    void this.releaseExposure(this.roundId);
  }

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

  private pushHistory(s: Session): void {
    const rows = this.db.historyFor(s.wallet, 40);
    s.sendHistory(
      rows.map((r) => ({
        roundId: r.roundId,
        entrants: r.entrants,
        ticks: r.ticks,
        bestMultiple: r.bestMult,
        yourOutcome: r.anyBanked > 0 ? "cashed" : "dead",
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

  private broadcast(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastBroadcast < 200) return;
    this.lastBroadcast = now;
    this.passRows = new Map();
    try {
      for (const s of this.sessions) s.send(this.stateFor(s));
    } finally {
      this.passRows = null;
    }
  }
}
