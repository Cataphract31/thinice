import type { GameConfig, HazardConfig } from "./config.js";
import { totalRake } from "./config.js";
import type { Rng } from "./rng.js";

export type PlayerOutcome = "in" | "cashed" | "dead";

export interface Player {
  id: number;
  strategyId: string;
  outcome: PlayerOutcome;
  balance: number;
  cashedOut: number;
  ticksSurvived: number;
  lastStanding: boolean;
}

export function hazardAt(h: HazardConfig, tick: number, live: number, total: number): number {
  const heat = live / total;
  const thin = h.thinField > 0 ? Math.min(1, Math.pow(live / h.thinField, h.thinPower)) : 1;
  const creep = h.creep * Math.pow(tick, h.creepPower) * (h.creepBlend + (1 - h.creepBlend) * heat);
  const raw = h.q0 * Math.pow(heat, h.alpha) * thin + creep;
  return Math.min(h.qMax, Math.max(h.qMin, raw));
}

export interface DecisionContext {
  balance: number;
  entryBalance: number;
  multiple: number;
  q: number;
  tick: number;
  liveCount: number;
  totalPlayers: number;
  rng: Rng;
}

export type Strategy = (ctx: DecisionContext) => boolean;

export interface TickEvent {
  tick: number;
  q: number;
  grace: boolean;
  liveBefore: number;
  killed: number;
  cashedOut: number;
  redistributed: number;
}

export type RoundEnding = "resolved" | "wipe";

export interface CashOutRecord {
  id: number;
  tick: number;
  manual: boolean;
}

export interface RoundResult {
  entrants: number;
  grossHandle: number;
  pot: number;
  toPlatform: number;
  toBuyback: number;
  wipeLeak: number;
  ticks: number;
  ending: RoundEnding;
  players: Player[];
  events: TickEvent[];
  cashOuts: CashOutRecord[];
  durationMs: number;
}

export interface Entrant {
  id: number;
  strategyId: string;
  strategy: Strategy;
}

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

  private computeHazard(liveCount: number): number {
    return hazardAt(this.config.hazard, this.tick, liveCount, this.players.length);
  }

  step(): TickEvent | null {
    if (this.ending) return null;

    let live = this.live();

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

    for (const p of live) p.ticksSurvived++;

    const inGrace = this.tick <= this.config.hazard.graceTicks;

    const doomed: Player[] = [];
    if (!inGrace) {
      for (const p of live) {
        if (this.rng.next() < this.q) doomed.push(p);
      }
    }

    if (!inGrace && this.config.hazard.guaranteeSurvivor && doomed.length === live.length) {
      const spared = Math.floor(this.rng.next() * doomed.length);
      doomed.splice(spared, 1);
    }

    let released = 0;
    for (const p of doomed) {
      p.outcome = "dead";
      released += p.balance;
      p.balance = 0;
    }
    const killed = doomed.length;

    const survivors = live.filter((p) => p.outcome === "in");

    if (survivors.length === 0) {
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

  cashOut(playerId: number): number | null {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.outcome !== "in") return null;
    p.outcome = "cashed";
    p.cashedOut = p.balance;
    this.cashOutLog.push({ id: p.id, tick: this.tick, manual: true });
    if (this.live().length === 0) this.ending = "resolved";
    return p.cashedOut;
  }

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
      toPlatform: this.grossHandle * c.rake.platform,
      toBuyback: this.grossHandle * c.rake.buyback,
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
