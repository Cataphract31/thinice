import { DEFAULT_CONFIG, type RoundRecord } from "@zinc/engine";
import {
  verifyEntry,
  type AutoSettings,
  type ChatMsg,
  type HistoryEntry,
  type Snapshot,
} from "./client";
import {
  sfxExtract,
  sfxJoin,
  sfxSeal,
  sfxShatter,
  sfxTick,
  sfxYouDied,
} from "../audio/sound";
import { arcadeToken, onArcadeDomain, SHARED_DOMAIN } from "./arcade";

interface NetStats {
  roundsPlayed: number;
  roundsWon: number;
  wagered: number;
  returned: number;
  bestMultiple: number;
}

export interface NetExtras {
  connected: boolean;
  online: number;
  guest: boolean;
  address: string;
  stats: NetStats;
}

const EMPTY_STATS: NetStats = {
  roundsPlayed: 0,
  roundsWon: 0,
  wagered: 0,
  returned: 0,
  bestMultiple: 0,
};

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
};

const WALLET_OPTIN_KEY = "zinc.walletOptIn";
const WALLET_SESSION_KEY = "zinc.walletSession";

const SHARED_COOKIE = "zinc_ice";

const NAME_COOKIE = "zinc_wallet";

function readShared(): { wallet: string; token: string } | null {
  try {
    const m = document.cookie.match(new RegExp("(?:^|; )" + SHARED_COOKIE + "=([^;]*)"));
    if (!m) return null;
    const raw = m[1] ?? "";
    const cut = decodeURIComponent(raw).indexOf(".");
    if (cut <= 0) return null;
    const wallet = decodeURIComponent(raw).slice(0, cut);
    const token = decodeURIComponent(raw).slice(cut + 1);
    if (!wallet || !token) return null;
    return { wallet, token };
  } catch {
    return null;
  }
}

function writeShared(wallet: string, token: string): void {
  if (!onArcadeDomain()) return;
  const v = encodeURIComponent(`${wallet}.${token}`);
  document.cookie =
    `${SHARED_COOKIE}=${v}; Domain=${SHARED_DOMAIN}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; Secure`;
}

