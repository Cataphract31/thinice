import { solToLamports } from "../vendor/arcade/money/money.js";

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${name}="${raw}" is not a number in [${min}, ${max}]`);
  }
  return v;
}

export const CONFIG = {
  port: num("PORT", 8787, 1, 65535),
  dbPath: process.env.DB_PATH ?? "zinc.db",
  minEntrants: num("MIN_ENTRANTS", 2, 2, 400),
  maxPlatesPerWallet: num("MAX_PLATES_PER_WALLET", 5, 1, 50),
  autoLapseMs: num("AUTO_LAPSE_MIN", 10, 0, 1440) * 60_000,
  tokenTtlMs: num("TOKEN_TTL_DAYS", 30, 0, 365) * 86_400_000,
  resumeTriesPerMin: num("RESUME_TRIES_PER_MIN", 10, 1, 1000),
} as const;

export const CHARS = [
  "chad",
  "soyjak",
  "wojak",
  "ansem",
  "saylor",
  "pepe",
  "chud",
  "bogdanoff",
  "bobo",
  "mumu",
  "milady",
  "sbf",
];

export const LAMPORTS = 1_000_000_000;

export function toLamports(sol: number): number {
  return Number(solToLamports(sol.toFixed(9)));
}

export function toSol(lamports: number): number {
  return lamports / LAMPORTS;
}
