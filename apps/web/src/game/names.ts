/**
 * Wallet display. The bot-handle list and the fake-address generator that
 * populated the offline demo's crowd left with the demo; what remains is the
 * one formatter real addresses are rendered with.
 */

/** "3xF9…k2Qd" style: first and last four characters. */
export function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