function clearShared(): void {
  if (!onArcadeDomain()) return;
  document.cookie =
    `${SHARED_COOKIE}=; Domain=${SHARED_DOMAIN}; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

function writeName(address: string | null): void {
  if (!onArcadeDomain()) return;
  const v = address ? encodeURIComponent(address) : "";
  document.cookie =
    `${NAME_COOKIE}=${v}; Domain=${SHARED_DOMAIN}; Path=/; Max-Age=${address ? 60 * 60 * 24 * 30 : 0}; SameSite=Lax; Secure`;
}

function nameCarried(): boolean {
  try {
    const m = document.cookie.match(new RegExp("(?:^|; )" + NAME_COOKIE + "=([^;]*)"));
    return Boolean(m && m[1]);
  } catch {
    return false;
  }
}

export function walletOptedIn(): boolean {
  if (readShared()) return true;
  if (nameCarried()) return true;
  if (arcadeToken()) return true;
  try {
    return localStorage.getItem(WALLET_OPTIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function walletSeated(): boolean {
  if (readShared()) return true;
  if (arcadeToken()) return true;
  try {
    return Boolean(localStorage.getItem(WALLET_SESSION_KEY));
  } catch {
    return false;
  }
}

export function walletCarried(): string | null {
  try {
    const m = document.cookie.match(new RegExp("(?:^|; )" + NAME_COOKIE + "=([^;]*)"));
    return m && m[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

export function setWalletOptIn(on: boolean, address?: string | null): void {
  writeName(on ? (address ?? null) : null);
  try {
    if (on) localStorage.setItem(WALLET_OPTIN_KEY, "1");
    else {
      localStorage.removeItem(WALLET_OPTIN_KEY);
      localStorage.removeItem(WALLET_SESSION_KEY);
      clearShared();
    }
  } catch {
  }
}

function walletSession(): { wallet: string; token: string } | null {
  const shared = readShared();
  if (shared) return shared;
  try {
    const raw = localStorage.getItem(WALLET_SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { wallet?: unknown; token?: unknown };
      if (typeof s.wallet === "string" && typeof s.token === "string") {
        return { wallet: s.wallet, token: s.token };
      }
    }
  } catch {
  }
  return null;
}

function saveWalletSession(wallet: string, token: string): void {
  writeShared(wallet, token);
  try {
    localStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({ wallet, token }));
  } catch {
  }
}

function clearWalletSession(): void {
  clearShared();
  try {
    localStorage.removeItem(WALLET_SESSION_KEY);
  } catch {
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
  charId: "chad",
  winner: null,
  teamWins: {},
  chat: [],
  history: [],
  nextCommit: "",
  auto: { enabled: false, target: 2, plates: 1 },
  stats: EMPTY_STATS,
  online: 0,
  connected: false,
};

export class NetClient {
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
  };
  private retry = 0;
  private reconnectTimer: number | null = null;
  private closed = false;
  private signatureWanted = false;
  private arcadeRefused = false;
  private phaseEndAt = 0;
  private clock: number | null = null;
  private commits = new Map<number, string>();
  private receipts = new Map<number, Partial<HistoryEntry>>();
  private pendingJoins = 0;
  private pendingRound = 0;
  private chat: ChatMsg[] = [];

  constructor(private url: string) {
    this.loadCommits();
    this.connect();
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
    }
  }

  private pinCommit(roundId: number, commit: string): void {
    if (roundId <= 0 || !commit || this.commits.get(roundId) === commit) return;
    if (this.commits.has(roundId)) return;
    this.commits.set(roundId, commit);
    try {
      const ids = [...this.commits.keys()].sort((a, b) => b - a).slice(0, 200);
      const obj: Record<string, string> = {};
      for (const id of ids) obj[id] = this.commits.get(id)!;
      this.commits = new Map(ids.map((id) => [id, obj[id]!]));
      localStorage.setItem(NetClient.COMMIT_KEY, JSON.stringify(obj));
    } catch {
    }
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

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
      this.snap = { ...this.snap, connected: false };
      this.emit();
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
        };
        if (typeof m.token === "string" && m.token) {
          saveWalletSession(String(m.wallet), m.token);
        }
        this.snap = {
          ...this.snap,
          seat: { guest: Boolean(m.guest), address: String(m.wallet) },
        };
        this.emit();
        return;

      case "state": {
        const s = m.state as Record<string, unknown> & Snapshot & { stats: NetStats };
        this.extras = { ...this.extras, online: Number(s.online ?? 0), stats: s.stats };
        const prev = this.snap;
        this.pinCommit(Number(s.roundId ?? 0), String(s.nextCommit ?? ""));
        this.phaseEndAt = Date.now() + Number(s.msToPhaseEnd ?? 0);
        this.snap = {
          ...IDLE,
          ...s,
          chat: this.chat,
          history: this.history,
          connected: true,
          seat: this.extras.connected
            ? { guest: this.extras.guest, address: this.extras.address }
            : undefined,
        };
        if (this.snap.roundId !== this.pendingRound) {
          this.pendingRound = this.snap.roundId;
          this.pendingJoins = 0;
        } else {
          const landed = this.snap.you.plates.total - prev.you.plates.total;
          if (landed > 0) this.pendingJoins = Math.max(0, this.pendingJoins - landed);
        }
        this.cue(prev, this.snap);
        this.emit();
        return;
      }

      case "history": {
        const rows = (m.history ?? []) as Record<string, unknown>[];
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
        if (this.pendingJoins > 0) this.pendingJoins--;
        if (message === "arcade session rejected") this.arcadeRefused = true;
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
        if (message === "session expired") clearWalletSession();
        if (!this.extras.connected && !this.closed) {
          this.ws?.close();
        }
        return;
      }
    }
  }

  private async authenticate(nonce: string): Promise<void> {
    const origin = this.ws;
    const stillOurs = (): boolean => this.ws === origin && origin?.readyState === WebSocket.OPEN;

    const stored = walletSession();
    if (stored && !this.signatureWanted) {
      this.send({ t: "resume", wallet: stored.wallet, token: stored.token });
      return;
    }

    const carried = this.signatureWanted || this.arcadeRefused ? null : arcadeToken();
    if (carried) {
      this.send({ t: "arcade", token: carried });
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
          if (!stillOurs()) return;
          const sig = btoa(String.fromCharCode(...signature));
          this.send({ t: "auth", wallet: pubkey.toString(), sig });
          return;
        }
      } catch {
      }
    }
    if (!stillOurs()) return;
    this.send({ t: "guest", id: guestId() });
  }

  private cue(a: Snapshot, b: Snapshot): void {
    if (b.roundId !== a.roundId) return;
    if (a.phase === "lobby" && b.phase === "live") sfxSeal();
    if (!a.you.joined && b.you.joined && b.phase === "lobby") sfxJoin();

    if (b.phase === "live" && b.tick > a.tick) {
      const shattered = b.deadCount - a.deadCount;
      if (shattered > 0) sfxShatter(shattered);
      sfxTick(b.hazard);
    }

    if (a.you.outcome === "in" && b.you.outcome === "dead") sfxYouDied();
    if (a.you.outcome === "in" && b.you.outcome === "cashed") sfxExtract();
  }

  private toHistory(r: Record<string, unknown>): HistoryEntry {
    let record: RoundRecord = { entrantIds: [], cashOuts: [] };
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

  private pushChat(m: ChatMsg): void {
    if (m.id > 0 && this.chat.some((x) => x.id === m.id)) return;
    this.chat.push(m);
    if (this.chat.length > 80) this.chat.shift();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.snap);
  }

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
    const snap = this.snap;
    if (snap.roundId !== this.pendingRound) {
      this.pendingRound = snap.roundId;
      this.pendingJoins = 0;
    }
    const held = snap.you.plates.total + this.pendingJoins;
    if (held >= (snap.you.plates.max || 5)) return;
    this.pendingJoins++;
    this.send({ t: "join" });
  }

  sync(): void {
    this.send({ t: "sync" });
  }

  walkOut(): void {
    this.send({ t: "cashout" });
  }

  stepOff(): void {
    this.pendingJoins = 0;
    this.snap = { ...this.snap, auto: { ...this.snap.auto, enabled: false } };
    this.emit();
    this.send({ t: "unjoin" });
  }

  logout(): void {
    this.send({ t: "logout" });
    this.reauth(false);
  }

  sendChat(text: string): void {
    const t = text.trim().slice(0, 160);
    if (!t) return;
    this.send({ t: "chat", text: t });
  }

  reauth(wantSignature = false): void {
    this.signatureWanted = wantSignature;
    this.retry = 0;
    this.ws?.close();
  }

  setAuto(patch: Partial<AutoSettings>): void {
    const next = { ...this.snap.auto, ...patch };
    if (!Number.isFinite(next.target) || next.target < 1.05) next.target = 1.05;
    if (next.target > 1000) next.target = 1000;
    const cap = this.snap.you.plates.max || 5;
    next.plates = Number.isFinite(next.plates)
      ? Math.min(cap, Math.max(1, Math.round(next.plates)))
      : 1;
    this.snap = { ...this.snap, auto: next };
    this.emit();
    this.send({ t: "setAuto", enabled: next.enabled, target: next.target, plates: next.plates });
  }

  setCharacter(id: string): void {
    this.snap = { ...this.snap, charId: id };
    this.emit();
    this.send({ t: "setChar", charId: id });
  }

  async verifyRound(roundId: number): Promise<void> {
    const h = this.history.find((x) => x.roundId === roundId);
    if (!h) return;
    await verifyEntry(h, DEFAULT_CONFIG);
    const receipt = {
      verified: h.verified,
      seedOk: h.seedOk,
      replayOk: h.replayOk,
      rulesOk: h.rulesOk,
      payoutOk: h.payoutOk,
      unavailable: h.unavailable,
    };
    this.receipts.set(roundId, receipt);
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
