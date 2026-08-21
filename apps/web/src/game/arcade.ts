const SESSION_COOKIE = "zinc_session";
import {
  connect as arcadeConnect,
  ensureProvider,
  findProvider,
  type ArcadeProvider,
  type FoundProvider,
} from "/arcade/web/wallet.js";

export { completeDeeplink, onDepositArrival, walletRoute } from "/arcade/web/wallet.js";
export type { ArcadeProvider, FoundProvider } from "/arcade/web/wallet.js";

export const SHARED_DOMAIN = ".voidsolana.com";

export const LAMPORTS = 1_000_000_000;

export const GAME = "thin-ice";

export function onArcadeDomain(): boolean {
  const h = location.hostname;
  return h === "voidsolana.com" || h.endsWith(SHARED_DOMAIN);
}

function cookie(name: string): string {
  try {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m && m[1] ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

export function arcadeToken(): string | null {
  const raw = cookie(SESSION_COOKIE);
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

const ARCADE = (import.meta.env.VITE_ARCADE_URL as string | undefined) ?? "";

export function arcadeUrl(path: string): string {
  try {
    const local = /^(localhost|127\.)/.test(location.hostname);
    if (local) {
      const q = new URLSearchParams(location.search).get("arcade");
      if (q) return q.replace(/\/+$/, "") + path;
      return path;
    }
  } catch {
  }
  return ARCADE.replace(/\/+$/, "") + path;
}

export class ArcadeError extends Error {
  code: string;
  status: number;
  answered: boolean;
  constructor(message: string, code = "ARCADE_ERROR", status = 0, answered = false) {
    super(message);
    this.name = "ArcadeError";
    this.code = code;
    this.status = status;
    this.answered = answered;
  }
}

export const READ_MS = 15_000;
export const MOVE_MS = 60_000;

export async function arcadeApi<T>(
  path: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = READ_MS, ...init } = opts;
  const token = arcadeToken();
  const stop = new AbortController();
  const bell = setTimeout(() => stop.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(arcadeUrl(path), {
      ...init,
      signal: stop.signal,
      headers: {
        ...(init.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    throw new ArcadeError(
      stop.signal.aborted
        ? "The arcade did not answer in time."
        : `Could not reach the arcade. ${(err as Error).message}`,
      stop.signal.aborted ? "TIMEOUT" : "UNREACHABLE",
    );
  } finally {
    clearTimeout(bell);
  }

  const isJson = /\bapplication\/json\b/i.test(res.headers.get("content-type") ?? "");
  let parsed: unknown = null;
  if (isJson) {
    const text = await res.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const e = (parsed as { error?: { code?: string; message?: string } })?.error ?? {};
    throw new ArcadeError(e.message ?? `The arcade said ${res.status}.`, e.code ?? "REFUSED", res.status, true);
  }
  if (!isJson) {
    throw new ArcadeError("The arcade answered with something that was not an answer.", "GARBAGE", res.status);
  }
  return parsed as T;
}

export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage?(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  request?(args: { method: string; params?: unknown }): Promise<unknown>;
}

export function walletProvider(): FoundProvider | null {
  return findProvider();
}

export async function walletNow(): Promise<FoundProvider | null> {
  return ensureProvider();
}

export async function arcadeSignIn(): Promise<string> {
  const out = await arcadeConnect().catch((err: { code?: string; message?: string }) => {
    throw new ArcadeError(err?.message ?? "The wallet did not connect.", err?.code ?? "NO_WALLET");
  });
  return out.address;
}

export interface TransferExpectation {
  /** lamports the player asked to move */
  lamports?: number;
  /** custody address shown on screen */
  to?: string;
}

export async function approveTransfer(
  provider: ArcadeProvider | null,
  prepared: PreparedDeposit | string,
  expect?: TransferExpectation,
): Promise<string> {
  const prep = typeof prepared === "string" ? ({ message: prepared } as PreparedDeposit) : prepared;

  // The bytes came over the wire from the arcade; the player asked for a
  // specific amount to a specific address. Never let the wallet popup be the
  // only thing that checks. A hostile or compromised custody edge cannot move
  // a signed cent more than was asked, because nothing is signed before these
  // hold.
  if (expect?.lamports !== undefined && Number(prep.lamports) !== expect.lamports) {
    throw new ArcadeError(
      `The arcade built a transfer of ${sol(Number(prep.lamports))} ◎ but you asked for `
        + `${sol(expect.lamports)} ◎. Nothing was signed — reload and try again.`,
      "AMOUNT_MISMATCH",
    );
  }
  if (expect?.to !== undefined && prep.to !== expect.to) {
    const short = (a: string | undefined): string =>
      a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "(none)";
    throw new ArcadeError(
      `The arcade built this transfer to ${short(prep.to)}, not the custody address `
        + `${short(expect.to)} shown on screen. Nothing was signed.`,
      "DESTINATION_MISMATCH",
    );
  }

  if (provider?.isDeeplink && typeof provider.deposit === "function") {
    await provider.deposit(prep);
    return new Promise<string>(() => {});
  }

  if (typeof provider?.request !== "function") {
    throw new ArcadeError("This wallet cannot send a transaction from a page.", "NO_TX_API");
  }

  let active = provider.publicKey?.toString?.() ?? null;
  if (!active) {
    try {
      const got = await provider.connect();
      active = (got?.publicKey ?? provider.publicKey)?.toString?.() ?? null;
    } catch (err) {
      if ((err as { code?: number })?.code === 4001) {
        throw new ArcadeError("Cancelled. Nothing was sent.", "CANCELLED");
      }
      throw err;
    }
  }
  if (active && prep.from && active !== prep.from) {
    throw new ArcadeError(
      `Your wallet is on ${active.slice(0, 4)}..${active.slice(-4)} but the arcade knows you as `
      + `${prep.from.slice(0, 4)}..${prep.from.slice(-4)}. Switch back in the wallet, or reconnect first.`,
      "WRONG_ACCOUNT",
    );
  }

  const forms = (provider.arcadeAccepts === "base64"
    ? [prep.transactionBase64]
    : [prep.transaction, prep.message]).filter(Boolean) as string[];
  if (!forms.length) {
    throw new ArcadeError("The arcade did not send anything to approve.", "NO_TX_API");
  }

  let out: unknown;
  let firstError: unknown = null;
  for (const form of forms) {
    try {
      out = await provider.request({ method: "signAndSendTransaction", params: { message: form } });
      firstError = null;
      break;
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message ?? ""))) {
        throw new ArcadeError("Cancelled. Nothing was sent.", "CANCELLED");
      }
      if (e?.code === -32601
        || /unsupported|not supported|unknown method|invalid method/i.test(String(e?.message ?? ""))) {
        throw new ArcadeError("This wallet cannot send a transaction from a page.", "NO_TX_API");
      }
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;

  const signature = typeof out === "string" ? out : (out as { signature?: string })?.signature;
  if (!signature) throw new ArcadeError("The wallet approved it but gave back no transaction id.", "NO_SIG");
  return String(signature);
}

export function sol(lamports: number | null | undefined, dp = 9): string {
  const n = Number(lamports ?? 0) / LAMPORTS;
  return n.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
}

export function toLamports(text: string): number | null {
  const s = String(text ?? "").trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 9) return null;
  const n = Number(whole || "0") * LAMPORTS + Number((frac + "000000000").slice(0, 9));
  return Number.isSafeInteger(n) ? n : null;
}

export function explorerUrl(signature: string, network?: string | null): string {
  const q = network && network !== "mainnet" ? `?cluster=${encodeURIComponent(network)}` : "";
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${q}`;
}

export interface DepositInfo {
  address: string;
  network: string | null;
  minWithdrawal: number;
  networkFee: number;
  warning: string;
}

export interface LedgerBalance {
  wallet: string;
  balance: number;
  held: number;
}

export interface ChainBalance {
  wallet: string;
  lamports: number;
  fee: number;
  spendable: number;
}

export interface Movement {
  kind: "in" | "out";
  at: number;
  amount: number;
  signature: string | null;
  id: string;
  state: string;
}

export interface CustodyHistory {
  rows?: Movement[];
  total?: number;
  page?: number;
  pages?: number;
  perPage?: number;
  kind?: "in" | "out" | null;
  pending?: number;
  summary?: {
    deposited: number;
    withdrawn: number;
    fees: number;
    onTable: number;
    inHouse: number;
    net: number;
  };
  deposits?: Array<{ at: number; lamports: number; signature: string }>;
  withdrawals?: Array<{ at: number; sent: number; signature: string | null; state: string }>;
}

export interface GamePosition {
  wallet: string;
  game: string;
  wagered: number;
  rounds: number;
  returned: number;
  refunded: number;
  inPlay: number;
  openRounds: number;
  net: number;
}

export interface WithdrawReceipt {
  ref: string;
  state: string;
  signature: string | null;
  debited: number;
  receiving: number;
  fee: number;
}

export interface PreparedDeposit {
  from: string;
  to: string;
  lamports: number;
  network: string | null;
  message: string;
  transaction?: string;
  transactionBase64?: string;
}
