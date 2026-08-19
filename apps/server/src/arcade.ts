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

  /*
   * `family` IS THE ARCADE SURFACE BEING SPOKEN TO, AND THERE ARE TWO.
   *
   * `ledger` is the books -- holds, settlements, balances -- and is what every
   * call in this file meant when the path was hardcoded. `exposure` is the
   * box-wide register of what is promised to rounds still in flight, which
   * games mounted inside the arcade process join by holding an object and a
   * game in its own process joins through a door. See
   * arcade/money/exposure-routes.js.
   *
   * One function for both, because everything that makes the call safe is the
   * same either way: the key, the loopback guard, the timeout, failing closed,
   * and turning an arcade error body into a LedgerError somebody can act on.
   * The only difference is the path.
   */
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
      // The STATUS survives even when the body does not. An arcade that has
      // never heard of a route answers 404 with whatever its fallback handler
      // writes, and a caller that has to tell "no such route" from "the route
      // failed" needs that number rather than a flat 502.
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

  /** A GET behind the same service key. Reads never decide; see the header. */
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

    /**
     * Where a wallet stands, FOR THE SCREEN ONLY.
     *
     * Nothing in this game decides anything from this number -- `hold` is the
     * check, atomically, where the money is. This exists because the state
     * frame shows a balance and there is no longer a local column to read it
     * from.
     */
    async balanceOf(wallet: string): Promise<{ freeLamports: number; heldLamports: number }> {
      const r = await get("balance", { wallet });
      return { freeLamports: Number(r.balance ?? 0), heldLamports: Number(r.held ?? 0) };
    },

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
     *
     * The game is NAMED, and the arcade now requires it: one shared LEDGER_KEY
     * means no caller can prove its identity on the wire, so an unnamed sweep
     * would be one game handing back every other game's stakes.
     */
    async sweep(): Promise<number> {
      const r = await post("sweep", { game: GAME });
      return Number(r.released ?? 0);
    },

    /*
     * ── THE BOX-WIDE EXPOSURE REGISTER ──────────────────────────────────
     *
     * A second surface on the same arcade, reached the same way. What it holds
     * is one number: how much of `~house` is promised to rounds that have not
     * finished, across every table on this box at once.
     *
     * WHY A SELF-FUNDING GAME IS IN IT AT ALL. Thin Ice pays its pot out of the
     * entrants' own stakes, so in the ordinary round the house is promised
     * nothing and the register would be right to show zero. The recovery paths
     * are where that stops being true: if holds are released while a payout has
     * already been made, `ledger.settle` funds the difference from `~house`
     * with `overdraft: true`. That is real house exposure, it is invisible
     * until the day it happens, and the operator deciding whether a payout is
     * still owed consults exactly this total.
     *
     * NOTHING HERE MOVES A LAMPORT. A reservation is a promise about room, not
     * money; the money is `hold` and `settle` above.
     */
    exposure: {
      /**
       * Ask the box for room for one round's worst case.
       *
       * REFUSED BY THE ARCADE, NOT BY US. Two games asking at the same moment
       * would both pass their own check, so the question and the answer happen
       * in one call on the side that can see everybody. A refusal arrives as a
       * LedgerError with code `OVER_ARCADE_EXPOSURE`.
       *
       * The amount goes over as a decimal STRING: it is BigInt lamports on the
       * arcade's side and JSON has no BigInt, so a string survives the trip
       * exactly where a Number is a rounding mode waiting to happen.
       */
      async reserve(roundId: number, worstCaseLamports: number): Promise<void> {
        await post(
          "reserve",
          { game: GAME, round: String(roundId), amount: String(Math.max(0, Math.floor(worstCaseLamports))) },
          "exposure",
        );
      },

      /** Give the room back. Idempotent on the arcade's side. */
      async release(roundId: number): Promise<void> {
        await post("release", { game: GAME, round: String(roundId) }, "exposure");
      },

      /**
       * Drop every row this game is holding.
       *
       * BOOT ONLY, and AFTER the hold sweep above -- the arcade refuses this
       * with 409 ROUNDS_IN_FLIGHT while this game still has a stake in escrow,
       * on the reasoning that one shared service key means the books have to
       * stand in for identity: a live hold is proof of a live round. So the
       * order is not a preference, it is the only order that works.
       *
       * A mounted table's reservations die with the arcade process because they
       * ARE that process; ours outlive us, so without this a crash would leave
       * the box believing it owes payouts for rounds that no longer exist,
       * shrinking every other table's headroom with nothing alive to put it
       * back.
       */
      async sweep(): Promise<number> {
        const r = await post("sweep", { game: GAME }, "exposure");
        return Number(r.dropped ?? 0);
      },
    },
  };
}

export type ArcadeLedger = ReturnType<typeof createArcadeLedger>;
