import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

/**
 * The house wallet and the two on-chain money movements.
 *
 * Custodial by design for devnet: deposits land in one house account and
 * withdrawals are paid from it, with the game balance living in the SQLite
 * ledger in between. The dangerous work — proving a deposit actually
 * happened, and never crediting the same transaction twice — is done here and
 * in the transfers table, not in the client.
 *
 * The keypair is generated on first boot and kept in a local file that is
 * gitignored. It holds devnet SOL only; for mainnet this design is replaced
 * wholesale (hardware key or a PDA escrow program), not hardened.
 */

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

export const connection = new Connection(RPC_URL, "confirmed");

export function loadHouse(): Keypair {
  const path = process.env.HOUSE_KEYPAIR_PATH ?? "house-keypair.json";
  if (existsSync(path)) {
    return Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(readFileSync(path, "utf-8")) as number[]),
    );
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  console.log(`  house  generated new keypair at ${path}`);
  // Best-effort faucet call so a fresh devnet setup can pay withdrawals
  // immediately. Devnet airdrops are rate-limited and flaky; a failure here
  // is not an error, the wallet can be funded from any faucet by address.
  connection
    .requestAirdrop(kp.publicKey, 2_000_000_000)
    .then(() => console.log("  house  devnet airdrop requested (2 SOL)"))
    .catch(() => console.log("  house  airdrop unavailable — fund the address manually"));
  return kp;
}

export interface DepositCheck {
  ok: boolean;
  lamports: number;
  reason?: string;
}

/**
 * Verifies that a signature is a confirmed transaction which moved lamports
 * from the authenticated wallet into the house account, and returns how many.
 *
 * The chain is the authority here: the client names a signature and nothing
 * else. Amount credited is the house account's actual balance delta in that
 * transaction, so a transaction that pays the house from someone else's funds,
 * fails, or never confirms is worth exactly nothing.
 *
 * Polls briefly because the client reports the signature the moment Phantom
 * submits it, typically a second or two before the cluster confirms.
 */
export async function verifyDeposit(
  sig: string,
  senderWallet: string,
  house: PublicKey,
): Promise<DepositCheck> {
  let sender: PublicKey;
  try {
    sender = new PublicKey(senderWallet);
  } catch {
    return { ok: false, lamports: 0, reason: "bad wallet" };
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    const tx = await connection
      .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (tx) {
      if (tx.meta?.err) return { ok: false, lamports: 0, reason: "transaction failed on-chain" };
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
      const houseIdx = keys.findIndex((k) => k.equals(house));
      if (houseIdx < 0) return { ok: false, lamports: 0, reason: "not a transfer to the house" };
      // The connected wallet must have SIGNED this transaction. Crediting on
      // mere presence would let anyone claim someone else's deposit — the
      // depositor is whoever authorised it, not whoever reports it first.
      const signers = tx.transaction.message.header.numRequiredSignatures;
      const senderSigned = keys.slice(0, signers).some((k) => k.equals(sender));
      if (!senderSigned) return { ok: false, lamports: 0, reason: "not signed by your wallet" };
      const delta = (tx.meta?.postBalances[houseIdx] ?? 0) - (tx.meta?.preBalances[houseIdx] ?? 0);
      if (delta <= 0) return { ok: false, lamports: 0, reason: "no lamports reached the house" };
      return { ok: true, lamports: delta };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, lamports: 0, reason: "transaction not found — is Phantom on devnet?" };
}

/** Pays lamports from the house to a wallet. Throws on failure. */
export async function sendWithdrawal(
  house: Keypair,
  toWallet: string,
  lamports: number,
): Promise<string> {
  const to = new PublicKey(toWallet);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: to, lamports }),
  );
  return sendAndConfirmTransaction(connection, tx, [house], {
    commitment: "confirmed",
  });
}

export async function houseBalance(house: Keypair): Promise<number> {
  return connection.getBalance(house.publicKey).catch(() => 0);
}

/** Re-exported so index.ts can log which cluster this process is playing on. */
export { RPC_URL };
export const IS_DEVNET = RPC_URL.includes("devnet");

// Startup guard: this custodial hot-wallet design must never quietly run
// against mainnet. If someone points RPC_URL at mainnet, refuse to boot.
if (!IS_DEVNET && !process.env.I_UNDERSTAND_MAINNET_CUSTODIAL_RISK) {
  throw new Error(
    "chain.ts: RPC_URL is not devnet. The hot-wallet custodial flow is devnet-only; " +
      "a mainnet deployment needs a proper treasury design first.",
  );
}
