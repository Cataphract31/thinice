import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";

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
// Every in-flight verification is a polling loop against a shared,
// rate-limited RPC endpoint, and the per-socket busy flag only serializes
// one client. A global ceiling keeps a burst of bogus signatures from
// buying dozens of concurrent pollers at the server's expense.
let verifying = 0;
const MAX_VERIFYING = 4;

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

  if (verifying >= MAX_VERIFYING) {
    return { ok: false, lamports: 0, reason: "verifier busy — try again in a moment" };
  }
  verifying++;
  try {
    return await pollDeposit(sig, sender, house);
  } finally {
    verifying--;
  }
}

async function pollDeposit(
  sig: string,
  sender: PublicKey,
  house: PublicKey,
): Promise<DepositCheck> {
  // 8 x 2s, not 15: the client reports the signature after Phantom submits,
  // so confirmation is normally seconds away — the long tail only ever paid
  // RPC calls for signatures that would never land.
  for (let attempt = 0; attempt < 8; attempt++) {
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

export interface PreparedWithdrawal {
  /** Known BEFORE broadcast, so an intent row can be written first. */
  sig: string;
  lastValidBlockHeight: number;
  /** Broadcasts and waits for confirmation. Throws when either step fails. */
  send: () => Promise<void>;
}

/**
 * Builds and SIGNS a withdrawal without broadcasting it, so the signature is
 * known before any lamport can move. The old sendAndConfirmTransaction shape
 * meant a throw was indistinguishable from "never happened" — but an HTTP
 * timeout after the RPC node accepted the transaction is a transfer that
 * LANDED, and re-crediting on it paid the player twice. Intent first, then
 * broadcast, then judge failures with `withdrawalStatus`.
 */
export async function prepareWithdrawal(
  house: Keypair,
  toWallet: string,
  lamports: number,
): Promise<PreparedWithdrawal> {
  const to = new PublicKey(toWallet);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: to, lamports }),
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = house.publicKey;
  tx.sign(house);
  const sig = bs58.encode(tx.signature!);
  return {
    sig,
    lastValidBlockHeight,
    send: async () => {
      await connection.sendRawTransaction(tx.serialize());
      const conf = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (conf.value.err) {
        throw new Error(`transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
      }
    },
  };
}

/**
 * The on-chain truth about a broadcast withdrawal, for deciding what a
 * confirmation failure actually meant. "expired" is the only state that
 * PROVES the transfer can never land (its blockhash is beyond reuse);
 * "unknown" means nothing is proven and the debit must stand until it is.
 */
export async function withdrawalStatus(
  sig: string,
  lastValidBlockHeight: number,
): Promise<"landed" | "failed" | "expired" | "unknown"> {
  try {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = st.value[0];
    if (s) return s.err ? "failed" : "landed";
    const height = await connection.getBlockHeight("confirmed");
    return height > lastValidBlockHeight ? "expired" : "unknown";
  } catch {
    return "unknown";
  }
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
