/*
 * THE ARCADE'S BOOKS, REACHED OVER HTTP.
 *
 * THIN ICE USED TO KEEP ITS OWN BALANCE, in a `players.balance` column moved by
 * `UPDATE players SET balance = balance + ?`. That is a single-sided ledger, and
 * a single-sided ledger can drift for months with no symptom until one day the
 * numbers are wrong and nobody can say when they started being wrong, by how
 * much, or who is owed it. Worse, it was one of SIX ideas of what a player owns
 * across this arcade -- win here and the money was not there at Barrows,
 * because there was no "there".
 *
 * There is one now, and this file is how this game reaches it. Every lamport
 * moves as a double-entry row in arcade/money/ledger.js, where the sum of all
 * accounts is always exactly zero by arithmetic rather than by hope.
 *
 * WHAT THIS GAME MAY DO WITH MONEY, IN FULL: hold a stake, settle it, give it
 * back. Three verbs. It cannot credit, cannot debit, cannot mint, and holds no
 * key material for any wallet -- the arcade's custody edge is the only place
 * money enters or leaves, and it is not here. The worst bug reachable from this
 * file is a mispriced round, never a signed transfer.
 *
 * IT NEVER READS A BALANCE TO DECIDE ANYTHING, and that is deliberate rather
 * than an omission. `hold` fails with INSUFFICIENT_FUNDS if the money is not
 * there, atomically, inside the ledger's own transaction. Reading a balance and
 * then deciding is the classic two-step that races: between the read and the
 * hold, the same wallet can stake in another game on this box. So the check IS
 * the hold, and the balance that comes back with it is for the screen only.
 *
 * THE KEY STAYS ON THE LOOPBACK. LEDGER_KEY is what a game server proves itself
 * with, and it is the whole authority to move anybody's money on this box. The
 * arcade runs on the same machine as this process, so the request never leaves
 * it -- and this file refuses to send the key anywhere else, because a service
 * key posted to a public origin is a compromise that looks exactly like normal
 * traffic.
 *
 * FAILURE IS CLOSED. If the ledger cannot be reached, a stake is NOT taken and
 * the seat is NOT sold: the caller gets an error and the player keeps their
 * money. The opposite bargain -- seat now, reconcile later -- is how a game
 * ends up owing a settlement it never took payment for.
 */

/** What the ledger calls this game in every row it writes. */
const GAME = "thin-ice";

/** Where the books live. Loopback, because LEDGER_KEY travels with the request. */
const DEFAULT_URL = "http://127.0.0.1:8080";

export class LedgerError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.status = status;
  }
  /** The one failure a caller acts on differently: the player cannot cover it. */
  get isBroke(): boolean {
    return this.code === "INSUFFICIENT_FUNDS";
  }
}

export interface HoldResult {
  ref: string;
  amount: number;
  state: string;
  replayed: boolean;
  /**
   * The wallet AFTER the move, for display and nothing else.
   *
   * `free` is spendable; `held` is staked in rounds that have not settled yet,
   * across every game on this box. They are reported separately on purpose --
   * a player whose money is sitting in an unsettled round is not broke, and a
   * screen that shows only the spendable half says they are.
   */
  freeLamports: number;
  heldLamports: number;
}

type Fetch = typeof globalThis.fetch;

/**
 * Is this URL on the loopback?
 *
 * Checked rather than assumed, because the cost of getting it wrong is posting
 * the service key to somebody else's server, and the mistake would look like a
 * config typo rather than a breach.
 */
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
  key = process.env.LEDGER_KEY ?? "",
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

  /** Is the ledger wired up at all? False means this box cannot take stakes. */
  const enabled = key !== "";

  async function post(route: string, body: Record<string, unknown>): Promise<any> {
    if (!enabled) {
      throw new LedgerError(
        "LEDGER_CLOSED",
        "this server has no LEDGER_KEY, so no stake can be taken",
        503,
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/ledger/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ledger-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Unreachable, refused, or too slow. Fail closed: the caller must not
      // seat anybody on the strength of a request that never arrived.
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
      throw new LedgerError("LEDGER_GARBAGE", `the ledger answered with ${res.status} and not JSON`, 502);
    }

    if (!res.ok) {
      const e = parsed?.error ?? {};
      throw new LedgerError(e.code ?? "LEDGER_REFUSED", e.message ?? `ledger said ${res.status}`, res.status);
    }
    return parsed;
  }

  /**
   * The ref for one seat's money, and the reason it looks like this.
   *
   * Every mutating ledger call carries a ref the caller chooses, unique
   * forever, and asking twice with the same ref returns the first answer
   * instead of moving money twice. That is what makes this safe over HTTP,
   * which retries, and safe across a crash, which replays.
   *
   * A round id and a seat number identify exactly one stake for all time, so
   * the flush at the end of a round can be re-run as many times as it takes
   * without paying anybody twice.
   */
  const refFor = (roundId: number, seat: number): string => `${GAME}:r${roundId}:s${seat}`;

  return {
    enabled,
    refFor,

    /**
     * Take a stake into escrow. Throws LedgerError; `isBroke` means exactly
     * that the player cannot cover it, which is a normal answer and not a fault.
     */
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

    /**
     * Settle a stake at what it actually returned.
     *
     * A payout of 0 is a total loss and is a normal settlement, not a release:
     * the stake was played and lost, and the books should say so.
     */
    async settle(roundId: number, seat: number, payoutLamports: number): Promise<void> {
      await post("settle", {
        ref: refFor(roundId, seat),
        payout: payoutLamports,
        memo: `round ${roundId} seat ${seat}`,
      });
    },

    /** Give a stake back untouched: the round never happened. Idempotent. */
    async release(roundId: number, seat: number, why = "round abandoned"): Promise<void> {
      await post("release", { ref: refFor(roundId, seat), memo: why });
    },

    /**
     * Release every hold this game still has open.
     *
     * For startup after a crash: holds outlive the process that made them,
     * which is the point of holds, and money in flight is the only money a
     * crash can lose.
     */
    async sweep(): Promise<number> {
      const r = await post("sweep", { game: GAME });
      return Number(r.released ?? 0);
    },
  };
}

export type ArcadeLedger = ReturnType<typeof createArcadeLedger>;
