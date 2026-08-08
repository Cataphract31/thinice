import type { BonanzaConfig, RevShareConfig } from "./config.js";
import type { Rng } from "./rng.js";

export interface BonanzaFire {
  amount: number;
  winnerId: number;
  roundsSinceLast: number;
  totalTickets: number;
}

/**
 * Winner-take-all jackpot. Tickets are earned by playing and are wiped for
 * everyone the moment it fires, so each cycle is a fresh raffle.
 */
export class BonanzaPool {
  pool = 0;
  roundsSinceFire = 0;
  private tickets = new Map<number, number>();
  private ticketTotal = 0;
  /**
   * The raw draws the last `roll` consumed, and the ticket total they were
   * measured against. Recorded with the round so a player can recompute both
   * from the revealed seed and check that the jackpot was not simply handed
   * to whoever the house preferred.
   */
  lastDraws: {
    fire: number;
    winner: number;
    totalTickets: number;
    /**
     * The ordered ticket table the winner walk ran over, snapshotted at the
     * roll. Without it the record proves the two draws came off the committed
     * seed but the WINNER is unverifiable: an operator could record anyone
     * and both floats would still match. With it, a verifier replays the walk
     * and the winner is pinned by the same commitment as the draws.
     */
    holders: [number, number][];
  } | null = null;

  constructor(private readonly config: BonanzaConfig, seedPool = 0) {
    this.pool = seedPool;
  }

  fund(amount: number): void {
    this.pool += amount;
  }

  credit(playerId: number, tickets: number): void {
    if (tickets <= 0) return;
    this.tickets.set(playerId, (this.tickets.get(playerId) ?? 0) + tickets);
    this.ticketTotal += tickets;
  }

  ticketsOf(playerId: number): number {
    return this.tickets.get(playerId) ?? 0;
  }

  get totalTickets(): number {
    return this.ticketTotal;
  }

  /**
   * Rolls the per-round fire chance. Returns the payout, or null if it held.
   *
   * Both draws are taken unconditionally, before any early return. A roll that
   * consumed a different number of draws depending on whether it fired would
   * desynchronise every later roll on the same stream from the replay a player
   * runs to check it — the jackpot would become unverifiable the first time it
   * held on an empty pool.
   */
  roll(rng: Rng): BonanzaFire | null {
    this.roundsSinceFire++;
    const fireDraw = rng.next();
    const winnerDraw = rng.next();
    // Snapshot BEFORE any mutation below: a fire clears the map, and the
    // record must hold the table the walk actually ran over. Map iteration
    // order is insertion order, which is exactly the walk's order.
    this.lastDraws = {
      fire: fireDraw,
      winner: winnerDraw,
      totalTickets: this.ticketTotal,
      holders: [...this.tickets],
    };
    if (fireDraw >= this.config.fireProb) return null;
    if (this.ticketTotal <= 0 || this.pool <= 0) return null;

    let target = winnerDraw * this.ticketTotal;
    let winnerId = -1;
    for (const [id, count] of this.tickets) {
      target -= count;
      if (target <= 0) {
        winnerId = id;
        break;
      }
      // `ticketTotal` is a running float sum and the map values are the truth.
      // If accumulated dust puts the total a hair above the real sum, the walk
      // falls off the end — so the last holder catches it rather than the fire
      // being silently swallowed with the pool retained.
      winnerId = id;
    }
    if (winnerId === -1) return null;

    const fire: BonanzaFire = {
      amount: this.pool,
      winnerId,
      roundsSinceLast: this.roundsSinceFire,
      totalTickets: this.ticketTotal,
    };
    this.pool = 0;
    this.roundsSinceFire = 0;
    this.tickets.clear();
    this.ticketTotal = 0;
    return fire;
  }
}

/**
 * Permanent revenue-share tickets.
 *
 * Weight decays continuously so the stream tracks recent volume rather than
 * lifetime volume. Without decay, total weight grows without bound and yield
 * per ticket falls as 1/t; with a half-life the total converges to
 * volume/lambda and yield per ticket settles at a constant. Lifetime tickets
 * are tracked separately and never decay, so a player's rank is permanent even
 * though their claim on the stream is not.
 */
