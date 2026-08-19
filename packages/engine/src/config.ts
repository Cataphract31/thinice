export interface RakeConfig {
  platform: number;
  buyback: number;
}

export interface HazardConfig {
  q0: number;
  alpha: number;
  creep: number;
  creepPower: number;
  creepBlend: number;
  thinField: number;
  thinPower: number;
  qMin: number;
  qMax: number;
  graceTicks: number;
  guaranteeSurvivor: boolean;
}

export interface TimingConfig {
  lobbyMs: number;
  tickMs: number;
  resultMs: number;
}

export interface FieldConfig {
  min: number;
  max: number;
}

export interface GameConfig {
  entry: number;
  rake: RakeConfig;
  hazard: HazardConfig;
  timing: TimingConfig;
  field: FieldConfig;
}

export const DEFAULT_CONFIG: GameConfig = {
  entry: 0.1,
  rake: { platform: 0.005, buyback: 0.015 },
  hazard: {
    q0: 0.075,
    alpha: 2.4,
    creep: 3.7e-7,
    creepPower: 3,
    creepBlend: 0.22,
    thinField: 12,
    thinPower: 0.9,
    qMin: 0.004,
    qMax: 0.42,
    graceTicks: 2,
    guaranteeSurvivor: true,
  },
  timing: { lobbyMs: 10000, tickMs: 500, resultMs: 6500 },
  field: { min: 8, max: 250 },
};

export function drawFieldSize(c: GameConfig, unit: number): number {
  return c.field.min + Math.floor(unit * (c.field.max - c.field.min + 1));
}

export function totalRake(c: GameConfig): number {
  return c.rake.platform + c.rake.buyback;
}
