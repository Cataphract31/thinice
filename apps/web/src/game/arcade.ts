/**
 * THE ARCADE'S MONEY EDGE, FROM THIS CLIENT.
 *
 * This game holds no key, opens no RPC connection and signs nothing — see the
 * header of apps/server/src/arcade.ts for the long argument. Money enters and
 * leaves at ONE door, the arcade's custody edge, and this file is how the
 * browser knocks on it: read a balance, ask for the bytes of a deposit, ask
 * for a withdrawal. Every one of those is an HTTP call to a box that already
 * had tests before this file existed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS BUILD A TRANSACTION. A System Program
 * transfer is sixty bytes in one exact order, and the arcade already holds the
 * single tested implementation of it — the same function its withdrawal signer
 * builds against. A second implementation, in a browser, is the worst possible
 * place for the one piece of code that decides where money goes. So the bytes
 * come from `/api/custody/deposit/prepare` and this file's whole contribution
 * is handing them to the wallet.
 *
 * AND IT NEVER NAMES A DESTINATION. There is no field for one, in either
 * direction: a deposit's `to` is custody's own address and a withdrawal's
 * payee is whatever wallet the session proved. That is what makes a stolen
 * session worth nothing but griefing.
 */

/** The session the arcade minted, shared across every world on this domain. */
const SESSION_COOKIE = "zinc_session";
/** The family of hosts this arcade lives on. */
import {
  connect as arcadeConnect,
  ensureProvider,
  findProvider,
  type ArcadeProvider,
  type FoundProvider,
} from "@/arcade/wallet.js";

/*
 * THE HANDSHAKE IS NOT WRITTEN HERE ANY MORE.
 *
 * Provider discovery, the sign-in ceremony and everything a phone needs to
 * reach a wallet app live once, in src/arcade/wallet.js -- a verbatim copy of
 * the arcade's own, fetched by scripts/sync-arcade.mjs. What was here was a
 * sixth hand-written copy of the same four steps, and the cost was not
 * tidiness: this game looked for an INJECTED provider and nothing else, so a
 * player in Safari or Chrome on a phone was told to install an extension that
 * cannot exist there. Every other table in the arcade could take their money
 * and this one could not.
 *
 * WHAT STAYS HERE is everything about the BOOKS rather than the wallet:
 * arcadeApi and its errors, the session cookie this game reads, the ledger
 * types, and the deposit approval below.
 */
export { completeDeeplink, onDepositArrival, walletRoute } from "@/arcade/wallet.js";
export type { ArcadeProvider, FoundProvider } from "@/arcade/wallet.js";

export const SHARED_DOMAIN = ".voidsolana.com";

export const LAMPORTS = 1_000_000_000;

/**
 * WHAT THE ARCADE'S BOOKS CALL THIS GAME.
 *
 * The same string the server writes into every ledger row it moves (see GAME
 * in apps/server/src/arcade.ts). It is spelled here too because the panel asks
 * the books a question about ONE game and the name is the question: a
 * near-miss would answer with somebody else's table rather than with nothing,
 * which is the failure that looks like data.
 */
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

/**
 * The arcade's proof of who you are, or null.
 *
 * Shape-checked before it is ever sent: a truncated or mangled cookie should
 * read as "signed out" rather than as an Authorization header the box has to
 * refuse on every call.
 */
