import { randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { IncomingMessage } from "node:http";

export const NONCE_TTL_MS = 120_000;

export function challengeText(nonce: string, publicOrigin: string): string {
  return publicOrigin
    ? `THIN ICE login\nsite: ${publicOrigin}\nnonce: ${nonce}`
    : `THIN ICE login\nnonce: ${nonce}`;
}

export function verifySignature(
  wallet: string,
  text: string,
  sigBase64: string,
): boolean {
  try {
    const pubkey = bs58.decode(wallet);
    if (pubkey.length !== 32) return false;
    const sig = Buffer.from(sigBase64, "base64");
    if (sig.length !== 64) return false;
    const msg = new TextEncoder().encode(text);
    return nacl.sign.detached.verify(msg, new Uint8Array(sig), pubkey);
  } catch {
    return false;
  }
}

export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function originAllowed(header: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!header) return false;
  const origin = header.trim().replace(/\/+$/, "");
  return allowed.includes(origin);
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function parseTrustedProxies(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "127.0.0.1,::1")
      .split(",")
      .map((s) => normalizeIp(s.trim()))
      .filter(Boolean),
  );
}

export function clientIpOf(req: IncomingMessage, trusted: Set<string>): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? "?");
  if (!trusted.has(remote)) return remote;
  const fwd = String(req.headers["x-forwarded-for"] ?? "");
  const chain = fwd
    .split(",")
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (!trusted.has(hop)) return hop;
  }
  return remote;
}

export class ResumeLimiter {
  private tries = new Map<string, { n: number; at: number }>();
  private readonly windowMs: number;
  constructor(
    private readonly maxPerWindow: number,
    windowMs = 60_000,
  ) {
    this.windowMs = windowMs;
  }

  may(key: string, now = Date.now()): boolean {
    const r = this.tries.get(key);
    if (!r || now - r.at > this.windowMs) {
      this.tries.set(key, { n: 1, at: now });
      this.prune(now);
      return true;
    }
    r.n++;
    return r.n <= this.maxPerWindow;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [k, r] of this.tries) if (r.at < cutoff) this.tries.delete(k);
  }
}

export function resumeTokenMatches(offered: string, stored: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
