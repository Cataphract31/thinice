/*
 * TYPES FOR THE ARCADE'S WALLET, WHICH IS PLAIN JAVASCRIPT.
 *
 * WHY THIS FILE EXISTS. `/arcade/web/wallet.js` is fetched from the arcade at
 * RUNTIME -- a URL on this same site, marked external so the bundler leaves the
 * import alone. See serveArcade() in vite.config.ts for the mechanism and the
 * trade. TypeScript cannot resolve a URL specifier, and would not typecheck the
 * JavaScript behind it if it could: the arcade has no build step, and this app
 * is `strict: true` with `allowJs` off. So the shape is declared here, against
 * the exact specifier the code imports -- through a `paths` entry in
 * tsconfig.json, because an ambient `declare module` only ever matches a BARE
 * specifier and this one is a path.
 *
 * The alternative was turning `allowJs` on, which would have let the compiler
 * infer types from two and a half thousand lines of somebody else's JavaScript
 * and quietly widen half of them to `any`. A hand-written declaration loosens
 * nothing: what is not declared here cannot be imported, and anything this app
 * gets wrong about the arcade's shape is a compile error rather than a runtime
 * surprise on somebody's phone.
 *
 * SO IT DECLARES ONLY WHAT THIS APP USES. The module exports more -- the Wallet
 * class a table uses to hold connection state, the session helpers this app has
 * its own readers for. Adding to this file is how you reach them; inventing a
 * shape the JavaScript does not have is how you get a green build and a broken
 * deposit, so read the source when you do.
 *
 * IT IS THIS APP'S OWN READING of that module -- GIELINOR ships no TypeScript
 * to copy -- and it is the ONLY arcade file left in this repo. The eight that
 * used to sit beside it are gone. There is one wallet.js in the world now, and
 * this is a description of it rather than a copy of it.
 */

/** An injected Solana provider, or the phone's stand-in for one. */
export interface ArcadeProvider {
  /**
   * TRUE WHEN THE WALLET IS ANOTHER APP. Its methods navigate away rather than
   * answering, so their promises never settle -- see approveTransfer, which is
   * the one caller that has to know.
   */
  isDeeplink?: boolean;
  /** Set by a provider that takes raw bytes rather than base58. */
  arcadeAccepts?: string;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage?(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  request?(args: { method: string; params?: unknown }): Promise<unknown>;
  /** The phone path only: hand the box's transfer to the wallet app. */
  deposit?(prepared: unknown): Promise<never>;
  disconnect?(): Promise<void>;
  on?(event: string, fn: (arg?: unknown) => void): void;
}

export interface FoundProvider {
  provider: ArcadeProvider;
  name: string;
}

/** What is injected into this page right now. Synchronous; null on a phone. */
export function findProvider(): FoundProvider | null;

/**
 * What this browser can connect with, including a wallet app one press away.
 * Asynchronous because the phone answer lives in a lazily loaded module.
 */
export function ensureProvider(): Promise<FoundProvider | null>;

/** 'injected' if something is here, 'mobile' on a phone, else 'desktop'. */
export function walletRoute(): "injected" | "mobile" | "desktop";

/**
 * Connect and sign in, on an explicit press. On a phone with no wallet in the
 * page this offers the wallet apps and may NAVIGATE AWAY, in which case the
 * promise never settles.
 */
export function connect(): Promise<{ address: string; name: string; session: boolean }>;

/**
 * Finish a round trip to a wallet app, if this page load is the end of one.
 * Safe and cheap to call on every load: it returns immediately when the URL
 * carries no reply.
 */
export function completeDeeplink(): Promise<unknown>;

/**
 * Where a deposit that finished during a trip to the wallet app gets shown.
 * Register one, or the arcade's own bank panel opens on top of this game.
 */
export function onDepositArrival(
  show: ((result: { kind: string; lamports?: number; signature?: string; message?: string }) => void | Promise<void>) | null,
): void;

/** Drop the arcade session, at the box and in this browser. */
export function signOut(): Promise<void>;
