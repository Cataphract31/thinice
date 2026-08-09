import { DEFAULT_CONFIG, type RoundRecord } from "@zinc/engine";
import {
  verifyEntry,
  type AutoSettings,
  type BankState,
  type ChatMsg,
  type HistoryEntry,
  type Snapshot,
} from "./client";
import {
  sfxBonanza,
  sfxExtract,
  sfxJoin,
  sfxSeal,
  sfxShatter,
  sfxTick,
  sfxYouDied,
} from "../audio/sound";

/**
 * The networked client.
 *
 * In this mode the browser decides nothing. It sends intents ("I want in",
 * "get me out") and renders whatever the server says is true. Everything that
 * used to be simulated locally — the rounds, the rolls, the balances, the
 * ledgers — now lives on the server, and this class exists only to turn the
 * wire format back into the exact same `Snapshot` the UI already renders.
 *
 * That is the whole point of having built the UI against a snapshot: not one
 * component knows or cares which of the two clients produced it.
 */

interface NetStats {
  roundsPlayed: number;
  roundsWon: number;
  wagered: number;
  returned: number;
  bestMultiple: number;
  revEarned: number;
  bonanzaWon: number;
}

/** Extra fields the local demo client has no equivalent for. */
export interface NetExtras {
  connected: boolean;
  online: number;
  guest: boolean;
  address: string;
  stats: NetStats;
  /** Rakeback streamed in while the tab was closed. One-shot per return. */
  away: { ms: number; sol: number } | null;
}

const EMPTY_STATS: NetStats = {
  roundsPlayed: 0,
  roundsWon: 0,
  wagered: 0,
  returned: 0,
  bestMultiple: 0,
  revEarned: 0,
  bonanzaWon: 0,
};

/**
 * A stable local id so a guest keeps their balance across refreshes.
 *
 * Storage can throw outright — blocked cookies, private-mode webviews — and an
 * exception here used to escape into the message handler's floating promise
 * and leave the client permanently unauthenticated with no retry. A session
 * that loses its balance on refresh is a far better failure than one that
 * never connects.
 */
let memoryGuestId = "";
function guestId(): string {
  const KEY = "zinc.guest.v1";
  const fresh = (): string => {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  try {
    const stored = localStorage.getItem(KEY);
    // Validated against the server's own rule, not merely trusted: a legacy
    // or hand-edited value that fails it is rejected outright by the server,
    // and that rejection arrives as an error the socket never recovers from.
    if (stored && /^[a-zA-Z0-9_-]{8,40}$/.test(stored)) return stored;
    const id = fresh();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    if (!memoryGuestId) memoryGuestId = fresh();
    return memoryGuestId;
  }
}

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  /** Signs and submits a legacy Transaction; Phantom returns its signature. */
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
};

/**
 * Wallet auth is OPT-IN, remembered per browser. Without this the handshake
 * ran at every socket open, so anyone with Phantom installed got a signature
 * popup before they had seen the game at all. Everyone starts as a guest;
 * clicking connect sets the flag, disconnecting clears it.
 */
const WALLET_OPTIN_KEY = "zinc.walletOptIn";
/** {wallet, token} minted by the server on a successful signature. */
const WALLET_SESSION_KEY = "zinc.walletSession";

