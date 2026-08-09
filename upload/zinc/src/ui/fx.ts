/**
 * CRT mode: the board behind curved-glass phosphor, Balatro-style.
 *
 * Pure presentation, defaulted OFF: scanlines and vignette cost a little
 * legibility, and this is a product where the numbers are money. The people
 * who want the arcade read flip it once and it stays flipped. Module-level
 * state with subscribers, the same shape the sound preferences use — the
 * toggle lives in the volume popover, the layer lives over the lattice, and
 * neither needs to know the other's tree.
 */

const KEY = "zinc.crt";

let on = false;
try {
  on = localStorage.getItem(KEY) === "1";
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