export function arcadeToken(): string | null {
  const raw = cookie(SESSION_COOKIE);
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

/** Forget a rejected arcade session, everywhere it is read. */
export function clearArcade(): void {
  if (!onArcadeDomain()) return;
  document.cookie =
    `${SESSION_COOKIE}=; Domain=${SHARED_DOMAIN}; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}


/**
 * WHERE THE ARCADE'S API IS, FROM HERE.
 *
 * This page is static and its API is not: the client is served from Vercel and
 * every route that knows anything runs on the box. Same arrangement as the
 * game socket, and the same shape CURSORS.EXE uses from its own folder on this
 * origin — which is the reason to go DIRECT rather than through the portal's
 * /api/* proxy. Both work; only one of them is already carrying signed custody
 * traffic in production, and money is a poor place to be the first caller down
 * a new road.
 *
 * The cost is one entry in the box's ALLOWED_ORIGINS, which the two voidsolana
 * hosts already have. Localhost is exempt by hostname so a local run does not
 * sign in against production, and `?arcade=` overrides it for one load.
 */
const ARCADE = (import.meta.env.VITE_ARCADE_URL as string | undefined) ?? "";

/*
 * THE OVERRIDE IS A LOCAL-ONLY TOOL, and that is a money decision.
 *
 * `?arcade=` used to be honoured on ANY host. That made one link a way to
 * point somebody else's session at a server of the sender's choosing: the
 * page would ask it for a sign-in challenge and, worse, ask it to PREPARE A
 * DEPOSIT -- and a prepare is what decides the destination of the transfer the
 * wallet is about to be asked to approve. A crafted link therefore ended with
 * the player's own wallet popping up a transfer to the attacker's address.
 * The wallet does render that address truthfully, which is the last line of
 * defence and the only one there was; a flow whose whole design teaches people
 * to press Approve should not be leaning on it.
 *
 * It is honoured on localhost only, which is where the workflow it exists for
 * actually happens. arcade/web/origin.js in the arcade repo made this same
 * change for the same reason and its note is the longer version.
 */
export function arcadeUrl(path: string): string {
  try {
    const local = /^(localhost|127\.)/.test(location.hostname);
    if (local) {
      const q = new URLSearchParams(location.search).get("arcade");
      if (q) return q.replace(/\/+$/, "") + path;
      return path;
    }
  } catch {
    /* no location; fall through to the deployed box */
  }
  return ARCADE.replace(/\/+$/, "") + path;
}

export class ArcadeError extends Error {
  code: string;
  status: number;
  /**
   * WHETHER AN ANSWER WAS RECEIVED AND UNDERSTOOD. False means the request may
   * or may not have been carried out, and no caller may claim otherwise. See
   * UNTOUCHED in Bank.tsx, which is what this exists for.
   */
  answered: boolean;
  constructor(message: string, code = "ARCADE_ERROR", status = 0, answered = false) {
    super(message);
    this.name = "ArcadeError";
    this.code = code;
    this.status = status;
    this.answered = answered;
  }
}

/*
 * HOW LONG A CALL WAITS. fetch() has no deadline of its own, and without one
 * there is no moment at which a panel HAS to admit it does not know what
 * happened. Two numbers: a read is repeated by the poll and may give up
 * quickly, while a withdrawal waits on a signer on another machine whose own
 * worst case is over a minute.
 */
export const READ_MS = 15_000;
export const MOVE_MS = 60_000;

/** One call to the arcade, with the session attached if there is one. */
export async function arcadeApi<T>(
  path: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = READ_MS, ...init } = opts;
  const token = arcadeToken();
  /* AbortController rather than AbortSignal.timeout(): the timer is cleared on
     the way out, so a panel left open is not also leaving a pending timeout
     behind for every poll it ever ran. */
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
    // Aborted, unreachable, refused, or blocked by the browser's own
    // cross-origin rules. They look identical from here, and NONE of them says
    // whether the box acted on the request -- which is why answered stays
    // false. It is not "nothing happened"; it is "we do not know".
    throw new ArcadeError(
      stop.signal.aborted
        ? "The arcade did not answer in time."
        : `Could not reach the arcade. ${(err as Error).message}`,
      stop.signal.aborted ? "TIMEOUT" : "UNREACHABLE",
    );
  } finally {
    clearTimeout(bell);
  }

  /* A BODY IS JSON BECAUSE THE HEADER SAYS SO. Anything else is somebody
     between the browser and the box -- a proxy's error page, a captive portal,
     a CDN -- and its contents are not a message from the arcade. */
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
    // A status from the box is an answer even when the body was junk; what
    // makes it useful is the code, and UNTOUCHED checks for that.
    throw new ArcadeError(e.message ?? `The arcade said ${res.status}.`, e.code ?? "REFUSED", res.status, true);
  }
  if (!isJson) {
    throw new ArcadeError("The arcade answered with something that was not an answer.", "GARBAGE", res.status);
  }
  return parsed as T;
}

// ---------------------------------------------------------------- the wallet

/** The slice of an injected Solana provider anything here touches. */
export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage?(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  request?(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * The injected providers, in the order a page should prefer them.
 *
 * Wider than the game's own connect button, which only ever spoke to Phantom.
 * That is deliberate: money is the one place where "this browser has a wallet
 * we do not recognise" should not be the end of the conversation.
 */
export function walletProvider(): FoundProvider | null {
  return findProvider();
}

/**
 * THE PROVIDER INCLUDING THE ONE THAT IS NOT IN THE PAGE.
 *
 * walletProvider() above is synchronous and therefore injected-only, which is
 * what a render pass wants -- it answers "what shall I call this wallet" with
 * no awaiting. Anything about to MOVE MONEY wants this instead: on a phone it
 * resolves to the wallet app the player already signed in with, and on a
 * desktop it is the same lookup costing one extra tick.
 */
export async function walletNow(): Promise<FoundProvider | null> {
  return ensureProvider();
}

/**
 * Prove ownership of a wallet to the ARCADE, and keep the session.
 *
 * This is not the game's own sign-in. The game seats a player on a token its
 * own server minted; the arcade's books answer to a token the arcade minted,
 * and only the second one can read a balance or move money at the custody
 * edge. A player who signed in at the portal already has one and never sees
 * this. A player who walked straight in here does, once.
 *
 * The wallet signs exactly what the issuer said, byte for byte. Rebuilding
 * the sentence on this side would be the one thing that must never disagree,
 * and a signature over slightly different bytes verifies against nothing.
 */
export async function arcadeSignIn(): Promise<string> {
  /*
   * ONE PRESS, WHATEVER THIS BROWSER IS.
   *
   * On a desktop this is the connect popup and a signature. On a phone with
   * nothing injected it offers the wallet apps and then NAVIGATES: this tab is
   * replaced, the wallet opens, and the player returns to a fresh load where
   * completeDeeplink() finishes the job. So this promise may never settle, and
   * a caller must not read that as a failure -- there is nothing left to fail
   * on a page that no longer exists.
   *
   * The address is recorded by the CALLER, through setWalletOptIn in
   * game/net.ts, which writes the arcade-wide cookie and this game's own flag
   * together. Two writers of one cookie is how they drift apart.
   */
  const out = await arcadeConnect().catch((err: { code?: string; message?: string }) => {
    // The shared wallet throws plain Errors carrying the same codes this app
    // already uses; rewrapping keeps one error type reaching the panel.
    throw new ArcadeError(err?.message ?? "The wallet did not connect.", err?.code ?? "NO_WALLET");
  });
  return out.address;
}

/**
 * APPROVE AND BROADCAST A TRANSFER THE ARCADE BUILT. The one call in this file
 * that moves money.
 *
 * WHAT STOPS THIS BEING "SIGN WHATEVER THE SERVER SENDS", which is the shape
 * of every drainer. Two things, and neither is trust in the server:
 *
 *   1. The WALLET decodes the transaction and shows what it does, who is paid
 *      and how much, before anybody presses anything. That readout is rendered
 *      by the wallet, so a lying arcade would be lying in a box it does not
 *      control.
 *   2. The arcade's own route will not build anything else: `to` is custody's
 *      address and `from` is the wallet the session proved. There is no
 *      destination field to poison.
 *
 * ONE METHOD, NO ADAPTER. `request({ method: "signAndSendTransaction" })` is
 * the injected-provider RPC underneath every wallet adapter, and taking it
 * directly is what keeps @solana/web3.js out of a bundle that has two runtime
 * dependencies. A wallet that will not answer it gets NO_TX_API and the panel
 * falls back to showing the address, which is how every deposit in this arcade
 * worked until now.
 *
 * TWO ENCODINGS, TRIED IN ORDER. Phantom deserialises a TRANSACTION from the
 * parameter its own documentation calls `message`, so sending the documented
 * base58 message failed a real deposit with "Reached end of buffer
 * unexpectedly". The box publishes both forms and this tries the transaction
 * first; `transaction` is absent on an older box, and then this is the
 * single-form call it always was. See prepareDeposit in the arcade's
 * custody.js for the bytes and how they were checked.
 *
 * A REFUSAL MUST NOT BE RETRIED: a form the wallet cannot deserialise fails
 * before any dialog appears, so falling back shows the player nothing, but
 * somebody who said no must not be asked again in another encoding.
 */
export async function approveTransfer(
  provider: ArcadeProvider | null,
  prepared: PreparedDeposit | string,
): Promise<string> {
  const prep = typeof prepared === "string" ? ({ message: prepared } as PreparedDeposit) : prepared;

  /*
   * A PHONE LEAVES THE PAGE HERE, AND DOES NOT COME BACK TO THIS FUNCTION.
   *
   * On a phone the wallet is another app reachable only by a link, so
   * approving is a NAVIGATION: this tab is destroyed, the wallet opens, and
   * the player returns to a fresh load carrying the signed transaction in its
   * query string. completeDeeplink() picks it up and hands the outcome to
   * whoever registered with onDepositArrival, which is the wallet panel.
   *
   * So the promise below never settles, on purpose: there is nothing to return
   * to a caller about to stop existing, and resolving with something falsy
   * would paint a failure half a second before the page went away.
   */
  if (provider?.isDeeplink && typeof provider.deposit === "function") {
    await provider.deposit(prep);
    return new Promise<string>(() => {});
  }

  if (typeof provider?.request !== "function") {
    throw new ArcadeError("This wallet cannot send a transaction from a page.", "NO_TX_API");
  }

  /*
   * THE EXTENSION MAY HAVE MOVED WHILE THE SESSION DID NOT.
   *
   * The transfer the box built pays FROM one exact account -- the wallet the
   * session proved -- so an extension standing on another one produces a
   * refusal deep inside the wallet that reads to a player as "the game is
   * broken". Caught here, where there is room to say which of the two moved.
   */
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

  /* Which encoding this wallet takes, asked rather than sniffed: a provider
     that wants raw bytes says so itself, and the box publishes the identical
     transaction in base64 for it. Nothing sets this yet -- it is what the
     Android Mobile Wallet Adapter path will set when it lands. */
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
      // 4001 is the number every wallet reuses for "the person said no". Not an
      // error worth a red line, and not a thing to ask again in another form.
      if (e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message ?? ""))) {
        throw new ArcadeError("Cancelled. Nothing was sent.", "CANCELLED");
      }
      // A wallet that does not do this at all will not do it in either form.
      // -32601 is JSON-RPC "no such method"; some wallets say it in words.
      if (e?.code === -32601
        || /unsupported|not supported|unknown method|invalid method/i.test(String(e?.message ?? ""))) {
        throw new ArcadeError("This wallet cannot send a transaction from a page.", "NO_TX_API");
      }
      // Anything else is worth trying the other encoding for. The FIRST failure
      // is the one reported if both fail, because it is the one about the form
      // the wallet was most likely to accept.
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;

  const signature = typeof out === "string" ? out : (out as { signature?: string })?.signature;
  if (!signature) throw new ArcadeError("The wallet approved it but gave back no transaction id.", "NO_SIG");
  return String(signature);
}

// ------------------------------------------------------------------ numbers

/**
 * Lamports as a number of SOL a person would actually write.
 *
 * NINE PLACES BY DEFAULT, WHICH IS EXACT, and the default matters twice. A
 * network fee is five thousand lamports, so anything coarser prints the fee
 * a player is about to pay as "0". And MAX is built by running a balance
 * through here and back: at four places `toFixed` ROUNDS, so a max of
 * 1.2048750 comes back as 1.2049, which is more money than they have, and the
 * transaction fails for insufficient funds after the wallet popup.
 *
 * Trailing zeros are stripped, but never past the point: 0.5 rather than
 * 0.500000000, and 1 rather than 1 with a hanging dot.
 */
export function sol(lamports: number | null | undefined, dp = 9): string {
  const n = Number(lamports ?? 0) / LAMPORTS;
  return n.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A typed amount of SOL as whole lamports, or null if it is not one.
 *
 * Deliberately NOT `Math.round(parseFloat(x) * 1e9)`. 0.1 + 0.2 is the oldest
 * joke in the language and this is somebody's money: parseFloat("4.35") * 1e9
 * is 4349999999.999999, and rounding hides it right up until the amount that
 * rounds the wrong way. The decimal string is split and the halves are made
 * whole separately, so nothing is ever a fraction.
 */
export function toLamports(text: string): number | null {
  const s = String(text ?? "").trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 9) return null;
  const n = Number(whole || "0") * LAMPORTS + Number((frac + "000000000").slice(0, 9));
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Which chain the box is pointed at, so a receipt links somewhere real.
 *
 * The box tells us; it is never guessed from this side. A mainnet link for a
 * devnet signature shows "not found", which reads as a lost deposit rather
 * than as a wrong link.
 */
export function explorerUrl(signature: string, network?: string | null): string {
  const q = network && network !== "mainnet" ? `?cluster=${encodeURIComponent(network)}` : "";
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${q}`;
}

// -------------------------------------------------------------- the shapes

export interface DepositInfo {
  address: string;
  network: string | null;
  minWithdrawal: number;
  networkFee: number;
  warning: string;
}

export interface LedgerBalance {
  wallet: string;
  /** Spendable. */
  balance: number;
  /** Staked in a round somewhere in the arcade, not lost and not spendable. */
  held: number;
}

export interface ChainBalance {
  wallet: string;
  lamports: number;
  fee: number;
  /** What can actually be sent: the fee comes out of the same pocket. */
  spendable: number;
}

/** One movement through the custody edge, in either direction. */
export interface Movement {
  /** Which way the money went: `in` is a deposit, `out` a withdrawal. */
  kind: "in" | "out";
  at: number;
  amount: number;
  signature: string | null;
  /** The signature for a deposit, the withdrawal's ref for a withdrawal. */
  id: string;
  /** `confirmed`, `confirming`, `reversed`, or whatever the signer last said. */
  state: string;
}

/**
 * ONE PAGE OF ONE DIRECTION, and the arithmetic that goes above it.
 *
 * PAGED BY THE BOX, NOT SLICED HERE. `page`, `pages` and `total` come back
 * from the server having been clamped there, so the pager draws the numbers it
 * was GIVEN rather than the ones it asked for and cannot disagree with the
 * list underneath it.
 *
 * `deposits` and `withdrawals` are the shape this panel used to read. They are
 * still sent by the box and still accepted here, because the two halves of
 * this site deploy separately: for the length of that gap a page and the
 * server it is talking to are different versions of the same file, in
 * whichever direction happens to be ahead, and a money screen that answers a
 * version skew with an empty panel is the worst possible way to fail.
 */
export interface CustodyHistory {
  rows?: Movement[];
  total?: number;
  page?: number;
  pages?: number;
  perPage?: number;
  kind?: "in" | "out" | null;
  /** Balance resting on a deposit the chain has not finalised. */
  pending?: number;
  /** The whole WALLET's arithmetic, across every game. Not this game's. */
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

/**
 * WHAT THIS TABLE HAS DONE TO THIS WALLET, AND NOTHING ELSE.
 *
 * Every figure is a sum over ledger rows filed under this game's name, for all
 * time. See positionFor in the arcade's ledger.js, which is where the
 * arithmetic lives -- there is no honest browser-side version of it, because
 * the browser holds one page of receipts and the answer is over all of them.
 */
export interface GamePosition {
  wallet: string;
  game: string;
  /** Everything ever staked here, including rounds still running. */
  wagered: number;
  rounds: number;
  /** What settled rounds paid back: stake returned plus anything won. */
  returned: number;
  /** Stakes handed back because the round never resolved. */
  refunded: number;
  /** Staked right now, in a round that has not settled. */
  inPlay: number;
  openRounds: number;
  /** returned + refunded + inPlay - wagered. */
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
  /** base58, which is what an injected wallet's signAndSendTransaction takes. */
  message: string;
  /**
   * The same transfer as an unsigned TRANSACTION, base58, which is what the
   * wallets actually want -- see approveTransfer for the deposit that proved
   * it. Optional because a box older than that change does not send one.
   */
  transaction?: string;
  /** The identical bytes in base64, for a provider that takes raw bytes. */
  transactionBase64?: string;
}