export function walletOptedIn(): boolean {
  try {
    return localStorage.getItem(WALLET_OPTIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setWalletOptIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(WALLET_OPTIN_KEY, "1");
    // Disconnecting drops the stored session with the flag: staying
    // resumable after an explicit disconnect would make the button a lie.
    else {
      localStorage.removeItem(WALLET_OPTIN_KEY);
      localStorage.removeItem(WALLET_SESSION_KEY);
    }
  } catch {
    /* session-only opt-in still works via the fresh handshake */
  }
}

function walletSession(): { wallet: string; token: string } | null {
  try {
    const raw = localStorage.getItem(WALLET_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { wallet?: unknown; token?: unknown };
    if (typeof s.wallet !== "string" || typeof s.token !== "string") return null;
    return { wallet: s.wallet, token: s.token };
  } catch {
    return null;
  }
}

function saveWalletSession(wallet: string, token: string): void {
  try {
    localStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({ wallet, token }));
  } catch {
    /* resumes fall back to a signature next visit */
  }
}

function clearWalletSession(): void {
  try {
    localStorage.removeItem(WALLET_SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

function phantom(): PhantomProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

const IDLE: Snapshot = {
  phase: "lobby",
  roundId: 0,
  tick: 0,
  multiplier: 1,
  hazard: 0,
  grace: false,
  graceRemaining: 0,
  msToPhaseEnd: 0,
  players: [],
  liveCount: 0,
  totalCount: 0,
  deadCount: 0,
  cashedCount: 0,
  potInPlay: 0,
  entry: DEFAULT_CONFIG.entry,
  you: {
    joined: false,
    outcome: "out",
    balance: 0,
    multiple: 0,
    lockedMultiple: null,
    plates: { total: 0, alive: 0, cashed: 0, dead: 0, max: 5 },
  },
  wallet: 0,
  session: 0,
  bonanzaPool: 0,
  bonanzaDrought: 0,
  bonanzaTickets: 0,
  revShareTickets: 0,
  bonanza: null,
  charId: "chad",
  winner: null,
  teamWins: {},
  tickets: { bonYours: 0, bonTotal: 0, bonShare: 0, revShare: 0, revStreamed: 0 },
  chat: [],
  history: [],
  nextCommit: "",
  auto: { enabled: false, target: 2, plates: 1 },
  stats: EMPTY_STATS,
  online: 0,
  connected: false,
};

export class NetClient {
  readonly isLocal = false;
  private ws: WebSocket | null = null;
  private snap: Snapshot = IDLE;
  private listeners = new Set<(s: Snapshot) => void>();
  private history: HistoryEntry[] = [];
  private extras: NetExtras = {
    connected: false,
    online: 0,
    guest: true,
    address: "",
    stats: EMPTY_STATS,
    away: null,
  };
  private retry = 0;
  private reconnectTimer: number | null = null;
  private closed = false;
  /** One-shot: the next challenge runs the Phantom signature ceremony. Set
      only by the connect button — nothing else may summon the popup. */
  private signatureWanted = false;
  /** Local deadline for the current phase, so countdowns run between pushes. */
  private phaseEndAt = 0;
  private clock: number | null = null;
  /** Set once the server names its house account; enables the bank panel. */
  private bank: BankState | null = null;
  /**
   * roundId -> the commitment this client saw WHILE that round was forming.
   *
   * Without this, "verification" is the server handing over a seed and a hash
   * in the same message and the client checking they agree — which any
   * operator can satisfy by picking the seed after the round and computing the
   * hash to match. Pinning what was actually on screen before the seal is what
   * makes the ceremony mean anything. Persisted, so a refresh does not quietly
   * downgrade every later check.
   */
  private commits = new Map<number, string>();
  /** Verification verdicts survive the server replacing the history array. */
  private receipts = new Map<number, Partial<HistoryEntry>>();
  /** The room's talk. Server-relayed; the sender's echo is the receipt. */
  private chat: ChatMsg[] = [];

  constructor(private url: string) {
    this.loadCommits();
    this.connect();
    // The server pushes state on its own cadence; without a local clock the
    // "seals in 7s" countdown sits frozen between pushes and the game looks
    // hung. Purely cosmetic interpolation — the server still owns the clock.
    this.clock = window.setInterval(() => {
      if (this.snap.phase === undefined || !this.snap.connected) return;
      const left = Math.max(0, this.phaseEndAt - Date.now());
      if (Math.abs(left - this.snap.msToPhaseEnd) < 100) return;
      this.snap = { ...this.snap, msToPhaseEnd: left };
      this.emit();
    }, 250);
  }

  private static readonly COMMIT_KEY = "zinc.commits.v1";

  private loadCommits(): void {
    try {
      const raw = localStorage.getItem(NetClient.COMMIT_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        if (/^\d+$/.test(k) && typeof v === "string") this.commits.set(Number(k), v);
      }
    } catch {
      /* an unreadable store just means older rounds cannot be pinned */
    }
  }

  /** Remembers the commitment for a forming round, keeping the last 200. */
  private pinCommit(roundId: number, commit: string): void {
    if (roundId <= 0 || !commit || this.commits.get(roundId) === commit) return;
    // First observation wins. A commitment that CHANGES for a round already
    // seen is exactly the tampering this map exists to catch, so it must not
    // be allowed to overwrite the honest value it is being compared against.
    if (this.commits.has(roundId)) return;
    this.commits.set(roundId, commit);
    try {
      const ids = [...this.commits.keys()].sort((a, b) => b - a).slice(0, 200);
      const obj: Record<string, string> = {};
      for (const id of ids) obj[id] = this.commits.get(id)!;
      this.commits = new Map(ids.map((id) => [id, obj[id]!]));
      localStorage.setItem(NetClient.COMMIT_KEY, JSON.stringify(obj));
    } catch {
      /* in-memory pinning still works for this session */
    }
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    // No onopen handler on purpose — and specifically no backoff reset
    // there. A "server full" rejection and a persistent server-side seating
    // error both close AFTER a successful handshake, so resetting on raw
    // open turned exponential backoff into a permanent 500ms retry storm
    // aimed at a server that is already at its limit. The reset lives in
    // the `ready` handler: the first moment the connection is actually usable.

    ws.onmessage = (ev) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.handle(m);
    };

    ws.onclose = () => {
      this.extras = { ...this.extras, connected: false };
      // Into the snapshot too — the snapshot is the only thing the UI reads,
      // and a stale `connected: true` there means the player is never told
      // their cash-out button stopped doing anything.
      this.snap = { ...this.snap, connected: false };
      this.emit();
      // Exponential backoff, capped: a server restart should be a blip, and a
      // server that is down should not become a denial of service against it.
      if (this.closed) return;
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      this.reconnectTimer = window.setTimeout(() => this.connect(), wait);
    };

    ws.onerror = () => ws.close();
  }

  private async handle(m: Record<string, unknown>): Promise<void> {
    switch (m.t) {
      case "challenge":
        await this.authenticate(String(m.nonce));
        return;

      case "ready":
        this.retry = 0;
        this.extras = {
          ...this.extras,
          connected: true,
          guest: Boolean(m.guest),
          address: String(m.wallet),
          // The server only sends this after a real absence with a non-zero
          // drip; a reconnect without it keeps whatever was already shown.
          ...(typeof m.awayRakeback === "number" && m.awayRakeback > 0
            ? { away: { ms: Number(m.awayMs ?? 0), sol: Number(m.awayRakeback) } }
            : {}),
        };
        // A fresh signature minted a session token: store it, and every
        // later connection resumes silently instead of prompting Phantom.
        if (typeof m.token === "string" && m.token) {
          saveWalletSession(String(m.wallet), m.token);
        }
        this.bank = m.house
          ? { house: String(m.house), busy: false, note: "", ok: null }
          : null;
        this.snap = {
          ...this.snap,
          bank: this.bank ?? undefined,
          // WHO is actually seated, straight from the server. The wallet
          // button renders THIS, not Phantom's connect state — the two can
          // disagree (expired session seats a guest while Phantom still
          // shows the address), and the seat is the one that holds money.
          seat: { guest: Boolean(m.guest), address: String(m.wallet) },
        };
        this.emit();
        return;

      case "state": {
        const s = m.state as Record<string, unknown> & Snapshot & { stats: NetStats };
        this.extras = { ...this.extras, online: Number(s.online ?? 0), stats: s.stats };
        const prev = this.snap;
        // Pin the commitment while the round is still forming — the whole
        // point is to capture it BEFORE the outcome exists.
        this.pinCommit(Number(s.roundId ?? 0), String(s.nextCommit ?? ""));
        this.phaseEndAt = Date.now() + Number(s.msToPhaseEnd ?? 0);
        this.snap = {
          ...IDLE,
          ...s,
          // Carried locally, not part of the state push — without these the
          // spread of IDLE wipes them back to empty on every server tick.
          chat: this.chat,
          history: this.history,
          connected: true,
          bank: this.bank ?? undefined,
          seat: this.extras.connected
            ? { guest: this.extras.guest, address: this.extras.address }
            : undefined,
          away: this.extras.away,
        };
        this.cue(prev, this.snap);
        this.emit();
        return;
      }

      case "tx": {
        if (this.bank) {
          this.bank = {
            ...this.bank,
            busy: false,
            ok: Boolean(m.ok),
            note: m.ok
              ? `${m.kind === "deposit" ? "deposited" : "withdrew"} ${Number(m.sol).toFixed(3)} ◎`
              : String(m.note ?? "failed"),
          };
          this.snap = { ...this.snap, bank: this.bank };
          this.emit();
        }
        return;
      }

      case "history": {
        const rows = (m.history ?? []) as Record<string, unknown>[];
        // Carry verdicts across the rebuild. The server re-pushes the whole
        // history to everyone at every round end, so without this every
        // "✓ fair" a player earned is wiped roughly once a minute.
        this.history = rows.map((r) => {
          const h = this.toHistory(r);
          const kept = this.receipts.get(h.roundId);
          return kept ? { ...h, ...kept } : h;
        });
        this.snap = { ...this.snap, history: this.history };
        this.emit();
        return;
      }

      case "chat": {
        const rows = (m.msgs ?? []) as Record<string, unknown>[];
        for (const r of rows) {
          this.pushChat({
            id: Number(r.id ?? 0),
            name: String(r.name ?? ""),
            charId: String(r.charId ?? "chad"),
            text: String(r.text ?? ""),
            at: Number(r.at ?? Date.now()),
            you: Boolean(r.you),
          });
        }
        this.snap = { ...this.snap, chat: [...this.chat] };
        this.emit();
        return;
      }

      case "error": {
        const message = String(m.message ?? "");
        console.warn("server:", message);
        // Chat rejections belong in the chat feed, where the person who
        // triggered one is actually looking — not in a console nobody reads.
        if (message.startsWith("chat:")) {
          this.pushChat({
            id: -Date.now(),
            name: "",
            charId: "",
            text: message.slice(5).trim(),
            at: Date.now(),
            you: false,
            system: true,
          });
          this.snap = { ...this.snap, chat: [...this.chat] };
          this.emit();
          return;
        }
        // A dead session token must not loop forever: clear it so the next
        // cycle seats us as a guest, exactly the pre-wallet experience.
        if (message === "session expired") clearWalletSession();
        // An auth-phase rejection leaves the socket open, so `onclose` never
        // fires and nothing ever retries: the player sits on "Reconnecting…"
        // forever while nothing is reconnecting. Force the cycle.
        if (!this.extras.connected && !this.closed) {
          this.setBankNote(message);
          this.ws?.close();
        }
        return;
      }
    }
  }

  /**
   * Prove who you are, if you can. A connected Phantom signs the server's
   * nonce, which is what stops anyone from simply claiming to be an address
   * and spending its balance. Without a wallet you play as a local guest.
   */
  private async authenticate(nonce: string): Promise<void> {
    // The nonce belongs to the socket that issued it. Signing is async (a
    // Phantom prompt the user may sit on), and if the socket is replaced
    // meanwhile, sending this signature over the new one gets it rejected —
    // the wallet holder silently ends up seated as a guest.
    const origin = this.ws;
    const stillOurs = (): boolean => this.ws === origin && origin?.readyState === WebSocket.OPEN;

    // Silent first: a stored session token resumes the wallet with no
    // Phantom involvement at all — across reloads, reconnects and server
    // restarts. Phantom is only ever spoken to on the turn the player
    // explicitly presses connect (the one-shot flag below).
    const stored = walletSession();
    if (stored && !this.signatureWanted) {
      this.send({ t: "resume", wallet: stored.wallet, token: stored.token });
      return;
    }

    const p = this.signatureWanted ? phantom() : null;
    this.signatureWanted = false;
    if (p) {
      try {
        const res = await p.connect({ onlyIfTrusted: true }).catch(() => p.connect());
        const pubkey = res?.publicKey ?? p.publicKey;
        if (pubkey) {
          const msg = new TextEncoder().encode(`THIN ICE login\nnonce: ${nonce}`);
          const { signature } = await p.signMessage(msg, "utf8");
          if (!stillOurs()) return; // a new socket will issue its own challenge
          const sig = btoa(String.fromCharCode(...signature));
          this.send({ t: "auth", wallet: pubkey.toString(), sig });
          return;
        }
      } catch {
        // Declined or unavailable: fall through to guest.
      }
    }
    if (!stillOurs()) return;
    this.send({ t: "guest", id: guestId() });
  }

  /**
   * Sound, driven by what changed between two server states.
   *
   * The local client fires its cues from inside the functions that cause them.
   * Nothing here causes anything, so the cues have to be recovered by diffing
   * successive snapshots instead — otherwise pointing the build at a server
   * ships a completely silent game with a fully working volume control, which
   * is exactly the state this was in.
   */
  private cue(a: Snapshot, b: Snapshot): void {
    if (b.roundId !== a.roundId) return; // fresh round, nothing to compare
    if (a.phase === "lobby" && b.phase === "live") sfxSeal();
    if (!a.you.joined && b.you.joined && b.phase === "lobby") sfxJoin();

    if (b.phase === "live" && b.tick > a.tick) {
      const shattered = b.deadCount - a.deadCount;
      if (shattered > 0) sfxShatter(shattered);
      sfxTick(b.hazard);
    }

    if (a.you.outcome === "in" && b.you.outcome === "dead") sfxYouDied();
    if (a.you.outcome === "in" && b.you.outcome === "cashed") sfxExtract();

    // `at` is the server's fire timestamp, so it identifies the event even
    // when two fires land in consecutive rounds.
    if (b.bonanza && b.bonanza.at !== a.bonanza?.at) sfxBonanza();
  }

  private toHistory(r: Record<string, unknown>): HistoryEntry {
    let record: RoundRecord = { entrantIds: [], cashOuts: [] };
    // A row that cannot be parsed is UNVERIFIABLE — not fraudulent. Replaying
    // the empty stand-in would fail every check and paint "✗ mismatch" on a
    // round nothing is actually known to be wrong with.
    let unavailable = false;
    try {
      record = JSON.parse(String(r.record ?? "")) as RoundRecord;
      if (!record || typeof record !== "object" || !Array.isArray(record.entrantIds)) {
        unavailable = true;
      }
    } catch {
      unavailable = true;
    }
    const roundId = Number(r.roundId);
    return {
      roundId,
      entrants: Number(r.entrants),
      ticks: Number(r.ticks),
      joined: true,
      yourOutcome: r.yourOutcome as HistoryEntry["yourOutcome"],
      yourMultiple: r.yourMultiple === null ? null : Number(r.yourMultiple),
      yourSeats: Array.isArray(r.yourSeats)
        ? (r.yourSeats as unknown[]).map(Number).filter((x) => Number.isFinite(x) && x > 0)
        : null,
      bestMultiple: Number(r.bestMultiple),
      commit: String(r.commit ?? ""),
      observedCommit: this.commits.get(roundId),
      seedHex: String(r.seedHex ?? ""),
      verified: null,
      seedOk: null,
      replayOk: null,
      rulesOk: null,
      bonanzaOk: null,
      payoutOk: null,
      unavailable: unavailable || undefined,
      record,
      digest: String(r.digest ?? ""),
      winnerChar: (r.winnerChar as string | null) ?? null,
      winnerYou: Boolean(r.winnerYou),
    };
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Appends one line, deduplicating a reconnect's replayed backlog by id. */
  private pushChat(m: ChatMsg): void {
    if (m.id > 0 && this.chat.some((x) => x.id === m.id)) return;
    this.chat.push(m);
    if (this.chat.length > 80) this.chat.shift();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.snap);
  }

  // ------------------------------------------------------------------ public

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  snapshot(): Snapshot {
    return this.snap;
  }

  net(): NetExtras {
    return this.extras;
  }

  join(): void {
    this.send({ t: "join" });
  }

  walkOut(): void {
    this.send({ t: "cashout" });
  }

  /** Steps off during the lobby: full refund, and auto play switches off. */
  stepOff(): void {
    this.snap = { ...this.snap, auto: { ...this.snap.auto, enabled: false } };
    this.emit();
    this.send({ t: "unjoin" });
  }

  /**
   * A line for the room. No local echo: the server relays it back to every
   * session including this one, so your own message appearing IS the receipt
   * that the room actually heard it.
   */
  sendChat(text: string): void {
    const t = text.trim().slice(0, 160);
    if (!t) return;
    this.send({ t: "chat", text: t });
  }

  /**
   * Re-runs the login handshake on the live server connection. The HUD calls
   * this after the player connects or disconnects Phantom: authentication
   * happens at socket open, so without a fresh handshake the player who just
   * approved their wallet would remain seated as a guest until they reloaded.
   */
  reauth(wantSignature = false): void {
    this.signatureWanted = wantSignature;
    this.retry = 0;
    this.ws?.close();
  }

  /** Surfaces a server error in the bank panel when one is open. */
  private setBankNote(note: string): void {
    if (this.bank?.busy) this.setBank({ busy: false, ok: false, note });
  }

  private setBank(patch: Partial<BankState>): void {
    if (!this.bank) return;
    this.bank = { ...this.bank, ...patch };
    this.snap = { ...this.snap, bank: this.bank };
    this.emit();
  }

  /**
   * Sends SOL from the connected Phantom to the house, then hands the server
   * the signature to verify against the chain and credit. The heavy Solana
   * SDK loads on first use only — players who never bank never download it.
   */
  async deposit(sol: number): Promise<void> {
    const bank = this.bank;
    if (!bank || bank.busy) return;
    const p = phantom();
    const from = p?.publicKey;
    if (!p || !from) {
      this.setBank({ ok: false, note: "connect Phantom first" });
      return;
    }
    this.setBank({ busy: true, ok: null, note: "waiting for Phantom…" });
    try {
      const { Connection, PublicKey, SystemProgram, Transaction } = await import(
        "@solana/web3.js"
      );
      const rpc =
        (import.meta.env.VITE_RPC_URL as string | undefined) ??
        "https://api.devnet.solana.com";
      const conn = new Connection(rpc, "confirmed");
      const fromKey = new PublicKey(from.toString());
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKey,
          toPubkey: new PublicKey(bank.house),
          lamports: Math.round(sol * 1e9),
        }),
      );
      tx.feePayer = fromKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const { signature } = await p.signAndSendTransaction(tx);
      this.setBank({ note: "confirming on devnet…" });
      this.send({ t: "deposit", sig: String(signature) });
    } catch {
      this.setBank({ busy: false, ok: false, note: "cancelled or failed in Phantom" });
    }
  }

  /** Asks the server to pay out ledger balance on-chain. */
  withdraw(sol: number): void {
    const bank = this.bank;
    if (!bank || bank.busy) return;
    this.setBank({ busy: true, ok: null, note: "paying out…" });
    this.send({ t: "withdraw", sol });
  }

  setAuto(patch: Partial<AutoSettings>): void {
    const next = { ...this.snap.auto, ...patch };
    if (!Number.isFinite(next.target) || next.target < 1.05) next.target = 1.05;
    if (next.target > 1000) next.target = 1000;
    const cap = this.snap.you.plates.max || 5;
    next.plates = Number.isFinite(next.plates)
      ? Math.min(cap, Math.max(1, Math.round(next.plates)))
      : 1;
    // Optimistic locally so the control answers instantly; the server's next
    // state message is what actually settles it.
    this.snap = { ...this.snap, auto: next };
    this.emit();
    this.send({ t: "setAuto", enabled: next.enabled, target: next.target, plates: next.plates });
  }

  setCharacter(id: string): void {
    this.snap = { ...this.snap, charId: id };
    this.emit();
    this.send({ t: "setChar", charId: id });
  }

  /**
   * Re-runs a finished round from its revealed seed, right here, and checks
   * the replay, the commitment, and the rules it was played under. The server
   * is not asked to confirm anything — that is the entire point. Identical
   * code to the local client's check, deliberately.
   */
  async verifyRound(roundId: number): Promise<void> {
    const h = this.history.find((x) => x.roundId === roundId);
    if (!h) return;
    await verifyEntry(h, DEFAULT_CONFIG);
    const receipt = {
      verified: h.verified,
      seedOk: h.seedOk,
      replayOk: h.replayOk,
      rulesOk: h.rulesOk,
      bonanzaOk: h.bonanzaOk,
      payoutOk: h.payoutOk,
      unavailable: h.unavailable,
    };
    this.receipts.set(roundId, receipt);
    // Re-find rather than trusting the captured object: a history push during
    // the awaited hashing replaces the whole array with fresh objects, and
    // mutating the orphan would drop the verdict the player just asked for.
    const live = this.history.find((x) => x.roundId === roundId);
    if (live && live !== h) Object.assign(live, receipt);
    this.snap = { ...this.snap, history: [...this.history] };
    this.emit();
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.clock !== null) clearInterval(this.clock);
    this.ws?.close();
    this.listeners.clear();
  }
}
