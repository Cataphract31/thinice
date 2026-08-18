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
export const SHARED_DOMAIN = ".voidsolana.com";

export const LAMPORTS = 1_000_000_000;

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

/** Write a cookie for every world on this domain. */
function carry(name: string, value: string, days = 30): void {
  // Off the arcade's own domain a Domain attribute naming it is silently
  // discarded rather than refused, which is worse than an error because it
  // looks like it worked.
  if (!onArcadeDomain()) return;
  try {
    document.cookie =
      `${name}=${encodeURIComponent(value)}; Domain=${SHARED_DOMAIN}; Path=/; ` +
      `Max-Age=${60 * 60 * 24 * days}; SameSite=Lax; Secure`;
  } catch {
    /* no cookie jar; this browser simply cannot stay signed in */
  }
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
  constructor(message: string, code = "ARCADE_ERROR", status = 0) {
    super(message);
    this.name = "ArcadeError";
    this.code = code;
    this.status = status;
  }
}

/** One call to the arcade, with the session attached if there is one. */
export async function arcadeApi<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const token = arcadeToken();
  let res: Response;
  try {
    res = await fetch(arcadeUrl(path), {
      ...opts,
      headers: {
        ...(opts.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    // Unreachable, refused, or blocked by the browser's own cross-origin
    // rules. All three look identical from here and all three mean the same
    // thing to a player: nothing happened.
    throw new ArcadeError(
      `Could not reach the arcade. ${(err as Error).message}`,
      "UNREACHABLE",
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ArcadeError(`The arcade answered with ${res.status}.`, "GARBAGE", res.status);
  }
  if (!res.ok) {
    const e = (parsed as { error?: { code?: string; message?: string } })?.error ?? {};
    throw new ArcadeError(e.message ?? `The arcade said ${res.status}.`, e.code ?? "REFUSED", res.status);
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
export function walletProvider(): { provider: SolanaProvider; name: string } | null {
  const w = window as unknown as {
    phantom?: { solana?: SolanaProvider };
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
    solana?: SolanaProvider;
  };
  if (w.phantom?.solana?.isPhantom) return { provider: w.phantom.solana, name: "Phantom" };
  if (w.solflare?.isSolflare) return { provider: w.solflare, name: "Solflare" };
  if (w.backpack?.isBackpack) return { provider: w.backpack, name: "Backpack" };
  if (w.solana) return { provider: w.solana, name: "your wallet" };
  return null;
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
  const found = walletProvider();
  if (!found) {
    throw new ArcadeError(
      "No Solana wallet in this browser. Install Phantom, then reload.",
      "NO_WALLET",
    );
  }
  const { provider } = found;
  const out = await provider.connect().catch((err: { code?: number }) => {
    if (err?.code === 4001) throw new ArcadeError("Cancelled.", "CANCELLED");
    throw err;
  });
  const address = (out?.publicKey ?? provider.publicKey)?.toString();
  if (!address) throw new ArcadeError("The wallet connected without giving an address.", "NO_ADDRESS");
  // The address itself is recorded by the CALLER, through setWalletOptIn in
  // game/net.ts, which writes the same arcade-wide cookie and the game's own
  // flag together. Two writers of one cookie is how they drift apart.
  if (arcadeToken()) return address;
  if (typeof provider.signMessage !== "function") {
    throw new ArcadeError("This wallet cannot sign a message from a page.", "NO_SIGN");
  }

  const asked = await arcadeApi<{ nonce: string; statement: string }>("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: address }),
  });
  if (!asked?.nonce || !asked?.statement) {
    throw new ArcadeError("The arcade would not issue a challenge.", "NO_CHALLENGE");
  }
  const { signature } = await provider
    .signMessage(new TextEncoder().encode(asked.statement), "utf8")
    .catch((err: { code?: number }) => {
      if (err?.code === 4001) throw new ArcadeError("Cancelled.", "CANCELLED");
      throw err;
    });
  const proof = await arcadeApi<{ token: string }>("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: address,
      nonce: asked.nonce,
      signature: btoa(String.fromCharCode(...signature)),
    }),
  });
  if (typeof proof?.token !== "string" || !proof.token) {
    throw new ArcadeError("The arcade would not accept that signature.", "NO_SESSION");
  }
  carry(SESSION_COOKIE, proof.token);
  return address;
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
 * ONE METHOD, NO ADAPTER. `request({ method: "signAndSendTransaction" })` with
 * a base58 message is the injected-provider RPC underneath every wallet
 * adapter, and taking it directly is what keeps @solana/web3.js out of a
 * bundle that has two runtime dependencies. A wallet that will not answer it
 * gets NO_TX_API and the panel falls back to showing the address, which is how
 * every deposit in this arcade worked until now.
 */
export async function approveTransfer(
  provider: SolanaProvider | null,
  message: string,
): Promise<string> {
  if (typeof provider?.request !== "function") {
    throw new ArcadeError("This wallet cannot send a transaction from a page.", "NO_TX_API");
  }
  let out: unknown;
  try {
    out = await provider.request({ method: "signAndSendTransaction", params: { message } });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    // 4001 is the wallet standard's "user rejected". Not an error worth a red
    // line: they read what it was going to do and said no, which is the whole
    // reason they were shown it.
    if (e?.code === 4001) throw new ArcadeError("Cancelled. Nothing was sent.", "CANCELLED");
    // -32601 is JSON-RPC "no such method"; some wallets say it in words.
    // Either way the fallback is the same screen, so it gets the same code.
    if (e?.code === -32601 || /unsupported|not supported|unknown method/i.test(String(e?.message ?? ""))) {
      throw new ArcadeError("This wallet cannot send a transaction from a page.", "NO_TX_API");
    }
    throw err;
  }
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

export interface CustodyHistory {
  deposits: Array<{ at: number; lamports: number; signature: string }>;
  withdrawals: Array<{ at: number; sent: number; signature: string | null; state: string }>;
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
}
