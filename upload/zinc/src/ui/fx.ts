/**
 * CRT mode: the board behind curved-glass phosphor, Balatro-style.
 *
 * Pure presentation, ON by default — the broadcast look tested well enough to
 * become the face of the game — with the toggle in the sound popover for
 * anyone who wants the raw feed back. Module-level state with subscribers,
 * the same shape the sound preferences use: the toggle and the layer never
 * need to know each other's tree.
 */

const KEY = "zinc.crt";

let on = true;
try {
  const stored = localStorage.getItem(KEY);
  if (stored !== null) on = stored === "1";
} catch {
  /* storage may be unavailable; the toggle just will not persist */
}

const subs = new Set<(on: boolean) => void>();

export function crtOn(): boolean {
  return on;
}

export function setCrt(v: boolean): void {
  on = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* same */
  }
  for (const fn of subs) fn(on);
}

/** Subscribe to changes; returns the unsubscribe. */
export function onCrtChange(fn: (on: boolean) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
