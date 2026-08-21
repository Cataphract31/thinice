import { readFileSync } from "node:fs";

const GAME = "thin-ice";

const DEFAULT_URL = "http://127.0.0.1:8080";

function loadKeyFile(): string {
  const path = process.env.LEDGER_KEY_FILE ?? "";
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(`LEDGER_KEY_FILE is set but could not be read: ${(err as Error).message}`);
  }
}

export class LedgerError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.status = status;
  }
  get isBroke(): boolean {
    return this.code === "INSUFFICIENT_FUNDS";
  }
}

export interface HoldResult {
  ref: string;
  amount: number;
  state: string;
  replayed: boolean;
  freeLamports: number;
  heldLamports: number;
}

type Fetch = typeof globalThis.fetch;

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export function createArcadeLedger({
  url = process.env.ARCADE_LEDGER_URL ?? DEFAULT_URL,
  key = process.env.LEDGER_KEY ?? loadKeyFile(),
  fetchImpl = globalThis.fetch as Fetch,
  timeoutMs = 5000,
}: {
  url?: string;
  key?: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
} = {}) {
  const base = url.replace(/\/+$/, "");

  if (key && !isLoopback(base)) {
    throw new Error(
      `refusing to send LEDGER_KEY to ${base}: the service key may only travel over the loopback`,
    );
  }

  const enabled = key !== "";

  async function post(
    route: string,
    body: Record<string, unknown>,
    family: "ledger" | "exposure" = "ledger",
  ): Promise<any> {
    if (!enabled) {
      throw new LedgerError(
        "LEDGER_CLOSED",
        "this server has no LEDGER_KEY, so no stake can be taken",
        503,
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/${family}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ledger-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LedgerError(
        "LEDGER_UNREACHABLE",
        `could not reach the arcade ledger at ${base}: ${(err as Error).message}`,
        503,
      );
    }

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new LedgerError(
        "LEDGER_GARBAGE",
        `the ledger answered with ${res.status} and not JSON`,
        res.ok ? 502 : res.status,
      );
    }

    if (!res.ok) {
      const e = parsed?.error ?? {};
      throw new LedgerError(e.code ?? "LEDGER_REFUSED", e.message ?? `ledger said ${res.status}`, res.status);
    }
    return parsed;
  }

  const refFor = (roundId: number, seat: number): string => `${GAME}:r${roundId}:s${seat}`;

  async function get(route: string, params: Record<string, string>): Promise<any> {
    if (!enabled) throw new LedgerError("LEDGER_CLOSED", "this server has no LEDGER_KEY", 503);
    const q = new URLSearchParams(params).toString();
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/ledger/${route}?${q}`, {
        headers: { "x-ledger-key": key },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LedgerError("LEDGER_UNREACHABLE", `could not reach the arcade ledger: ${(err as Error).message}`, 503);
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = parsed?.error ?? {};
      throw new LedgerError(e.code ?? "LEDGER_REFUSED", e.message ?? `ledger said ${res.status}`, res.status);
    }
    return parsed;
  }

  return {
    enabled,
    refFor,

    async balanceOf(wallet: string): Promise<{ freeLamports: number; heldLamports: number }> {
      const r = await get("balance", { wallet });
      return { freeLamports: Number(r.balance ?? 0), heldLamports: Number(r.held ?? 0) };
    },

    async hold(
      wallet: string,
      amountLamports: number,
      roundId: number,
      seat: number,
    ): Promise<HoldResult> {
      const r = await post("hold", {
        wallet,
        amount: amountLamports,
        ref: refFor(roundId, seat),
        game: GAME,
        memo: `round ${roundId} seat ${seat}`,
      });
      return {
        ref: r.ref,
        amount: r.amount,
        state: r.state,
        replayed: Boolean(r.replayed),
        freeLamports: Number(r.balance ?? 0),
        heldLamports: Number(r.held ?? 0),
      };
    },

    async settle(roundId: number, seat: number, payoutLamports: number): Promise<void> {
      await post("settle", {
        ref: refFor(roundId, seat),
        payout: payoutLamports,
        memo: `round ${roundId} seat ${seat}`,
      });
    },

    async release(roundId: number, seat: number, why = "round abandoned"): Promise<void> {
      await post("release", { ref: refFor(roundId, seat), memo: why });
    },

    async sweep(): Promise<number> {
      const r = await post("sweep", { game: GAME });
      return Number(r.released ?? 0);
    },

    exposure: {
      async reserve(roundId: number, worstCaseLamports: number): Promise<void> {
        await post(
          "reserve",
          { game: GAME, round: String(roundId), amount: String(Math.max(0, Math.floor(worstCaseLamports))) },
          "exposure",
        );
      },

      async release(roundId: number): Promise<void> {
        await post("release", { game: GAME, round: String(roundId) }, "exposure");
      },

      async sweep(): Promise<number> {
        const r = await post("sweep", { game: GAME }, "exposure");
        return Number(r.dropped ?? 0);
      },
    },
  };
}

export type ArcadeLedger = ReturnType<typeof createArcadeLedger>;
