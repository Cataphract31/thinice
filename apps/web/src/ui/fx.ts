const KEY = "zinc.crt";

let on = true;
try {
  const stored = localStorage.getItem(KEY);
  if (stored !== null) on = stored === "1";
} catch {
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
  }
  for (const fn of subs) fn(on);
}

export function onCrtChange(fn: (on: boolean) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
