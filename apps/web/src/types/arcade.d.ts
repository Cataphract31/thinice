export interface ArcadeProvider {
  isDeeplink?: boolean;
  arcadeAccepts?: string;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage?(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  request?(args: { method: string; params?: unknown }): Promise<unknown>;
  deposit?(prepared: unknown): Promise<never>;
  disconnect?(): Promise<void>;
  on?(event: string, fn: (arg?: unknown) => void): void;
}

export interface FoundProvider {
  provider: ArcadeProvider;
  name: string;
}

export function findProvider(): FoundProvider | null;

export function ensureProvider(): Promise<FoundProvider | null>;

export function walletRoute(): "injected" | "mobile" | "desktop";

export function connect(): Promise<{ address: string; name: string; session: boolean }>;

export function completeDeeplink(): Promise<unknown>;

export function onDepositArrival(
  show: ((result: { kind: string; lamports?: number; signature?: string; message?: string }) => void | Promise<void>) | null,
): void;

export function signOut(): Promise<void>;
