import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  approveTransfer,
  arcadeApi,
  ArcadeError,
  arcadeSignIn,
  arcadeToken,
  explorerUrl,
  sol,
  toLamports,
  walletProvider,
  type ChainBalance,
  type CustodyHistory,
  type DepositInfo,
  type LedgerBalance,
  type PreparedDeposit,
  type WithdrawReceipt,
} from "@/game/arcade";
import { setWalletOptIn, walletCarried } from "@/game/net";
import { shortAddress } from "@/game/names";
import { useEscape } from "@/ui/esc";

/**
 * MONEY IN AND OUT, IN THIS GAME'S OWN FURNITURE.
 *
 * The arcade ships one bank for every world it hosts: one gold button in the
 * corner and one modal behind it, set in the portal's interface face. That is
 * right for a shelf of tables that look like each other, and wrong here. On a
 * near-black rink with cyan ice it arrived as somebody else's browser
 * extension floating over the board, which is a poor look for the single most
 * important control on the page: a control people distrust is a control they
 * do not press.
 *
 * So the arcade's tab is switched off for this world (`ownBank` in the
 * arcade's games.js) and this stands in its place. Same ledger, same custody
 * wallet, same withdrawal that can only ever pay the address that signed in.
 * Nothing about the money changed. What changed is that it is this game's
 * furniture now, in this game's palette, behind the same wallet chip the top
 * bar already carries.
 *
 * THE DEPOSIT DOES THE TRANSFER FOR YOU, WHICH IS THE REAL CHANGE. Depositing
 * used to be: here is our address, copy it, paste it into your wallet, type
 * the amount, get the network right, and hope. Every one of those is a place
 * to lose money nobody can give back, and pasting an address is the step
 * clipboard-swapping malware was written for. Now the arcade builds the
 * transfer and the wallet is asked to approve it, with the destination and the
 * amount rendered by software the player already trusts instead of typed by
 * them into a box on a web page.
 *
 * THE BYTES ARE NOT BUILT HERE. See game/arcade.ts for why not, at length.
 *
 * The manual path is still one press away for any wallet that will not answer
 * signAndSendTransaction. It is a fallback rather than the front door, and it
 * is the only place the "money from an exchange is credited to the exchange"
 * warning still appears: on the automatic path the transfer leaves the wallet
 * that signed in, by construction, so there is nothing left to warn about.
 */

type Mode = "deposit" | "withdraw";
type Tone = "dim" | "go" | "bad" | "busy";

interface Said {
  text: string;
  tone: Tone;
  /** A transaction to look at, when there is one. */
  signature?: string;
}

const EMPTY_HISTORY: CustodyHistory = { deposits: [], withdrawals: [] };

/** How long the panel keeps asking the chain about a transfer it just watched
    leave. Four seconds a tick, so this is two minutes. */
const WATCH_TICKS = 30;