export class RevShareLedger {
  private readonly lambda: number;
  /**
   * Decay-normalised weights. A grant of `n` tickets at time `t` is stored as
   * `n * e^(lambda*t)`, so a holder's live weight is always `norm * e^(-lambda*now)`.
   * That common factor cancels out of every share calculation, which means
   * decay never has to be applied by sweeping the holder set — shares depend
   * only on these monotonically increasing values.
   */
  private norm = new Map<number, number>();
  private normTotal = 0;
  private lifetime = new Map<number, number>();
  /** Running sum of payout per unit of normalised weight. */
  private accPerWeight = 0;
  private debt = new Map<number, number>();
  private settled = new Map<number, number>();
  /**
   * Time origin for the decay normalisation, pinned to the first grant rather
   * than the Unix epoch. Measuring from 1970 makes every stored weight carry a
   * factor of e^(lambda * 56 years) — around 10^101 — which costs precision
   * for nothing, since only differences from the origin ever matter.
   */
  private epochMs: number | null = null;
  /** Revenue that arrived while nobody held weight. */
  unallocated = 0;
  distributed = 0;

  constructor(private readonly config: RevShareConfig) {
    this.lambda =
      config.halfLifeDays > 0 ? Math.LN2 / (config.halfLifeDays * 86_400_000) : 0;
  }

  /** The time origin, fixed by whichever call first needs it. */
  private epoch(nowMs: number): number {
    if (this.epochMs === null) this.epochMs = nowMs;
    return this.epochMs;
  }

  /**
   * Banks everything owed so far and restarts the accumulator from zero.
   *
   * `accPerWeight` is a running sum whose increments are `amount / normTotal`,
   * and `normTotal` grows like e^(lambda*t) on a process that stays up. So the
   * increments shrink geometrically while the total they are added to
   * converges — and once an increment falls below one ulp of the running sum,
   * `+=` discards it. The rake keeps being taken and booked as distributed,
   * and not a lamport reaches anyone. Measured on the real class, crediting
   * goes materially lossy after roughly six years of uptime.
   *
   * Rescaling cannot fix this: the increment and the sum it is added to both
   * carry the same factor, so their RATIO — the thing that matters — is
   * invariant under any change of units. The accumulator has to be emptied
   * instead. Settling every holder converts their claim into a plain SOL
   * figure in `settled`, after which the sum can start again at zero and the
   * next increments are exact. Nothing is created or lost: this is the same
   * arithmetic every holder would get from claiming, applied to all of them.
   *
   * With `accPerWeight` back at zero the normalisation is free to be re-based
   * in the same pass, which also keeps `normTotal` from drifting toward
   * overflow on a very long-lived process.
   */
  private flush(nowMs: number): void {
    if (this.epochMs === null) return;
    for (const id of this.norm.keys()) this.settle(id);
    this.accPerWeight = 0;
    this.debt.clear();
    const shift = nowMs - this.epochMs;
    if (this.lambda > 0 && shift > 0) {
      const down = Math.exp(-this.lambda * shift);
      if (Number.isFinite(down) && down > 0) {
        for (const [id, n] of this.norm) this.norm.set(id, n * down);
        this.normTotal *= down;
        this.epochMs = nowMs;
      }
    }
  }

  /**
   * Flush every four half-lives — about six months at the shipped 45-day
   * setting, so O(holders) work roughly once a year, against the alternative
   * of silently paying nobody. Four half-lives is far inside the range where
   * the arithmetic is still exact, so this never runs late.
   */
  private maybeFlush(nowMs: number): void {
    if (this.lambda <= 0 || this.epochMs === null) return;
    if (this.lambda * (nowMs - this.epochMs) > Math.LN2 * 4) this.flush(nowMs);
  }

