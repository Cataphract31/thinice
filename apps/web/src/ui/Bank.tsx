import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  approveTransfer,
  arcadeApi,
  ArcadeError,
  arcadeSignIn,
  arcadeToken,
  completeDeeplink,
  onDepositArrival,
  explorerUrl,
  GAME,
  MOVE_MS,
  sol,
  toLamports,
  walletNow,
  walletProvider,
  type ChainBalance,
  type CustodyHistory,
  type DepositInfo,
  type GamePosition,
  type LedgerBalance,
  type Movement,
  type PreparedDeposit,
  type WithdrawReceipt,
} from "@/game/arcade";
import { setWalletOptIn, walletCarried } from "@/game/net";
import { shortAddress } from "@/game/names";
import { useEscape } from "@/ui/esc";

type Mode = "deposit" | "withdraw" | "position";
type Tone = "dim" | "go" | "bad" | "busy";

interface Said {
  text: string;
  tone: Tone;
  signature?: string;
}

const WATCH_TICKS = 30;

const PER_PAGE = 6;

const PRESETS: Array<[string, number]> = [
  ["0.01", 10_000_000],
  ["0.05", 50_000_000],
  ["0.1", 100_000_000],
  ["0.25", 250_000_000],
  ["0.5", 500_000_000],
  ["1", 1_000_000_000],
];

const ARM_MS = 5000;

const UNTOUCHED = new Set([
  "NO_SESSION",
  "BAD_BODY",
  "BAD_AMOUNT",
  "BAD_ACCOUNT",
  "BELOW_MINIMUM",
  "DEPOSIT_NOT_FINAL",
  "ALREADY_WITHDRAWING",
  "INSUFFICIENT_FUNDS",
  "CHAIN_UNREACHABLE",
  "CUSTODY_SHORT",
  "SIGNER_AWAY",
  "SIGNER_REFUSED",
  "SIGNER_TIMEOUT",
  "BAD_SIGNATURE",
]);

const ended = (text: string): string => {
  const t = String(text ?? "").trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
};