export function BankOverlay({
  onClose,
  onBalanceMoved,
  onSignedIn,
}: {
  onClose: () => void;
  /** Fired when money has actually landed, so the game can re-read the books. */
  onBalanceMoved?: () => void;
  /** Fired when a wallet signs in to the arcade from here, so the game can
      take the seat that session is worth. */
  onSignedIn?: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>("deposit");
  const [signedIn, setSignedIn] = useState(() => Boolean(arcadeToken()));
  const [info, setInfo] = useState<DepositInfo | null>(null);
  /** Distinguishes "still asking" from "this box takes no deposits". */
  const [asked, setAsked] = useState(false);
  const [ledger, setLedger] = useState<LedgerBalance | null>(null);
  const [chain, setChain] = useState<ChainBalance | null>(null);
  const [history, setHistory] = useState<CustodyHistory>(EMPTY_HISTORY);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  /** The wallet would not send a transaction, so fall back to the address. */
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);

  /*
   * A STRAY ESCAPE MUST NOT TAKE THE RECEIPT AWAY.
   *
   * While a transfer is in flight this panel is the only place the signature
   * and the "waiting for the network" line will ever appear, and the wallet
   * popup standing over it is exactly when somebody presses Escape or clicks
   * beside it. The X still closes, because that is somebody deciding to; the
   * two accidental ways out are shut until the answer is on screen.
   */
  const glance = (): void => {
    if (!busy) onClose();
  };
  useEscape(glance);

  const wallet = ledger?.wallet ?? walletCarried();
  const walletName = walletProvider()?.name ?? "your wallet";

  /*
   * A transfer we watched leave: poll hard until the arcade sees it, then
   * stop. Counted in ticks so a tab left open overnight is not still asking.
   * A ref rather than state because the poll reads it and setting it must not
   * restart the interval.
   */
  const watching = useRef(0);
  const seenDeposits = useRef<number | null>(null);
  const landed = useRef(onBalanceMoved);
  landed.current = onBalanceMoved;
  const seated = useRef(onSignedIn);
  seated.current = onSignedIn;

  const refresh = useCallback(async (): Promise<void> => {
    if (!arcadeToken()) {
      setLedger(null);
      setChain(null);
      setHistory(EMPTY_HISTORY);
      return;
    }
    // Three calls, one round trip's worth of waiting. A failure in any one of
    // them leaves that number stale rather than blanking the panel: a balance
    // that flickers to a dash on one bad request teaches people to distrust it.
    const [bal, hist, mine] = await Promise.allSettled([
      arcadeApi<LedgerBalance>("/api/ledger/balance"),
      arcadeApi<CustodyHistory>("/api/custody/history"),
      arcadeApi<ChainBalance>("/api/custody/wallet"),
    ]);
    if (bal.status === "fulfilled") setLedger(bal.value);
    if (mine.status === "fulfilled") setChain(mine.value);
    if (hist.status === "fulfilled") {
      const rows = hist.value ?? EMPTY_HISTORY;
      const before = seenDeposits.current;
      const now = rows.deposits?.length ?? 0;
      setHistory(rows);
      seenDeposits.current = now;
      // Their money arriving is the whole reason anybody is standing here, and
      // it is worth saying out loud rather than leaving them to notice that a
      // number changed.
      if (before !== null && now > before) {
        watching.current = 0;
        const newest = rows.deposits[0];
        setSaid({ text: `credited. ${sol(newest?.lamports)} ◎ is in your balance.`, tone: "go" });
        landed.current?.();
      }
    }
  }, []);

  /** "Somebody is watching." The box holds its own cooldown, so leaning on
      this cannot make the arcade hammer its RPC provider. */
  const poke = useCallback(async (): Promise<void> => {
    try {
      await arcadeApi("/api/custody/deposit/check", { method: "POST" });
    } catch {
      /* the box's own periodic scan still gets it */
    }
  }, []);

  // The address is public on purpose, so this answers before anybody has
  // signed in and the deposit half can be read by a player who has connected
  // nothing yet.
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
    void refresh();
  }, [refresh, signedIn]);

  useEffect(() => {
    const timer = setInterval(() => {
      // Ask the box to look for a deposit only while there is a reason to: a
      // transfer just watched out of the wallet, or a deposit screen somebody
      // is sitting in front of.
      const looking = watching.current > 0 || mode === "deposit";
      if (watching.current > 0) watching.current -= 1;
      if (looking && arcadeToken()) void poke().then(refresh);
      else void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [mode, poke, refresh]);

  // ------------------------------------------------------------- the numbers

  const free = ledger?.balance ?? 0;
  const held = ledger?.held ?? 0;
  const fee = info?.networkFee ?? chain?.fee ?? 5000;
  const want = toLamports(amount);
  const typed = amount.trim() !== "";

  /** What the amount field is allowed to do right now, and why not. */
  let blocked: string | null = null;
  if (!signedIn) blocked = "connect a wallet first.";
  else if (!info) blocked = "this box is not handling deposits.";
  else if (!typed) blocked = null;
  else if (want === null || want <= 0) blocked = "that is not an amount of ◎.";
  else if (mode === "deposit") {
    if (chain && want > chain.spendable) {
      blocked = `${walletName} holds ${sol(chain.lamports)} ◎, and ${sol(fee)} of it stays behind for the network fee.`;
    }
  } else if (want > free) blocked = `you have ${sol(free)} ◎.`;
  else if (want < (info?.minWithdrawal ?? 0)) {
    blocked = `the smallest withdrawal is ${sol(info?.minWithdrawal)} ◎.`;
  }

  const ready = signedIn && Boolean(info) && typed && want !== null && want > 0 && !blocked && !busy;

  const ceiling = mode === "deposit" ? (chain?.spendable ?? null) : free;

  // ------------------------------------------------------------- the verbs

  const connect = async (): Promise<void> => {
    setBusy(true);
    setSaid({ text: "check your wallet.", tone: "busy" });
    try {
      const address = await arcadeSignIn();
      /*
       * Tell the GAME too, not just this panel. An arcade session is the
       * strongest seat there is here -- the socket carries it and the table
       * seats the wallet on it -- but the socket was opened before any of
       * this happened, so without a reconnect the player watches their real
       * balance in the bank while sitting at the table as a guest.
       */
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
      // No destination in this body. `to` is custody and `from` is whoever the
      // session proved; neither is ours to choose.
      const prep = await arcadeApi<PreparedDeposit>("/api/custody/deposit/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: want }),
      });
      setSaid({ text: "approve it in your wallet.", tone: "busy" });
      const signature = await approveTransfer(walletProvider()?.provider ?? null, prep.message);
      setAmount("");
      setSaid({
        text: `${sol(want)} ◎ sent. waiting for the network.`,
        tone: "go",
        signature,
      });
      // Poll hard for two minutes. The arcade's own scan is a minute wide,
      // which is far too slow for somebody standing here watching.
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
    setSaid({ text: "asking the signer.", tone: "busy" });
    try {
      // Note the body: an amount, and nothing else. There is no destination
      // field, which is the line that makes the sentence under this button true.
      const out = await arcadeApi<WithdrawReceipt>("/api/custody/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: want }),
      });
      setAmount("");
      setSaid({
        text: out.signature
          ? `${sol(out.receiving)} ◎ on its way.`
          : `${sol(out.receiving)} ◎ accepted, waiting on the signer.`,
        tone: "go",
        signature: out.signature ?? undefined,
      });
      await refresh();
      landed.current?.();
    } catch (err) {
      // Say what the box said. The refusals here are the useful ones: "the
      // signer is not attached" means withdrawals are paused because the
      // machine holding the key is away, and a player told that will come back
      // rather than assume the arcade ate their money. Their balance is
      // untouched on every one of these paths, which is the sentence worth
      // adding.
      setSaid({ text: `${(err as ArcadeError).message} your balance has not been touched.`, tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------- the screen

  const rows = [
    ...(history.deposits ?? []).map((d) => ({
      key: `d${d.signature}`,
      at: d.at,
      into: true,
      lamports: d.lamports,
      signature: d.signature,
      state: "on chain",
    })),
    ...(history.withdrawals ?? []).map((w) => ({
      key: `w${w.signature ?? w.at}`,
      at: w.at,
      into: false,
      lamports: w.sent,
      signature: w.signature,
      state: w.state === "confirmed" ? "on chain" : w.state,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);

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
          {/* Only once there is a session behind it. The address cookie is a
              claim the whole arcade carries, and printing it beside a balance
              of zero says "you are connected" to somebody who is not. */}
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

        {/* The two numbers, scored by one soft hairline rather than boxed. The
            left is money that can play; the right is money that cannot, until
            it comes through this panel. */}
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
          {(["deposit", "withdraw"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setSaid(null);
                setManual(false);
              }}
              // Tinted by class, the way ActionBar tints its own verb. The
              // lit chip carries the colour of the direction money is about
              // to move, which is the same cyan/green pair the board uses for
              // going in and coming out.
              className={
                mode === m
                  ? `label rounded-sm px-2.5 py-1.5 font-bold ${
                      m === "deposit"
                        ? "bg-[var(--color-cyan)] text-[#03211f]"
                        : "bg-[var(--color-profit)] text-[#03231a]"
                    }`
                  : "chip label px-2.5 py-1.5"
              }
            >
              {m}
            </button>
          ))}
          <span className="label ml-auto">
            {mode === "deposit" ? "wallet to balance" : "balance to wallet"}
          </span>
        </div>

        <div className="space-y-3 px-4 pb-4 pt-3">
          {!signedIn ? (
            <Connect busy={busy} onConnect={connect} said={said} />
          ) : asked && !info ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
              This box is not handling real money yet, so there is nothing to deposit into.
              Everything you play with is house chips.
            </p>
          ) : (
            <>
              <Amount
                amount={amount}
                onAmount={(v) => {
                  setAmount(v);
                  if (said?.tone !== "busy") setSaid(null);
                }}
                ceiling={ceiling}
                disabled={busy}
                onSubmit={() => {
                  if (ready) void (mode === "deposit" ? deposit() : withdraw());
                }}
              />

              <button
                disabled={!ready}
                onClick={() => void (mode === "deposit" ? deposit() : withdraw())}
                className={`display h-13 w-full rounded-sm py-3.5 text-[17px] font-bold tracking-[0.1em] transition-transform active:scale-[0.985] disabled:cursor-not-allowed ${
                  !ready
                    ? "bg-[var(--color-panel2)] text-[var(--color-dim)]"
                    : mode === "deposit"
                      ? "bg-[var(--color-cyan)] text-[#03211f]"
                      : "bg-[var(--color-profit)] text-[#03231a]"
                }`}
              >
                {busy
                  ? "check your wallet…"
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
                    withdrawal {sol(info?.minWithdrawal)} ◎.
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
            </>
          )}

          {rows.length > 0 && (
            <div className="border-t border-[var(--color-line)] pt-2.5">
              <div className="label mb-1">recent</div>
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={r.key} className="flex items-center gap-3 text-[12.5px]">
                    <span
                      className="tnum font-semibold"
                      style={{ color: r.into ? "var(--color-profit)" : "var(--color-zinc-hi)" }}
                    >
                      {r.into ? "+" : "-"}
                      {sol(r.lamports)} ◎
                    </span>
                    <span className="label ml-auto">
                      {r.signature ? (
                        <a
                          href={explorerUrl(r.signature, info?.network)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--color-cyan)] hover:text-[var(--color-text)]"
                        >
                          {r.state}
                        </a>
                      ) : (
                        r.state
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One of the two balances. No surface, no border: a label over a number. */
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

/**
 * The amount, and the four ways nobody has to type one.
 *
 * MAX is not the raw balance on the deposit side: a wallet cannot send
 * everything it holds, because the network fee comes out of the same pocket,
 * and a MAX built from the raw number produces a transaction that fails for
 * insufficient funds. The box works out what is actually sendable and this
 * uses that.
 */
function Amount({
  amount,
  onAmount,
  ceiling,
  disabled,
  onSubmit,
}: {
  amount: string;
  onAmount: (v: string) => void;
  ceiling: number | null;
  disabled: boolean;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-end gap-2">
        {/* Named on the left so the row reads as a field. Without it the
            number floats in the middle of the panel with nothing holding it. */}
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
      <div className="mt-1.5 flex items-center gap-1">
        {[0.1, 0.5, 1].map((v) => (
          <button
            key={v}
            onClick={() => onAmount(String(v))}
            disabled={disabled}
            className="chip label px-2 py-1"
          >
            {v}
          </button>
        ))}
        <button
          onClick={() => ceiling !== null && onAmount(sol(ceiling))}
          disabled={disabled || ceiling === null}
          className="chip label px-2 py-1"
        >
          max
        </button>
      </div>
    </div>
  );
}

/** One line of state, in the colour that state deserves. */
function Line({
  said,
  blocked,
  network,
}: {
  said: Said | null;
  blocked: string | null;
  network?: string | null;
}): JSX.Element | null {
  // What the panel just did outranks what it will not let you do: a receipt
  // for money that has left is the one sentence somebody is actually reading.
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

/** Nobody is signed in to the arcade yet, so nothing here has a balance. */
function Connect({
  busy,
  onConnect,
  said,
}: {
  busy: boolean;
  onConnect: () => void;
  said: Said | null;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
        Connect the wallet you want to play with. Signing proves it is yours, approves no
        transaction and moves nothing.
      </p>
      <button
        disabled={busy}
        onClick={onConnect}
        className="display h-13 w-full rounded-sm bg-[var(--color-text)] py-3.5 text-[17px] font-bold tracking-[0.1em] text-[var(--color-pit)] transition-transform hover:brightness-95 active:scale-[0.985] disabled:cursor-not-allowed"
      >
        {busy ? "check your wallet…" : "connect"}
      </button>
      <Line said={said} blocked={null} />
    </div>
  );
}

/**
 * The old way, kept for wallets that will not sign a transaction from a page.
 *
 * This is where the exchange warning lives, and it is the one mistake this
 * screen can let somebody make that nobody can undo: money sent from an
 * exchange arrives from the exchange's own hot wallet, so the arcade credits
 * an address the player cannot sign for. The wording comes from the box, so
 * there is one version of it and it is the one custody.js can defend.
 */
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
