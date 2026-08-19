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
 *
 * ── AND THEN THE PORTAL'S BANK GREW UP AND THIS ONE HAD NOT ─────────────────
 *
 * The panel that this replaced kept moving after it was replaced, and what it
 * learnt is worth having: every receipt reachable rather than the newest six,
 * the two directions separated so a deposit screen is not also a withdrawal
 * screen, a ladder of amounts so nobody opens a phone keyboard to put 0.05 in,
 * and a withdrawal that has to be pressed twice. All four are here now.
 *
 * WHAT IS NOT COPIED IS THE THIRD TAB, and it is the one thing on this panel
 * that could not be. The arcade's POSITION is about the WALLET -- deposited,
 * withdrawn, what is on the table across every world on the box -- and it is
 * the same figure at Barrows as it is here. Standing at one table, that answers
 * a question nobody asked: it moves when you deposit, which is not a result,
 * and it moves when you win somewhere else, which is not this game. So this
 * tab asks the narrower question, which is the only one a table can honestly
 * answer -- of everything staked HERE, how much came back -- and the sums are
 * done by the books (positionFor in the arcade's ledger.js), never here.
 */

type Mode = "deposit" | "withdraw" | "position";
type Tone = "dim" | "go" | "bad" | "busy";

interface Said {
  text: string;
  tone: Tone;
  /** A transaction to look at, when there is one. */
  signature?: string;
}

/** How long the panel keeps asking the chain about a transfer it just watched
    leave. Four seconds a tick, so this is two minutes. */
const WATCH_TICKS = 30;

/** Receipts to a page. Six fits above the fold on a phone with the form above it. */
const PER_PAGE = 6;

/**
 * THE QUICK AMOUNTS, ONE LADDER FOR BOTH DIRECTIONS.
 *
 * It starts at 0.01 because the first thing anybody does with a bank that
 * holds real money is put a trivial amount through it to see whether it works,
 * and a ladder whose bottom rung is five times that makes them open a phone
 * keyboard for the one deposit where they are most nervous.
 *
 * Both halves get the same rungs, and they are greyed differently: a deposit
 * chip by what the wallet can actually send, a withdrawal chip by what the
 * balance covers and by the withdrawal floor. Same ladder, different reach.
 */
const PRESETS: Array<[string, number]> = [
  ["0.01", 10_000_000],
  ["0.05", 50_000_000],
  ["0.1", 100_000_000],
  ["0.25", 250_000_000],
  ["0.5", 500_000_000],
  ["1", 1_000_000_000],
];

/**
 * HOW LONG A WITHDRAWAL STAYS ARMED.
 *
 * The withdraw button used to fire on the first press. It is the only control
 * in this game that moves money OUT to the chain and it is irreversible the
 * moment the signer takes it, so it asks twice -- and the arming is keyed on
 * the AMOUNT, so arming at 0.1, changing your mind and typing 0.5 does not
 * send 0.5 on a single press. An arming left alone expires, because a live one
 * is a trap laid for whoever next touches the phone.
 */
const ARM_MS = 5000;

/*
 * THE REFUSALS THAT MEAN THE MONEY DEFINITELY DID NOT MOVE.
 *
 * The box DEBITS THE LEDGER BEFORE it calls the signer, so "your balance has
 * not been touched" has to be earned by a named refusal rather than said after
 * every failure -- a dropped connection can reject the fetch with the transfer
 * already broadcast. Each code below is a path in custody.withdraw() that
 * either refuses before the debit or refunds it; anything else means this
 * browser does not know, and says so.
 *
 * ADDING A CODE HERE IS A CLAIM ABOUT THE SERVER. The list is the arcade's, in
 * arcade/web/bank.js, which has the long version and must not drift from this.
 */
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

/** The box's sentence, ended properly, so another can be put after it. */
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
  const [history, setHistory] = useState<CustodyHistory | null>(null);
  const [position, setPosition] = useState<GamePosition | null>(null);
  /** The box is older than this panel and has no per-game record in it. */
  const [noPosition, setNoPosition] = useState(false);
  /** Which page of the receipts, per direction: a tab keeps its own place. */
  const [pages, setPages] = useState<{ deposit: number; withdraw: number }>({
    deposit: 1,
    withdraw: 1,
  });
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  /** The wallet would not send a transaction, so fall back to the address. */
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The amount a second press would send, or null. See ARM_MS. */
  const [armed, setArmed] = useState<string | null>(null);

  /*
   * AND AN ARMING THAT HAS EXPIRED MUST STOP LOOKING ARMED.
   *
   * The expiry was enforced on the press and nowhere else, so a button left
   * alone went on saying CONFIRM in danger red while a press would only have
   * re-armed it. That is the wrong way round for the one control here that
   * cannot be undone: it looked like the second press would send and it would
   * not, which teaches people to press twice quickly at a button that
   * sometimes does send on the second press.
   */
  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);


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
  /** Which direction of receipts this tab is about. POSITION shows none. */
  const kind = mode === "withdraw" ? "out" : "in";
  const page = mode === "withdraw" ? pages.withdraw : pages.deposit;

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
  /** Cleared whenever the amount changes, which is what disarms the button. */
  const armedAt = useRef(0);

  /*
   * WHAT TO ASK FOR, IN A REF, SO THE POLL DOES NOT RESTART ON EVERY KEYSTROKE.
   *
   * refresh() has to know which direction and which page to fetch, and if it
   * closed over them it would be a new function on every tab press and every
   * page turn -- which restarts the four-second interval below, so a player
   * clicking through pages would never let a tick land.
   */
  const asking = useRef({ kind, page });
  asking.current = { kind, page };
  const onPosition = useRef(false);
  onPosition.current = mode === "position";

  const refresh = useCallback(async (): Promise<void> => {
    /*
     * WHO IS SIGNED IN IS READ, NOT REMEMBERED.
     *
     * This panel used to decide once, at mount, and then only ever change its
     * mind when somebody pressed CONNECT inside it. The session can be minted
     * by the button in the top bar, or arrive from the portal in a cookie
     * shared across the domain, or lapse -- and in every one of those cases an
     * open panel went on showing the state it opened with. The cookie is the
     * truth and it is a synchronous read.
     */
    setSignedIn(Boolean(arcadeToken()));
    if (!arcadeToken()) {
      setLedger(null);
      setChain(null);
      setHistory(null);
      setPosition(null);
      return;
    }
    const want = asking.current;
    // Four calls, one round trip's worth of waiting. A failure in any one of
    // them leaves that number stale rather than blanking the panel: a balance
    // that flickers to a dash on one bad request teaches people to distrust it.
    const [bal, hist, mine, pos] = await Promise.allSettled([
      arcadeApi<LedgerBalance>("/api/ledger/balance"),
      arcadeApi<CustodyHistory>(
        `/api/custody/history?kind=${want.kind}&page=${want.page}&perPage=${PER_PAGE}`,
      ),
      arcadeApi<ChainBalance>("/api/custody/wallet"),
      /*
       * ONLY WHILE SOMEBODY IS LOOKING AT IT. The other three are wanted on
       * every tab -- the balances head the panel and the deposit watch reads
       * the history -- but a per-game position nobody has opened is a request
       * every four seconds against a rate limit that exists to keep a player's
       * own money operations working.
       */
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
      /*
       * A BOX THAT HAS NOT BEEN RESTARTED ONTO A BUILD WITH THIS ROUTE SAYS SO
       * RATHER THAN SPINNING. The two halves of this site deploy separately, so
       * the page can be ahead of the server for as long as it takes somebody to
       * redeploy the box. Any other failure -- a timeout, a blip -- leaves the
       * last answer standing, because a position is not wrong merely because
       * one request did not arrive.
       */
      if ((pos.reason as ArcadeError)?.status === 404) setNoPosition(true);
    }
    if (hist.status === "fulfilled") {
      const rows = hist.value;
      setHistory(rows);
      // Their money arriving is the whole reason anybody is standing here, and
      // it is worth saying out loud rather than leaving them to notice that a
      // number changed. Counted off the box's own total for the IN direction:
      // the page in hand is six rows of it and would miss an arrival the
      // moment somebody turned to page two.
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

  /*
   * A DEPOSIT THAT FINISHED WHILE THIS PAGE DID NOT EXIST.
   *
   * Approving on a phone is a navigation: the wallet app replaces this tab and
   * the player comes back to a fresh load carrying the answer in the query
   * string. completeDeeplink() reads it and hands the box the signed
   * transaction; onDepositArrival says where the outcome is shown, and without
   * it the ARCADE'S OWN bank panel opens on top of this game -- a gold OSRS
   * window over a black rink, which is the exact thing ownBank exists to
   * prevent.
   *
   * Cheap on every other load: completeDeeplink returns immediately when there
   * is no reply in the URL.
   */
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

  // A tab press or a page turn is a new question, and it is asked immediately
  // rather than at the next tick: a list that takes four seconds to change
  // after a press reads as a press that did nothing.
  useEffect(() => {
    void refresh();
  }, [refresh, signedIn, mode, page]);

  useEffect(() => {
    const timer = setInterval(() => {
      // Ask the box to look for a deposit only while there is a reason to: a
      // transfer just watched out of the wallet, or a deposit screen somebody
      // is sitting in front of.
      const looking = watching.current > 0 || asking.current.kind === "in";
      if (watching.current > 0) watching.current -= 1;
      if (looking && arcadeToken()) void poke().then(refresh);
      else void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [poke, refresh]);

  // ------------------------------------------------------------- the numbers

  /*
   * WHAT MAY LEAVE, WHICH IS NOT THE BALANCE.
   *
   * A deposit is spendable the moment the chain confirms it, but it cannot go
   * back OUT until the block it landed in is finalised -- otherwise a reorg
   * takes back money the arcade has already signed away. The box enforces
   * that; `pending` is it saying how much, so the MAX button offers what will
   * be accepted rather than a number that comes back refused.
   */
  const free = ledger?.balance ?? 0;
  const pending = Number(history?.pending ?? 0);
  const withdrawable = Math.max(0, free - pending);
  const held = ledger?.held ?? 0;
  const fee = info?.networkFee ?? chain?.fee ?? 5000;
  const floor = info?.minWithdrawal ?? 0;
  const want = toLamports(amount);
  const typed = amount.trim() !== "";

  /*
   * THE BOX PAYS THE SESSION'S WALLET, AND THIS BROWSER MAY BE ON ANOTHER ONE.
   *
   * The extension can be switched to a different account at any moment and the
   * session it was signed with does not move with it. Whichever of the two is
   * stale, the player is not looking at the account about to be paid -- and a
   * withdrawal whose destination they cannot see is the one press here that
   * must not be available. Reconnecting settles it, because signing in again
   * is what makes the two agree.
   *
   * Read from the LEDGER rather than from `wallet` above, which falls back to
   * the carried cookie: a line that can disagree with the box about where
   * money goes is worse than no line.
   */
  const paying = ledger?.wallet ?? null;
  const onNow = walletProvider()?.provider?.publicKey?.toString() ?? null;

  /** What the amount field is allowed to do right now, and why not. */
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

  // ------------------------------------------------------------- the verbs

  const retype = (v: string): void => {
    setAmount(v);
    // Editing the field disarms: the second press must be for the amount the
    // first one was about.
    setArmed(null);
    if (said?.tone !== "busy") setSaid(null);
  };

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
      // The whole answer, not just the message: the box publishes the transfer
      // in two encodings because the wallet may refuse the documented one. See
      // approveTransfer for the deposit that proved it.
      // walletNow(), not walletProvider(): on a phone the wallet is not in the
      // page, and the injected-only lookup would answer null and send this
      // down the by-hand path for a player who has a perfectly good wallet one
      // app-switch away.
      const found = await walletNow();
      const signature = await approveTransfer(found?.provider ?? null, prep);
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
    setArmed(null);
    setSaid({ text: "asking the signer.", tone: "busy" });
    try {
      // Note the body: an amount, and nothing else. There is no destination
      // field, which is the line that makes the sentence under this button true.
      const out = await arcadeApi<WithdrawReceipt>("/api/custody/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: want }),
        // The box debits, then waits on a signer on another machine whose own
        // worst case is over a minute. Cutting this short would turn answers
        // that were coming into unknowns.
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
      // Back to the top of the withdrawals: the row somebody just made is the
      // row they want to see, and it is on page one.
      setPages((p) => ({ ...p, withdraw: 1 }));
      await refresh();
      landed.current?.();
    } catch (err) {
      // Say what the box said -- and only promise what the box answered. "the
      // signer is not attached" brings a player back rather than leaving them
      // to assume the arcade ate their money; the reassurance after it is
      // earned by UNTOUCHED above, never assumed.
      const e = err as ArcadeError;
      const sure = e?.answered === true && UNTOUCHED.has(e.code);
      const why = ended(e.message);
      setSaid({
        text: sure
          // The box sometimes says it itself, and saying it twice in two
          // different sentences reads as a script that is not listening.
          ? (/untouched/i.test(why) ? why : `${why} your balance has not been touched.`)
          : `${why} it may or may not have gone. do not send it again — check the receipts `
            + "below and the balance above in a few seconds.",
        // Red is "this did not happen"; the tone this panel already uses for a
        // withdrawal in flight is the honest colour for "we do not know".
        tone: sure ? "bad" : "busy",
      });
    } finally {
      setBusy(false);
    }
  };

  /** The one press that does something, whichever direction is up. */
  const act = (): void => {
    if (!ready) return;
    if (mode === "deposit") {
      void deposit();
      return;
    }
    // Twice, for the only control here that cannot be undone. See ARM_MS.
    const live = armed === amount && Date.now() - armedAt.current < ARM_MS;
    if (live) {
      void withdraw();
      return;
    }
    setArmed(amount);
    armedAt.current = Date.now();
    setSaid({ text: `press again to send ${sol(want)} ◎ to your wallet.`, tone: "dim" });
  };

  // ------------------------------------------------------------- the screen

  const rows: Movement[] = useMemo(() => {
    if (!history) return [];
    if (Array.isArray(history.rows)) return history.rows;
    /*
     * AN OLDER BOX ANSWERS IN THE OLD SHAPE. It is still sending both, so this
     * is only reached against a server behind this page -- and drawing its two
     * lists is better than drawing an empty panel where somebody's money
     * record was. Sliced to this direction, because the old shape is not.
     */
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
          {(["deposit", "withdraw", "position"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setSaid(null);
                setManual(false);
                setArmed(null);
              }}
              // Tinted by class, the way ActionBar tints its own verb. The
              // lit chip carries the colour of the direction money is about
              // to move, which is the same cyan/green pair the board uses for
              // going in and coming out. POSITION moves nothing, so it lights
              // in plain text: it is a place to look, not a verb.
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
          {/* THE FIRST THING TO GO WHEN THE ROW IS TIGHT. On a 390px phone three
              tabs and a sentence do not fit, and what broke was the sentence
              running into the tab beside it. The tabs say the same thing one
              word shorter, so the hint is a desktop luxury. */}
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
              /* Already known to this domain -- seated at the table, or signed
                 in at another world -- so the ask needs a reason. */
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
 * The amount, and the seven ways nobody has to type one.
 *
 * MAX is not the raw balance on either side. A wallet cannot send everything it
 * holds, because the network fee comes out of the same pocket; a balance cannot
 * all leave while part of it is resting on a block the chain has not finalised.
 * The box works out both and this uses whichever applies, so MAX never offers a
 * number that comes back refused.
 *
 * A RUNG IS GREYED RATHER THAN HIDDEN. A ladder that changes length as the
 * balance moves is a row of buttons that are never in the same place twice;
 * one that greys says which amounts are out of reach and why the reachable ones
 * stop where they do.
 */
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
  /** The smallest legal amount, or 0 where there is no floor. */
  floor: number;
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
      {/* A grid rather than a wrapping row: seven equal cells, so the ladder is
          the same shape whatever is in reach and MAX is always in the corner. */}
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

/**
 * WHAT THIS TABLE HAS DONE TO THIS WALLET, AND NOTHING ELSE.
 *
 * THE THREE THINGS IT IS NOT, because each of them is a number a player could
 * reasonably think this was, and every one of them would be a different answer:
 *
 *   NOT THE SESSION. It is every round ever played here on this wallet. A
 *   per-visit figure resets on a reload, which turns the one number a gambler
 *   checks into a number that only ever remembers the good half.
 *
 *   NOT THE ARCADE. Rounds at the other worlds on the box are not in it. The
 *   bank's own strip answers that question and moves when somebody wins
 *   somewhere else, which is not this game.
 *
 *   NOT THE BANK. Deposits and withdrawals are not results, and they are not
 *   in here. Money put in is not a loss and money taken out is not a win.
 *
 * A BALANCE SHEET, AND THE SIMPLEST ONE THERE IS: what went in as bets, what
 * came back as settlements, and the difference. `in play` is there so an open
 * round does not read as a loss the size of the stake for as long as it runs;
 * `refunded` is separate from `settled back` because a round that was given
 * back never paid anything.
 *
 * THE ARITHMETIC IS THE BOOKS', NOT THIS FILE'S. `net` is what the ledger
 * answered -- adding the rows up here would be a second implementation of it,
 * free to drift, and wrong in the place nobody would look.
 *
 * AND IT IS NOT THE STATS PANEL, WHICH IS THE OTHER NUMBER ON THIS PAGE THAT
 * LOOKS LIKE IT. That one is kept by THIS GAME'S database (players.wagered,
 * players.returned) and counts every round, house chips included; this one is
 * kept by the ARCADE'S ledger and only exists where real lamports moved. They
 * also treat a cancelled entry differently -- the game un-counts the wager, the
 * ledger keeps the stake and files a refund against it, which is why `refunded`
 * is a line here. `net` agrees either way, and that is the number to compare if
 * they ever appear to disagree.
 */
function Position({
  position,
  absent,
  chips,
}: {
  position: GamePosition | null;
  absent: boolean;
  /** This box takes no deposits, so every round here was house chips. */
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
          {/* AND ON A BOX WITH NO BANK, SAY WHICH KIND OF NOTHING THIS IS. A
              player who has just played forty rounds and is told they have
              staked nothing is being told the panel is broken. The rounds were
              real; the money was not, so the books have no row for them. */}
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

/**
 * ONE LINE OF THE BALANCE SHEET: a label, an amount, and the sign that makes it
 * mean something.
 *
 * The sign is written here rather than left to sol(), which formats a
 * magnitude. A minus is the whole message on the last line, and the plus is put
 * on the positive total for the same reason: "0.4 ◎" and "+0.4 ◎" are the same
 * number, but only one of them is obviously an amount somebody is UP. The three
 * lines above the total are magnitudes and a sign on them would be noise.
 *
 * Colour on the total only, and only when there is a direction. Dead even is
 * not a win and not a loss, and painting a zero green would be this panel's
 * first lie.
 */
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

/**
 * THE RECEIPTS, ONE DIRECTION AND ONE PAGE AT A TIME.
 *
 * SIX MERGED ROWS WAS NEVER THE WHOLE STORY. This drew the newest six of both
 * directions with nothing on screen admitting there were more, so a player's
 * own record of their own money stopped at six and the seventh was unreachable.
 * An arcade that cannot show somebody what it did with their money is not one
 * they should use.
 *
 * AND ONE DIRECTION, because the tab above already says which. Somebody who
 * came to check a withdrawal should not have to read past everything else they
 * have ever done to find it.
 */
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
      {/* AN EMPTY LIST IS STILL AN ANSWER. Filtered by tab, a player with ten
          deposits and no withdrawals presses WITHDRAW and the list vanishes,
          which reads as the panel forgetting something. */}
      {rows.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-[var(--color-dim)]">
          {kind === "out" ? "nothing withdrawn yet." : "nothing deposited yet."}
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((r) => {
            // A reversed deposit is money that came back out. It is still a
            // row -- the player saw the credit and is owed an explanation of
            // where it went -- but it must not read as a plus in the same
            // green as the ones that stuck.
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

/**
 * PAGE NUMBERS, NOT A "LOAD MORE".
 *
 * This is the record of what the arcade did with somebody's money: they need
 * to be able to go back to a particular page, and come back to it, and say
 * which one it was.
 */
function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (n: number) => void;
}): JSX.Element {
  /** First, last, and the neighbours of where you are. Gaps are elided. */
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

/**
 * WHEN, IN WORDS SOMEBODY CAN CHECK AGAINST THEIR OWN MEMORY.
 *
 * "Did I withdraw twice on Tuesday" is a question six undated rows could never
 * answer. The year appears only once it stops being obvious, and the player's
 * own locale decides the rest.
 */
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
  mode,
  known,
}: {
  busy: boolean;
  onConnect: () => void;
  said: Said | null;
  mode: Mode;
  /** This browser already carries a wallet, so the ask is owed a reason. */
  known: boolean;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-[var(--color-zinc-hi)]">
        {/*
          BEING ASKED AGAIN NEEDS A REASON, AND THERE IS ONE.
          A player seated at the table on a seat bought before this build --
          or on this game's own signature, because the arcade's issuer was not
          answering -- has proved themselves to the TABLE and not to the
          BOOKS. Those are different tokens with different issuers, and only
          the second can read a balance. Saying "connect" to somebody whose
          address is printed at the top of this very panel reads as the site
          forgetting them; saying which sign-in is missing does not. Anybody
          connecting through the top bar today gets the arcade's session with
          their first signature and never sees this.
        */}
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
