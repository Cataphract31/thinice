import type { GameConfig, HazardConfig } from "./config.js";
import { totalRake } from "./config.js";
import type { Rng } from "./rng.js";

export type PlayerOutcome = "in" | "cashed" | "dead";

export interface Player {
  id: number;
  /** Tag used by the simulator to attribute results. Ignored in live play. */
  strategyId: string;
  outcome: PlayerOutcome;
  balance: number;
  /** Amount banked on walking out, or the whole balance if last standing. */
  cashedOut: number;
  bonanzaTickets: number;
  ticksSurvived: number;
  /**
   * True only for a sole survivor auto-banked by the engine. A voluntary
   * cash-out on the final tick also has ticksSurvived === round ticks, so this
   * flag is the only reliable way to tell the two apart.
   */
  lastStanding: boolean;
}

/**
 * The hazard curve, as a pure function.
 *
 * This is THE probability of the game and it must exist exactly once: the
 * round consults it per tick, the client displays the rate the *next* tick
 * will roll at, and the pacing diagnostics sweep it. Two of those had
 * hand-copied versions — one had already drifted (it omitted thin-field
 * relief) and was certifying a curve the engine no longer runs.
 */
export function hazardAt(h: HazardConfig, tick: number, live: number, total: number): number {
  const heat = live / total;
  // Thin-field relief. Crowding is a *fraction*, so three players in a
  // three-player shaft are as dangerous as thirty in thirty — but that round
  // is over after two deaths. Damping the base rate by absolute headcount
  // gives a small field a real round instead of a coin flip. Applied to the
  // crowding term only, so the creep's termination guarantee is untouched.
  const thin = h.thinField > 0 ? Math.min(1, Math.pow(live / h.thinField, h.thinPower)) : 1;
  const creep = h.creep * Math.pow(tick, h.creepPower) * (h.creepBlend + (1 - h.creepBlend) * heat);
  const raw = h.q0 * Math.pow(heat, h.alpha) * thin + creep;
  return Math.min(h.qMax, Math.max(h.qMin, raw));
}

export interface DecisionContext {
  balance: number;
  /** Every entrant starts here: the pot split evenly. */
  entryBalance: number;
  /** balance / entryBalance. The "multiple" a player is up. */
  multiple: number;
  /** Elimination chance just applied this tick. */
  q: number;
  tick: number;
  liveCount: number;
  totalPlayers: number;
  rng: Rng;
}

/** Returns true if the player walks out now. */
export type Strategy = (ctx: DecisionContext) => boolean;

export interface TickEvent {
  tick: number;
  q: number;
  /** True while the opening grace period is still shielding the field. */
  grace: boolean;
  liveBefore: number;
  killed: number;
  cashedOut: number;
  /** Balance released by the eliminated and shared among survivors. */
  redistributed: number;
}

export type RoundEnding = "resolved" | "wipe";

export interface CashOutRecord {
  id: number;
  /** The round tick at which the player left. 0 means before the first roll. */
  tick: number;
  /**
   * True when the exit came through `cashOut()` between ticks rather than a
   * strategy decision inside the tick. Replay must respect the distinction:
   * an in-tick exit is counted in that tick's event, a between-tick one is
   * not, so collapsing the two changes the event stream.
   */
  manual: boolean;
}

export interface RoundResult {
  entrants: number;
  grossHandle: number;
  pot: number;
  toBonanza: number;
  toHouse: number;
  toRevShare: number;
  /** Pot lost when the field was wiped simultaneously. Diverted to the bonanza. */
  wipeLeak: number;
  ticks: number;
  ending: RoundEnding;
  players: Player[];
  events: TickEvent[];
  /**
   * Every voluntary exit, in order. Together with the RNG seed and the
   * entrant list this makes a round fully replayable: the elimination stream
   * consumes one draw per live player per tick, so knowing exactly when each
   * player left pins the entire sequence. This is the record a provably-fair
   * verification replays against.
   */
  cashOuts: CashOutRecord[];
  durationMs: number;
}

export interface Entrant {
  id: number;
  strategyId: string;
  strategy: Strategy;
}

/**
 * One round of Critical Mass.
 *
 * Balance is conserved: eliminated players' SOL is shared pro-rata among the
 * survivors of that same tick, so the total in play only ever leaves via a
 * voluntary walk-out or a total wipe. Because every live player holds an
 * identical balance, that makes each player's balance a martingale, and the
 * in-game return is therefore independent of when they choose to walk out.
 */
export class Round {
  readonly config: GameConfig;
  readonly players: Player[];
  readonly events: TickEvent[] = [];
  readonly cashOutLog: CashOutRecord[] = [];
  readonly entryBalance: number;
  readonly grossHandle: number;
  readonly pot: number;

  private readonly strategyOf = new WeakMap<Player, Strategy>();
  private readonly rng: Rng;
  private q: number;
  private tick = 0;
  private wipeLeak = 0;
  private ending: RoundEnding | null = null;

  constructor(config: GameConfig, rng: Rng, entrants: Entrant[]) {
    if (entrants.length === 0) throw new Error("round needs at least one entrant");
    this.config = config;
    this.rng = rng;
    this.q = config.hazard.q0;

    this.grossHandle = entrants.length * config.entry;
    this.pot = this.grossHandle * (1 - totalRake(config));
    this.entryBalance = this.pot / entrants.length;

    this.players = entrants.map((e) => ({
      id: e.id,
      strategyId: e.strategyId,
      outcome: "in" as PlayerOutcome,
      balance: this.entryBalance,
      cashedOut: 0,
      bonanzaTickets: config.bonanza.ticketBase,
      ticksSurvived: 0,
      lastStanding: false,
    }));
    this.players.forEach((p, i) => this.strategyOf.set(p, entrants[i]!.strategy));
  }

