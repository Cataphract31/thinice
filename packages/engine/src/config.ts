export interface RakeConfig {
  /** Fraction retained by the platform to run the game. */
  platform: number;
  /** Fraction routed to token buybacks and burns. Leaves the player economy. */
  buyback: number;
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
   * hazard rate they are about to face, so the grace period costs nothing but
   * gives everyone a chance to read the field before the shaft turns on them.
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

export interface TimingConfig {
  lobbyMs: number;
  tickMs: number;
  resultMs: number;
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
 * 2% total rake — 0.5% platform fee, 1.5% to token buybacks and burns.
 * Headline RTP is 98%, and that is the WHOLE story: the pot is 98% of handle
 * and every lamport of it leaves via a player, so there is no second number
 * to add and no schedule anyone has to hit to collect it.
 *
 * This replaced a 5% rake that returned four of its five points through a
 * jackpot and a rakeback ledger. On paper that was 99%. Measured over a
 * 135,000-round population it was not: 97.5% of wallets never won the jackpot,
 * and the two points funding it simply left them. Paying those points inside
 * the round instead moved the MEDIAN wallet up 1.21 points, took 81.8% of
 * wallets with it, and cut the variance a player is exposed to by 79% — four
 * fifths of it had been a 1-in-1300 event almost nobody was ever in.
 *
 * The rake is now the only thing between handle and players. Nothing is held
 * in a pool, nothing decays, nothing has to be claimed.
 */
export const DEFAULT_CONFIG: GameConfig = {
  entry: 0.1,
  rake: { platform: 0.005, buyback: 0.015 },
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
  // tickMs is a pure clock knob: it changes wall-clock pacing without touching
  // a single probability, so game feel can be tuned independently of economics.
  // Lobby 10s, not 7: first live feedback was "by the time I decided, already
  // gone" — deciding plus bonding five plates needs the extra beat, and it
  // costs ~6% round throughput, nothing else. Result 6.5s: the endgame
  // sequence (extended slow-mo, the stage clearing, the coronation) spends
  // ~3s before the winner card, and the card still deserves its read time.
  timing: { lobbyMs: 10000, tickMs: 500, resultMs: 6500 },
  /*
   * Lobby size. Not a safety rail: the hazard curve reads crowding as a
   * fraction so it is scale-free, and the renderer was built for a thousand
   * cells. What bounds it in practice is the box, since state is serialised
   * per client on every broadcast — measure egress before raising it on a
   * machine that matters. Both sides hash this into the fairness commitment,
   * so server and client must ship together when it moves.
   *
   * The MINIMUM is not a live rule at all — only the simulators read it, to
   * sample representative rounds. It has to track what actually runs or the
   * economics get certified over rooms the game never sees: with the practice
   * roster down to ten, and none at all at launch, a real lobby is small.
   */
  field: { min: 8, max: 250 },
};

/** Draws a field size from the configured lobby range. */
export function drawFieldSize(c: GameConfig, unit: number): number {
  return c.field.min + Math.floor(unit * (c.field.max - c.field.min + 1));
}

/**
 * The cost of playing, as a fraction of the stake. Both components leave the
 * player economy, so this is the whole edge: in-game RTP is exactly 1 - this,
 * for every player and every exit policy.
 */
export function totalRake(c: GameConfig): number {
  return c.rake.platform + c.rake.buyback;
}