export function BankOverlay({
  onClose,
  onBalanceMoved,
  onSignedIn,
}: {
  onClose: () => void;
  onBalanceMoved?: () => void;
  onSignedIn?: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>("deposit");
  const [signedIn, setSignedIn] = useState(() => Boolean(arcadeToken()));
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [asked, setAsked] = useState(false);
  const [ledger, setLedger] = useState<LedgerBalance | null>(null);
  const [chain, setChain] = useState<ChainBalance | null>(null);
  const [history, setHistory] = useState<CustodyHistory | null>(null);
  const [position, setPosition] = useState<GamePosition | null>(null);
  const [noPosition, setNoPosition] = useState(false);
  const [pages, setPages] = useState<{ deposit: number; withdraw: number }>({
    deposit: 1,
    withdraw: 1,
  });
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const glance = (): void => {
    if (!busy) onClose();
  };
  useEscape(glance);

  const wallet = ledger?.wallet ?? walletCarried();
  const walletName = walletProvider()?.name ?? "your wallet";
  const kind = mode === "withdraw" ? "out" : "in";
  const page = mode === "withdraw" ? pages.withdraw : pages.deposit;

  const watching = useRef(0);
  const seenDeposits = useRef<number | null>(null);
  const landed = useRef(onBalanceMoved);
  landed.current = onBalanceMoved;
  const seated = useRef(onSignedIn);
  seated.current = onSignedIn;
  const armedAt = useRef(0);

  const asking = useRef({ kind, page });
  asking.current = { kind, page };
  const onPosition = useRef(false);
  onPosition.current = mode === "position";

  const refresh = useCallback(async (): Promise<void> => {
    setSignedIn(Boolean(arcadeToken()));
    if (!arcadeToken()) {
      setLedger(null);
      setChain(null);
      setHistory(null);
      setPosition(null);
      return;
    }
    const want = asking.current;
    const [bal, hist, mine, pos] = await Promise.allSettled([
      arcadeApi<LedgerBalance>("/api/ledger/balance"),
      arcadeApi<CustodyHistory>(
        `/api/custody/history?kind=${want.kind}&page=${want.page}&perPage=${PER_PAGE}`,
      ),
      arcadeApi<ChainBalance>("/api/custody/wallet"),
      onPosition.current
        ? arcadeApi<GamePosition>(`/api/ledger/position?game=${encodeURIComponent(GAME)}`)
        : Promise.resolve(null),
    ]);
    if (bal.status === "fulfilled") setLedger(bal.value);
    if (mine.status === "fulfilled") setChain(mine.value);
    if (pos.status === "fulfilled" && pos.value) {
      setPosition(pos.value);
      setNoPosition(false);
    } else if (pos.status === "rejected") {
      if ((pos.reason as ArcadeError)?.status === 404) setNoPosition(true);
    }
    if (hist.status === "fulfilled") {
      const rows = hist.value;
      setHistory(rows);
      if (want.kind === "in") {
        const before = seenDeposits.current;
        const now = Number(rows.total ?? rows.deposits?.length ?? 0);
        seenDeposits.current = now;
        if (before !== null && now > before) {
          watching.current = 0;
          const newest = rows.rows?.[0] ?? null;
          setSaid({
            text: `credited. ${sol(newest?.amount)} ◎ is in your balance.`,
            tone: "go",
          });
          landed.current?.();
        }
      }
    }
  }, []);

  const poke = useCallback(async (): Promise<void> => {
    try {
      await arcadeApi("/api/custody/deposit/check", { method: "POST" });
    } catch {
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void arcadeApi<DepositInfo>("/api/custody/deposit")
      .then((got) => alive && setInfo(got))
      .catch(() => {})
      .finally(() => alive && setAsked(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    onDepositArrival((result) => {
      if (result.kind === "deposited") {
        setSaid({
          text: `${result.lamports ? `${sol(result.lamports)} ◎` : "deposit"} sent.`,
          tone: "go",
          signature: result.signature,
        });
        void refresh();
      } else {
        setSaid({
          text: result.message ?? "that did not finish.",
          tone: result.kind === "cancelled" ? "dim" : "bad",
        });
      }
    });
    void completeDeeplink();
    return () => onDepositArrival(null);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh, signedIn, mode, page]);

  useEffect(() => {
    const timer = setInterval(() => {
      const looking = watching.current > 0 || asking.current.kind === "in";
      if (watching.current > 0) watching.current -= 1;
      if (looking && arcadeToken()) void poke().then(refresh);
      else void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [poke, refresh]);

  const free = ledger?.balance ?? 0;
  const pending = Number(history?.pending ?? 0);
  const withdrawable = Math.max(0, free - pending);
  const held = ledger?.held ?? 0;
  const fee = info?.networkFee ?? chain?.fee ?? 5000;
  const floor = info?.minWithdrawal ?? 0;
  const want = toLamports(amount);
  const typed = amount.trim() !== "";

  const paying = ledger?.wallet ?? null;
  const onNow = walletProvider()?.provider?.publicKey?.toString() ?? null;

  let blocked: string | null = null;
  if (!signedIn) blocked = "connect a wallet first.";
  else if (!info) blocked = "this box is not handling deposits.";
  else if (mode === "withdraw" && paying && onNow && paying !== onNow) {
    blocked = `wrong wallet. the arcade pays ${shortAddress(paying)}, this browser is on `
      + `${shortAddress(onNow)}. reconnect the one you want paying.`;
  } else if (!typed) blocked = null;
  else if (want === null || want <= 0) blocked = "that is not an amount of ◎.";
  else if (mode === "deposit") {
    if (chain && want > chain.spendable) {
      blocked = `${walletName} holds ${sol(chain.lamports)} ◎, and ${sol(fee)} of it stays behind for the network fee.`;
    }
  } else if (mode === "withdraw") {
    if (want > withdrawable) {
      blocked =
        pending > 0 && want <= free
          ? `${sol(pending)} ◎ of your balance is still settling on the chain, so ${sol(withdrawable)} ◎ can leave.`
          : `you have ${sol(free)} ◎.`;
    } else if (want < floor) blocked = `the smallest withdrawal is ${sol(floor)} ◎.`;
  }

  const moving = mode === "deposit" || mode === "withdraw";
  const ready =
    moving && signedIn && Boolean(info) && typed && want !== null && want > 0 && !blocked && !busy;

  const ceiling = mode === "deposit" ? (chain?.spendable ?? null) : withdrawable;

  const retype = (v: string): void => {
    setAmount(v);
    setArmed(null);
    if (said?.tone !== "busy") setSaid(null);
  };

  const connect = async (): Promise<void> => {
    setBusy(true);
    setSaid({ text: "check your wallet.", tone: "busy" });
    try {
      const address = await arcadeSignIn();
      setWalletOptIn(true, address);
      setSignedIn(true);
      setSaid(null);
      seated.current?.();
      await refresh();
    } catch (err) {
      const e = err as ArcadeError;
      setSaid({ text: e.code === "CANCELLED" ? "cancelled." : e.message, tone: e.code === "CANCELLED" ? "dim" : "bad" });
    } finally {
      setBusy(false);
    }
  };

  const deposit = async (): Promise<void> => {
    if (want === null || want <= 0) return;
    setBusy(true);
    setSaid({ text: "building the transfer.", tone: "busy" });
    try {
      const prep = await arcadeApi<PreparedDeposit>("/api/custody/deposit/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: want }),
      });
      setSaid({ text: "approve it in your wallet.", tone: "busy" });
      const found = await walletNow();
      const signature = await approveTransfer(found?.provider ?? null, prep);
      setAmount("");
      setSaid({
        text: `${sol(want)} ◎ sent. waiting for the network.`,
        tone: "go",
        signature,
      });
      watching.current = WATCH_TICKS;
      await poke();
      await refresh();
    } catch (err) {
      const e = err as ArcadeError;
      if (e.code === "CANCELLED") setSaid({ text: "cancelled. nothing was sent.", tone: "dim" });
      else if (e.code === "NO_TX_API") {
        setManual(true);
        setSaid({ text: "this wallet will not send a transaction from a page. use the address below.", tone: "dim" });
      } else setSaid({ text: `${e.message} nothing has left your wallet.`, tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (): Promise<void> => {
    if (want === null || want <= 0) return;
    setBusy(true);
    setArmed(null);
    setSaid({ text: "asking the signer.", tone: "busy" });
    try {
      const out = await arcadeApi<WithdrawReceipt>("/api/custody/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: want }),
        timeoutMs: MOVE_MS,
      });
      setAmount("");
      setSaid({
        text: out.signature
          ? `${sol(out.receiving)} ◎ on its way.`
          : `${sol(out.receiving)} ◎ accepted, waiting on the signer.`,
        tone: "go",
        signature: out.signature ?? undefined,
      });
      setPages((p) => ({ ...p, withdraw: 1 }));
      await refresh();
      landed.current?.();
    } catch (err) {
      const e = err as ArcadeError;
      const sure = e?.answered === true && UNTOUCHED.has(e.code);
      const why = ended(e.message);
      setSaid({
        text: sure
          ? (/untouched/i.test(why) ? why : `${why} your balance has not been touched.`)
          : `${why} it may or may not have gone. do not send it again — check the receipts `
            + "below and the balance above in a few seconds.",
        tone: sure ? "bad" : "busy",
      });
    } finally {
      setBusy(false);
    }
  };

  const act = (): void => {
    if (!ready) return;
    if (mode === "deposit") {
      void deposit();
      return;
    }
    const live = armed === amount && Date.now() - armedAt.current < ARM_MS;
    if (live) {
      void withdraw();
      return;
    }
    setArmed(amount);
    armedAt.current = Date.now();
    setSaid({ text: `press again to send ${sol(want)} ◎ to your wallet.`, tone: "dim" });
  };

  const rows: Movement[] = useMemo(() => {
    if (!history) return [];
    if (Array.isArray(history.rows)) return history.rows;
    if (kind === "in") {
      return (history.deposits ?? []).map((d) => ({
        kind: "in" as const,
        at: d.at,
        amount: d.lamports,
        signature: d.signature,
        id: d.signature,
        state: "confirmed",
      }));
    }
    return (history.withdrawals ?? []).map((w) => ({
      kind: "out" as const,
      at: w.at,
      amount: w.sent,
      signature: w.signature,
      id: w.signature ?? String(w.at),
      state: w.state,
    }));
  }, [history, kind]);

  const totalRows = Number(history?.total ?? rows.length);
  const pageCount = Math.max(1, Number(history?.pages ?? 1));
  const goPage = (n: number): void =>
    setPages((p) => (mode === "withdraw" ? { ...p, withdraw: n } : { ...p, deposit: n }));

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-[#04070a]/85 p-3 backdrop-blur-sm sm:p-6"
      onClick={glance}
      role="dialog"
      aria-modal="true"
      aria-label="Wallet"
    >
      <div
        className="h-fit w-full max-w-[440px] rounded-sm bg-[var(--color-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="display text-[14px] tracking-[0.14em]">wallet</span>
          {signedIn && wallet && (
            <span className="label text-[var(--color-cyan)]">{shortAddress(wallet)}</span>
          )}
          <button
            onClick={onClose}
            className="chip label ml-auto px-2 py-1 hover:text-[var(--color-text)]"
          >
            close
          </button>
        </div>

        <div className="flex items-stretch border-t border-[var(--color-line)]">
          <Figure
            label="balance"
            value={`${sol(free, 3)} ◎`}
            color="var(--color-cyan)"
            note={held > 0 ? `${sol(held, 3)} ◎ staked` : signedIn ? "ready to play" : "not connected"}
          />
          <div className="flex-1 border-l border-[var(--color-line-soft)]">
            <Figure
              label={walletName.toLowerCase()}
              value={chain ? `${sol(chain.lamports, 3)} ◎` : "-"}
              color="var(--color-zinc-hi)"
              note={chain ? `${sol(chain.spendable, 3)} ◎ sendable` : signedIn ? "reading the chain" : "on chain"}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 border-t border-[var(--color-line)] px-3 py-2">
          {(["deposit", "withdraw", "position"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setSaid(null);
                setManual(false);
                setArmed(null);
              }}
              className={
                mode === m
                  ? `label rounded-sm px-2.5 py-1.5 font-bold ${
                      m === "deposit"
                        ? "bg-[var(--color-cyan)] text-[#03211f]"
                        : m === "withdraw"
                          ? "bg-[var(--color-profit)] text-[#03231a]"
                          : "bg-[var(--color-text)] text-[var(--color-pit)]"
                    }`
                  : "chip label px-2.5 py-1.5"
              }
            >
              {m}
            </button>
          ))}
          <span className="label ml-auto hidden text-right sm:inline">
            {mode === "deposit"
              ? "wallet to balance"
              : mode === "withdraw"
                ? "balance to wallet"
                : "this game only"}
          </span>
        </div>

        <div className="space-y-3 px-4 pb-4 pt-3">
          {!signedIn ? (
            <Connect
              busy={busy}
              onConnect={connect}
              said={said}
              mode={mode}
              known={Boolean(wallet)}
            />
          ) : mode === "position" ? (
            <Position position={position} absent={noPosition} chips={asked && !info} />
          ) : asked && !info ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
              This box is not handling real money yet, so there is nothing to deposit into.
              Everything you play with is house chips.
            </p>
          ) : (
            <>
              <Amount
                amount={amount}
                onAmount={retype}
                ceiling={ceiling}
                floor={mode === "withdraw" ? floor : 0}
                disabled={busy}
                onSubmit={act}
              />

              <button
                disabled={!ready}
                onClick={act}
                className={`display h-13 w-full rounded-sm py-3.5 text-[17px] font-bold tracking-[0.1em] transition-transform active:scale-[0.985] disabled:cursor-not-allowed ${
                  !ready
                    ? "bg-[var(--color-panel2)] text-[var(--color-dim)]"
                    : mode === "deposit"
                      ? "bg-[var(--color-cyan)] text-[#03211f]"
                      : armed === amount
                        ? "bg-[var(--color-danger)] text-[#1a0009]"
                        : "bg-[var(--color-profit)] text-[#03231a]"
                }`}
              >
                {busy
                  ? "check your wallet…"
                  : mode === "withdraw" && armed === amount
                    ? `confirm ${sol(want)} ◎`
                    : want && want > 0
                      ? `${mode} ${sol(want)} ◎`
                      : mode}
              </button>

              <Line said={said} blocked={blocked} network={info?.network} />

              <p className="text-[12.5px] leading-relaxed text-[var(--color-dim)]">
                {mode === "deposit" ? (
                  <>
                    Your wallet approves the transfer, so it shows you the address and the
                    amount before you sign. Credited to{" "}
                    <b className="text-[var(--color-zinc-hi)]">
                      {wallet ? shortAddress(wallet) : "the wallet you signed in with"}
                    </b>
                    .
                  </>
                ) : (
                  <>
                    Paid to{" "}
                    <b className="text-[var(--color-zinc-hi)]">
                      {wallet ? shortAddress(wallet) : "the wallet you signed in with"}
                    </b>
                    , the only address the arcade will pay. Fee {sol(fee)} ◎, smallest
                    withdrawal {sol(floor)} ◎.
                  </>
                )}
              </p>

              {mode === "deposit" && info && (
                <div>
                  {manual ? (
                    <ManualAddress
                      info={info}
                      copied={copied}
                      onCopy={() => {
                        void navigator.clipboard
                          .writeText(info.address)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1400);
                          })
                          .catch(() => {});
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => setManual(true)}
                      className="chip label bg-[var(--color-panel2)] px-2 py-1 text-[var(--color-zinc-hi)] hover:text-[var(--color-text)]"
                    >
                      send it by hand instead
                    </button>
                  )}
                </div>
              )}

              <Receipts
                rows={rows}
                kind={kind}
                page={Math.min(page, pageCount)}
                pages={pageCount}
                total={totalRows}
                network={info?.network}
                onPage={goPage}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  color,
  note,
}: {
  label: string;
  value: string;
  color: string;
  note: string;
}): JSX.Element {
  return (
    <div className="flex-1 px-4 py-3">
      <div className="label">{label}</div>
      <div className="tnum mt-0.5 text-[22px] font-semibold" style={{ color }}>
        {value}
      </div>
      <div className="label mt-0.5 text-[9.5px]">{note}</div>
    </div>
  );
}

function Amount({
  amount,
  onAmount,
  ceiling,
  floor,
  disabled,
  onSubmit,
}: {
  amount: string;
  onAmount: (v: string) => void;
  ceiling: number | null;
  floor: number;
  disabled: boolean;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-end gap-2">
        <span className="label pb-2.5">amount</span>
        <input
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          disabled={disabled}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          aria-label="Amount"
          className="field tnum min-w-0 flex-1 px-1 py-1.5 text-right text-[26px] font-semibold text-[var(--color-text)] placeholder:text-[var(--color-edge2)]"
        />
        <span className="pb-1.5 text-[24px] text-[var(--color-zinc)]">◎</span>
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1 sm:grid-cols-7">
        {PRESETS.map(([text, lamports]) => {
          const over = ceiling !== null && lamports > ceiling;
          const under = lamports < floor;
          return (
            <button
              key={text}
              onClick={() => onAmount(text)}
              disabled={disabled || over || under}
              className="chip label px-1 py-1.5 disabled:text-[var(--color-edge2)]"
              title={over ? "more than you have" : under ? "under the smallest withdrawal" : undefined}
            >
              {text}
            </button>
          );
        })}
        <button
          onClick={() => ceiling !== null && onAmount(sol(ceiling))}
          disabled={disabled || ceiling === null || ceiling <= 0}
          className="chip label px-1 py-1.5 disabled:text-[var(--color-edge2)]"
        >
          max
        </button>
      </div>
    </div>
  );
}

function Position({
  position,
  absent,
  chips,
}: {
  position: GamePosition | null;
  absent: boolean;
  chips: boolean;
}): JSX.Element {
  if (absent) {
    return (
      <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
        This box does not keep a per-game record yet. Your balance and your receipts are
        unaffected — it is this one screen that has nothing to read.
      </p>
    );
  }
  if (!position) {
    return <p className="text-[13px] text-[var(--color-dim)]">reading the books…</p>;
  }

  const { wagered, returned, refunded, inPlay, rounds, net } = position;
  if (!wagered && !rounds) {
    return (
      <div className="space-y-2">
        <div className="label">thin ice · all time</div>
        <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
          {chips
            ? "This box deals house chips, so nothing you have played here moved real money — and the books this reads have no row for it."
            : "You have not staked anything here yet. Once you do, this is where the arithmetic lives: everything bet, everything settled back, and the difference."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <span className="label">thin ice · all time</span>
        <span className="label ml-auto">
          {rounds} {rounds === 1 ? "round" : "rounds"}
        </span>
      </div>
      <div>
        <Row label="bets in" lamports={wagered} />
        <Row label="settled back" lamports={returned} />
        {refunded > 0 && <Row label="refunded" lamports={refunded} />}
        {inPlay > 0 && <Row label="in play" lamports={inPlay} />}
        <Row label="net" lamports={net} total />
      </div>
      <p className="text-[12.5px] leading-relaxed text-[var(--color-dim)]">
        Every round you have ever played on <b className="text-[var(--color-zinc-hi)]">THIN ICE</b>{" "}
        with this wallet — not this session, and not your other games. Deposits and withdrawals
        are not in it: money moved is not money won.
      </p>
    </div>
  );
}

function Row({
  label,
  lamports,
  total = false,
}: {
  label: string;
  lamports: number;
  total?: boolean;
}): JSX.Element {
  const sign = lamports < 0 ? "−" : total ? "+" : "";
  const color = !total || lamports === 0
    ? undefined
    : lamports < 0
      ? "var(--color-danger)"
      : "var(--color-profit)";
  return (
    <div
      className={`flex items-baseline gap-3 py-1 ${
        total ? "mt-1 border-t border-[var(--color-line)] pt-2" : ""
      }`}
    >
      <span className={total ? "display text-[13px] tracking-[0.1em]" : "label"}>{label}</span>
      <span
        className={`tnum ml-auto ${total ? "text-[16px] font-semibold" : "text-[13px]"}`}
        style={color ? { color } : undefined}
      >
        {sign}
        {sol(Math.abs(lamports), 4)} ◎
      </span>
    </div>
  );
}

function Receipts({
  rows,
  kind,
  page,
  pages,
  total,
  network,
  onPage,
}: {
  rows: Movement[];
  kind: "in" | "out";
  page: number;
  pages: number;
  total: number;
  network?: string | null;
  onPage: (n: number) => void;
}): JSX.Element {
  const noun = kind === "out" ? "withdrawals" : "deposits";
  return (
    <div className="border-t border-[var(--color-line)] pt-2.5">
      <div className="flex items-baseline gap-3">
        <div className="label">{pages > 1 ? `${noun} · page ${page} of ${pages}` : noun}</div>
        {total > 0 && <div className="label ml-auto">{total}</div>}
      </div>
      {rows.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-[var(--color-dim)]">
          {kind === "out" ? "nothing withdrawn yet." : "nothing deposited yet."}
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((r) => {
            const void_ = r.kind === "in" && r.state === "reversed";
            const said =
              r.kind === "in"
                ? void_
                  ? "reversed"
                  : r.state === "confirming"
                    ? "confirming"
                    : "on chain"
                : r.state === "confirmed"
                  ? "on chain"
                  : r.state;
            return (
              <li key={r.id} className="flex items-baseline gap-3 text-[12.5px]">
                <span
                  className={`tnum font-semibold ${void_ ? "line-through" : ""}`}
                  style={{
                    color: void_
                      ? "var(--color-dim)"
                      : r.kind === "in"
                        ? "var(--color-profit)"
                        : "var(--color-zinc-hi)",
                  }}
                >
                  {r.kind === "in" ? "+" : "−"}
                  {sol(r.amount)} ◎
                </span>
                <span className="label flex-1 truncate">{when(r.at)}</span>
                <span className="label">
                  {r.signature ? (
                    <a
                      href={explorerUrl(r.signature, network)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--color-cyan)] hover:text-[var(--color-text)]"
                    >
                      {said}
                    </a>
                  ) : (
                    said
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 && <Pager page={page} pages={pages} onPage={onPage} />}
    </div>
  );
}

function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (n: number) => void;
}): JSX.Element {
  const list: Array<number | null> = [];
  if (pages <= 7) {
    for (let n = 1; n <= pages; n += 1) list.push(n);
  } else {
    const lo = Math.max(2, Math.min(page - 1, pages - 4));
    const hi = Math.min(pages - 1, Math.max(page + 1, 5));
    list.push(1);
    if (lo > 2) list.push(null);
    for (let n = lo; n <= hi; n += 1) list.push(n);
    if (hi < pages - 1) list.push(null);
    list.push(pages);
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {list.map((n, i) =>
        n === null ? (
          <span key={`gap${i}`} className="label px-1 text-[var(--color-edge2)]">
            ·
          </span>
        ) : (
          <button
            key={n}
            onClick={() => onPage(n)}
            disabled={n === page}
            aria-current={n === page ? "page" : undefined}
            className={
              n === page
                ? "label tnum rounded-sm bg-[var(--color-panel2)] px-2 py-1 font-bold text-[var(--color-cyan)]"
                : "chip label tnum px-2 py-1"
            }
          >
            {n}
          </button>
        ),
      )}
    </div>
  );
}

function when(ms: number): string {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleString([], opts);
}

function Line({
  said,
  blocked,
  network,
}: {
  said: Said | null;
  blocked: string | null;
  network?: string | null;
}): JSX.Element | null {
  const text = said?.text ?? blocked;
  if (!text) return null;
  const tone = said?.text ? said.tone : "bad";
  const color =
    tone === "go"
      ? "var(--color-profit)"
      : tone === "bad"
        ? "var(--color-danger)"
        : tone === "busy"
          ? "var(--color-cyan)"
          : "var(--color-dim)";
  return (
    <p className="text-[12.5px] leading-relaxed" style={{ color }}>
      {text}
      {said?.signature && (
        <>
          {" "}
          <a
            href={explorerUrl(said.signature, network)}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-cyan)] underline-offset-2 hover:underline"
          >
            view it on chain
          </a>
        </>
      )}
    </p>
  );
}

function Connect({
  busy,
  onConnect,
  said,
  mode,
  known,
}: {
  busy: boolean;
  onConnect: () => void;
  said: Said | null;
  mode: Mode;
  known: boolean;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
        {known
          ? "This wallet is connected to the table, but the bank answers to the arcade's own sign-in. One signature — every world on this domain honours it, and it moves nothing."
          : mode === "position"
            ? "Connect the wallet you play with to see what this game has done to it."
            : "Connect the wallet you want to play with. Signing proves it is yours, approves no transaction and moves nothing."}
      </p>
      <button
        disabled={busy}
        onClick={onConnect}
        className="display h-13 w-full rounded-sm bg-[var(--color-text)] py-3.5 text-[17px] font-bold tracking-[0.1em] text-[var(--color-pit)] transition-transform hover:brightness-95 active:scale-[0.985] disabled:cursor-not-allowed"
      >
        {busy ? "check your wallet…" : known ? "sign in" : "connect"}
      </button>
      <Line said={said} blocked={null} />
    </div>
  );
}

function ManualAddress({
  info,
  copied,
  onCopy,
}: {
  info: DepositInfo;
  copied: boolean;
  onCopy: () => void;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="label">send ◎ to this address</div>
      <code className="tnum block rounded-sm bg-[var(--color-panel2)] px-2.5 py-2 text-[11.5px] leading-relaxed break-all text-[var(--color-cyan)]">
        {info.address}
      </code>
      <button onClick={onCopy} className="chip label px-2 py-1">
        {copied ? "copied" : "copy address"}
      </button>
      <p className="border-l-2 border-[var(--color-danger)] pl-2.5 text-[12px] leading-relaxed text-[var(--color-zinc-hi)]">
        {info.warning}
      </p>
    </div>
  );
}