  get finished(): boolean {
    return this.ending !== null;
  }

  get currentTick(): number {
    return this.tick;
  }

  get hazard(): number {
    return this.q;
  }

  private live(): Player[] {
    return this.players.filter((p) => p.outcome === "in");
  }

  /**
   * Crowding drives risk: a packed shaft is dangerous, an empty one is nearly
   * safe. The creep term guarantees a stalled round still terminates.
   * Delegates to the shared `hazardAt` so every consumer runs one curve.
   */
  private computeHazard(liveCount: number): number {
    return hazardAt(this.config.hazard, this.tick, liveCount, this.players.length);
  }

  /** Advances one tick. Returns null once the round has ended. */
  step(): TickEvent | null {
    if (this.ending) return null;

    let live = this.live();

    // A sole survivor is never exposed to another roll; they take the pot.
    if (live.length <= 1) {
      if (live.length === 1) {
        const last = live[0]!;
        last.outcome = "cashed";
        last.cashedOut = last.balance;
        last.lastStanding = true;
      }
      this.ending = "resolved";
      return null;
    }

    this.tick++;
    this.q = this.computeHazard(live.length);
    const liveBefore = live.length;

    // Tickets accrue before the roll, so the tick you die on still counts
    // unless forfeitOnDeath is set.
    const ticketGain = this.config.bonanza.ticketPerRisk * this.q;
    for (const p of live) {
      p.bonanzaTickets += ticketGain;
      p.ticksSurvived++;
    }

    // Elimination. Independent per player, which is what makes the shared
    // hazard rate legible to everyone in the shaft.
    // Nobody is eliminated during the opening grace ticks. Players can read
    // the field and the rising hazard before it can touch them.
    const inGrace = this.tick <= this.config.hazard.graceTicks;

    const doomed: Player[] = [];
    if (!inGrace) {
      for (const p of live) {
        if (this.rng.next() < this.q) doomed.push(p);
      }
    }

    // Sparing one player when the field would be wiped keeps the pot inside
    // the game. Without it, endgame wipes quietly tax whoever stayed longest.
    if (!inGrace && this.config.hazard.guaranteeSurvivor && doomed.length === live.length) {
      const spared = Math.floor(this.rng.next() * doomed.length);
      doomed.splice(spared, 1);
    }

    let released = 0;
    for (const p of doomed) {
      p.outcome = "dead";
      released += p.balance;
      p.balance = 0;
      if (this.config.bonanza.forfeitOnDeath) p.bonanzaTickets = 0;
    }
    const killed = doomed.length;

    const survivors = live.filter((p) => p.outcome === "in");

    if (survivors.length === 0) {
      // Total wipe. The pot has nowhere to go but the jackpot pool.
      this.wipeLeak += released;
      this.events.push({
        tick: this.tick,
        q: this.q,
        grace: inGrace,
        liveBefore,
        killed,
        cashedOut: 0,
        redistributed: 0,
      });
      this.ending = "wipe";
      return this.events[this.events.length - 1]!;
    }

    if (released > 0) {
      const totalSurvivorBalance = survivors.reduce((a, p) => a + p.balance, 0);
      for (const p of survivors) {
        p.balance += (released * p.balance) / totalSurvivorBalance;
      }
    }

    // Walk-out decisions resolve after the roll: you cannot dodge the tick
    // you are already facing.
    let cashedOut = 0;
    for (const p of survivors) {
      const leave = this.strategyOf.get(p)!({
        balance: p.balance,
        entryBalance: this.entryBalance,
        multiple: p.balance / this.entryBalance,
        q: this.q,
        tick: this.tick,
        liveCount: survivors.length,
        totalPlayers: this.players.length,
        rng: this.rng,
      });
      if (leave) {
        p.outcome = "cashed";
        p.cashedOut = p.balance;
        this.cashOutLog.push({ id: p.id, tick: this.tick, manual: false });
        cashedOut++;
      }
    }

    const event: TickEvent = {
      tick: this.tick,
      q: this.q,
      grace: inGrace,
      liveBefore,
      killed,
      cashedOut,
      redistributed: released,
    };
    this.events.push(event);

    if (this.live().length === 0) this.ending = "resolved";
    return event;
  }

  /**
   * Banks a live player immediately, between ticks. Real players cash out the
   * instant they press the button — waiting for the next tick boundary would
   * make the control feel broken — while bots decide through their strategy
   * during `step`. Either way a player never escapes a tick already in flight.
   */
  cashOut(playerId: number): number | null {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.outcome !== "in") return null;
    p.outcome = "cashed";
    p.cashedOut = p.balance;
    this.cashOutLog.push({ id: p.id, tick: this.tick, manual: true });
    if (this.live().length === 0) this.ending = "resolved";
    return p.cashedOut;
  }

  /** Runs the round to completion. */
  play(): RoundResult {
    while (!this.finished) this.step();
    return this.result();
  }

  result(): RoundResult {
    if (!this.ending) throw new Error("round is still running");
    const c = this.config;
    const t = c.timing;
    return {
      entrants: this.players.length,
      grossHandle: this.grossHandle,
      pot: this.pot,
      toBonanza: this.grossHandle * c.rake.bonanza,
      toHouse: this.grossHandle * c.rake.house,
      toRevShare: this.grossHandle * c.rake.revShare,
      wipeLeak: this.wipeLeak,
      ticks: this.tick,
      ending: this.ending,
      players: this.players,
      events: this.events,
      cashOuts: this.cashOutLog,
      durationMs: t.lobbyMs + this.tick * t.tickMs + t.resultMs,
    };
  }
}
