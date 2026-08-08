export interface RakeConfig {
  /** Fraction of each entry diverted to the bonanza jackpot pool. Player money. */
  bonanza: number;
  /** Fraction retained by the house. The only true edge. */
  house: number;
  /** Fraction streamed back to holders of permanent revenue-share tickets. Player money. */
  revShare: number;
}

export interface HazardConfig {
  /** Base per-player elimination chance per tick at a completely full field. */
  q0: number;
  /** Convexity of the crowding curve. Higher = risk falls off faster as the field empties. */
  alpha: number;
  /** Per-tick additive pressure, so a stalled round still resolves. */
  creep: number;
  /**
   * Curvature of the creep ramp. At 1 the pressure grows linearly and is
   * already significant mid-round, where headcount should be what matters.
   * Above 1 it stays negligible early and bites late, killing the endgame tail
   * without dulling the crowding signal while the shaft is still busy.
   */
  creepPower: number;
  /** How much of the creep applies regardless of crowding, in [0, 1]. */
  creepBlend: number;
  /**
   * Headcount at or above which the crowding term runs at full strength.
   *
   * A round ends when one player is left, so a 3-player field needs two deaths
   * where a 30-player field needs twenty-nine. At the same rate per player the
   * small field is over in a fraction of the ticks and feels rushed. Scaling
   * the base rate down by *absolute* headcount buys thin fields the same arc.
   *
   * This is pure pacing. Return is fixed by the rake and by redistribution, so
   * the hazard schedule can be moved freely without touching RTP or edge.
   */
  thinField: number;
  /** Curvature of that relief. Below 1 it is gentle, above 1 aggressive. */
  thinPower: number;
  qMin: number;
  qMax: number;
  /**
   * Opening ticks during which nobody can be eliminated. Players still see the
   * hazard rate they are about to face and still accrue bonanza tickets, so the
   * grace period costs nothing but gives everyone a chance to read the field
   * before the shaft turns on them.
   */
  graceTicks: number;
  /**
   * If true, a tick can never eliminate the entire remaining field — one
   * player is always spared. This removes the only leak in the redistribution
   * loop and makes in-game return exactly independent of when a player walks
   * out. It also removes the "everybody loses" round.
   */
  guaranteeSurvivor: boolean;
}

export interface BonanzaConfig {
  /** Per-round chance the jackpot fires, independent of pool size. */
  fireProb: number;
  /** Tickets granted on entry, before any tick survival. */
  ticketBase: number;
  /** Tickets per tick, scaled by the live hazard rate. */
  ticketPerRisk: number;
  /** If true, being eliminated forfeits the tickets earned this round. */
  forfeitOnDeath: boolean;
}

export interface RevShareConfig {
  /** Permanent tickets granted per entry. Entry is fixed, so this is per round played. */
  ticketsPerEntry: number;
  /** Half-life of ticket weight in days. Zero or below disables decay. */
  halfLifeDays: number;
}

export interface TimingConfig {
  lobbyMs: number;
  tickMs: number;
  resultMs: number;
  /** Extended result phase after a jackpot fires, so the celebration can play out. */
  bonanzaMs: number;
}

export interface FieldConfig {
  /** Smallest lobby a round runs with. */
  min: number;
  /** Largest lobby a round runs with. */
  max: number;
}

export interface GameConfig {
  entry: number;
  rake: RakeConfig;
  hazard: HazardConfig;
  bonanza: BonanzaConfig;
  revShare: RevShareConfig;
  timing: TimingConfig;
  /**
   * Lobby capacity. This is a live game rule, not a simulation detail: the
   * hazard curve reads crowding off the field size, so every simulator must
   * draw from the same range the client actually runs. It was previously
   * hardcoded in seven places.
   */
  field: FieldConfig;
}

/**
 * 5% total rake — 2% bonanza, 2% rakeback, 1% platform fee — of which only
 * the platform 1% is genuine house edge. Headline RTP is 99%: 95% returned
 * inside the game, 2% via the bonanza, 2% via the revenue-share stream.
 *
 * The platform fee was 2%. Halving it moves a point straight back into the
 * in-game pot — the strongest possible use of a point, since it pays on
 * every round rather than through the rare jackpot — and makes the headline
 * a 99% figure almost nothing on the market can print.
 *
 * (Earlier move, same logic: the bonanza was 3%; a jackpot point is paid
 * roughly once per 39,000 entries, so shifting it in-game raised the chance
 * of finishing a round ahead and cut total variance per stake by 52%.)
 */
export const DEFAULT_CONFIG: GameConfig = {
  entry: 0.1,
  rake: { bonanza: 0.02, house: 0.01, revShare: 0.02 },
  hazard: {
    q0: 0.075,
    // Crowding stays steep: this is the "fewer people, more oxygen" signal the
    // whole game reads on, so pacing is bought from creep instead.
    alpha: 2.4,
    // Cubic and tiny. At power 2 the creep had already overtaken crowding by
    // the mid-game, which flattened the hazard: a wave of deaths barely moved
    // the number because most of it was clock, not headcount. Cubic keeps
    // creep near-zero through the whole busy phase and only closes the round
    // out at the very end.
    creep: 3.7e-7,
    creepPower: 3,
    // And the creep that does exist is now mostly crowd-linked (was 0.44), so
    // even late deaths pull it down instead of leaving it stuck.
    creepBlend: 0.22,
    thinField: 12,
    thinPower: 0.9,
    qMin: 0.004,
    qMax: 0.42,
    graceTicks: 2,
    guaranteeSurvivor: true,
  },
  bonanza: {
    fireProb: 1 / 1500,
    // Flat: one ticket per entry, matching the revenue-share tickets. Risk-
    // weighted accrual was measured to hand late-stayers ~1.5pts of RTP over
    // cautious players, and it rewarded never leaving — the opposite of a
    // lively round. The climbing multiplier is already all the incentive
    // anyone needs to stay, so this makes every strategy land on exactly 99%.
    // The demo granted a few hundred per round and the number felt like it
    // meant something. Flat tickets are scale-free — every share is
    // tickets/total — so the denomination is a pure presentation choice, and a
    // bigger one reads better. 200 a round, same for everyone.
    ticketBase: 200,
    ticketPerRisk: 0,
    forfeitOnDeath: false,
  },
  revShare: {
    // Matched to the bonanza denomination for the same reason. Shares are
    // ratios, so this changes nobody's payout by a lamport.
    ticketsPerEntry: 200,
    // Was 75. Shortened so early-cohort weight fades faster: the measured
    // tail for a quitter was ~1.6x their active-period rakeback at 75d,
    // which made early players a little too dominant over later cohorts.
    halfLifeDays: 60,
  },
  // tickMs is a pure clock knob: it changes wall-clock pacing without touching
  // a single probability, so game feel can be tuned independently of economics.
  timing: { lobbyMs: 7000, tickMs: 500, resultMs: 4500, bonanzaMs: 7000 },
  field: { min: 18, max: 34 },
};

/** Draws a field size from the configured lobby range. */
export function drawFieldSize(c: GameConfig, unit: number): number {
  return c.field.min + Math.floor(unit * (c.field.max - c.field.min + 1));
}

/** The original demo's split: 4% house, 3% bonanza, no revenue share. 96% RTP. */
export const LEGACY_CONFIG: GameConfig = {
  ...DEFAULT_CONFIG,
  rake: { bonanza: 0.03, house: 0.04, revShare: 0 },
  revShare: { ticketsPerEntry: 0, halfLifeDays: 0 },
};

export function totalRake(c: GameConfig): number {
  return c.rake.bonanza + c.rake.house + c.rake.revShare;
}
