/** Bot handles for the prototype. Replaced by real wallets in production. */
export const NAMES = [
  "latency_god", "glass_hands", "kerem.sol", "panic_wojak", "curve_priest",
  "dead_inside", "fomo_kaan", "perma_bull", "kimchi_prem", "0x_serpent",
  "wagmi_ratio", "sniper_ay", "rug_survivor", "one_more", "exit_liq",
  "brainlet", "dip_buyer", "cold_rod", "median", "tick_merchant",
  "core_hugger", "last_out", "zinc_maxi", "shaft_rat", "ore_eater",
  "deep_diver", "no_brakes", "half_kelly", "tilted", "grim_reader",
  "paper_cut", "iron_nerve", "slow_hands", "vault_gremlin", "nightshift",
  "canary", "pit_boss", "ash_walker", "molten", "quiet_exit",
  "carbide", "blackdamp", "firedamp", "pit_pony", "roof_bolt",
  "galena", "sphalerite", "smithsonite", "hemimorph", "franklinite",
  "drift_rat", "adit", "winze", "stope", "gangue",
  "headframe", "kibble", "tramway", "banksman", "hewer",
];

export function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Players show as wallet addresses, the way every on-chain platform renders
 * them. Base58 alphabet (what Solana addresses actually use: no 0, O, I, l),
 * 44 characters, then truncated to ends for display.
 */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function fakeAddress(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 44; i++) s += BASE58[Math.floor(rand() * BASE58.length)]!;
  return s;
}

/** "3xF9…k2Qd" style: first and last four characters. */
export function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
