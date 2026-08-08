import { useState, type JSX } from "react";
import type { BankState, Snapshot } from "@/game/client";

/** The two moves a bank can make. NetClient implements this; the demo cannot. */
export interface Banker {
  deposit(sol: number): Promise<void> | void;
  withdraw(sol: number): void;
}

const DEPOSITS = [0.1, 0.5, 1];

/**
 * Deposit / withdraw against the house, devnet SOL.
 *
 * Deposits go through the player's own Phantom — the site never holds a key —
 * and are credited only after the server has verified the transaction on
 * chain. Withdrawals debit the ledger first and are paid from the house
 * wallet. Every outcome lands in `bank.note`, because money UI that fails
 * silently is money UI that reads as theft.
 */
export function BankPanel({
  snap,
  bank,
  client,
  onClose,
}: {
  snap: Snapshot;
  bank: BankState;
  client: Banker;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");

  const amount = Number(draft);
  const canWithdraw =
    Number.isFinite(amount) && amount >= 0.01 && amount <= snap.wallet && !bank.busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[360px] rounded-md bg-[var(--color-panel)] p-4 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <span className="display text-[13px] font-bold tracking-[0.12em]">bank</span>
          <span className="label ml-2">devnet</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="label ml-auto text-[var(--color-dim)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 text-center">
          <div className="label">balance</div>
          <div className="tnum text-[26px] font-bold text-[var(--color-zinc-hi)]">
            {snap.wallet.toFixed(4)} ◎
          </div>
        </div>

        <div className="mt-4">
          <div className="label mb-1.5">deposit from phantom</div>
          <div className="flex gap-1.5">
            {DEPOSITS.map((d) => (
              <button
                key={d}
                disabled={bank.busy}
                onClick={() => void client.deposit(d)}
                className="display flex-1 rounded-sm bg-[var(--color-panel2)] py-2 text-[13px] font-bold text-[var(--color-cyan)] hover:bg-[var(--color-edge)] disabled:opacity-40"
              >
                +{d} ◎
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <div className="label mb-1.5">withdraw to your wallet</div>
          <div className="flex gap-1.5">
            <input
              type="number"
              min={0.01}
              step={0.01}
              placeholder="0.00"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Withdraw amount"
              className="tnum w-full rounded-sm bg-[var(--color-panel2)] px-2 py-1.5 text-right text-[13px] font-semibold text-[var(--color-text)] outline-none focus:ring-1 focus:ring-[var(--color-cyan)]"
            />
            <button
              disabled={bank.busy}
              onClick={() => setDraft(snap.wallet > 0 ? String(Math.floor(snap.wallet * 100) / 100) : "")}
              className="label rounded-sm bg-[var(--color-panel2)] px-2 hover:text-[var(--color-text)] disabled:opacity-40"
            >
              max
            </button>
            <button
              disabled={!canWithdraw}
              onClick={() => {
                client.withdraw(amount);
                setDraft("");
              }}
              className="display rounded-sm bg-[var(--color-profit)] px-3 py-1.5 text-[12px] font-bold text-[#03231a] disabled:opacity-40"
            >
              send
            </button>
          </div>
        </div>

        {/* Status: in flight, succeeded, or exactly why it did not. */}
        <div
          className="tnum mt-3 min-h-[16px] text-center text-[11px]"
          style={{
            color: bank.busy
              ? "var(--color-warn)"
              : bank.ok === true
                ? "var(--color-profit)"
                : bank.ok === false
                  ? "var(--color-danger)"
                  : "var(--color-dim)",
          }}
        >
          {bank.busy ? bank.note || "working…" : bank.note}
        </div>

        <div className="mt-3 border-t border-[var(--color-panel2)] pt-2 text-[10px] leading-relaxed text-[var(--color-dim)]">
          Phantom must be set to <span className="text-[var(--color-text)]">devnet</span>{" "}
          (Settings → Developer Settings). Deposits credit after on-chain
          confirmation, usually a few seconds.
        </div>
      </div>
    </div>
  );
}