  private settle(playerId: number): void {
    const owed = (this.norm.get(playerId) ?? 0) * this.accPerWeight;
    const pending = owed - (this.debt.get(playerId) ?? 0);
    if (pending > 0) {
      this.settled.set(playerId, (this.settled.get(playerId) ?? 0) + pending);
    }
    this.debt.set(playerId, owed);
  }

  /** Grants tickets for an entry paid at the given simulated time. */
  credit(playerId: number, nowMs: number, tickets = this.config.ticketsPerEntry): void {
    if (tickets <= 0) return;
    this.maybeFlush(nowMs);
    this.settle(playerId);
    const scaled = tickets * Math.exp(this.lambda * (nowMs - this.epoch(nowMs)));
    const next = (this.norm.get(playerId) ?? 0) + scaled;
    this.norm.set(playerId, next);
    this.normTotal += scaled;
    this.lifetime.set(playerId, (this.lifetime.get(playerId) ?? 0) + tickets);
    this.debt.set(playerId, next * this.accPerWeight);
  }

  /** Streams house revenue to current weight holders. O(1). */
  distribute(amount: number, _nowMs: number): void {
    if (amount <= 0) return;
    if (this.normTotal <= 0) {
      // Nobody to pay yet. Held, not lost: this is rake already taken from
      // players, and the first holders to appear are owed it.
      this.unallocated += amount;
      return;
    }
    const total = amount + this.unallocated;
    this.unallocated = 0;
    this.accPerWeight += total / this.normTotal;
    this.distributed += total;
  }

  /** Live, decayed weight — the number a player sees in the UI. */
  weightOf(playerId: number, nowMs: number): number {
    const n = this.norm.get(playerId) ?? 0;
    return n * Math.exp(-this.lambda * (nowMs - this.epoch(nowMs)));
  }

  totalWeight(nowMs: number): number {
    return this.normTotal * Math.exp(-this.lambda * (nowMs - this.epoch(nowMs)));
  }

  /** Never decays. This is the permanent "tickets earned" rank. */
  lifetimeOf(playerId: number): number {
    return this.lifetime.get(playerId) ?? 0;
  }

  /**
   * Reinstates a holder from persisted state: their permanent lifetime count
   * and their current decayed weight, both as previously read back out via
   * `lifetimeOf`/`weightOf`. Restoring weight as a fresh grant of its decayed
   * value is exact, because decay only ever depends on time since the grant.
   *
   * `alreadyEarned` matters more than it looks. `earningsOf` is a lifetime
   * running total, and callers pay out the difference between it and what they
   * have already paid. A restart rebuilds this ledger with an empty `settled`
   * map, so without seeding it the total restarts at zero, every difference
   * comes out negative, and the rakeback stream silently stops paying until
   * fresh earnings exceed the entire pre-restart history — months of nothing,
   * with no error anywhere. Pass what the caller's own records say it has paid.
   */
  restore(
    playerId: number,
    lifetimeTickets: number,
    weight: number,
    nowMs: number,
    alreadyEarned = 0,
  ): void {
    if (alreadyEarned > 0) {
      this.settled.set(playerId, (this.settled.get(playerId) ?? 0) + alreadyEarned);
    }
    if (weight > 0) {
      this.settle(playerId);
      const scaled = weight * Math.exp(this.lambda * (nowMs - this.epoch(nowMs)));
      const next = (this.norm.get(playerId) ?? 0) + scaled;
      this.norm.set(playerId, next);
      this.normTotal += scaled;
      this.debt.set(playerId, next * this.accPerWeight);
    }
    if (lifetimeTickets > 0) {
      this.lifetime.set(playerId, (this.lifetime.get(playerId) ?? 0) + lifetimeTickets);
    }
  }

  earningsOf(playerId: number): number {
    const owed = (this.norm.get(playerId) ?? 0) * this.accPerWeight;
    const pending = owed - (this.debt.get(playerId) ?? 0);
    return (this.settled.get(playerId) ?? 0) + Math.max(0, pending);
  }

  holders(): Iterable<number> {
    return this.norm.keys();
  }
}
