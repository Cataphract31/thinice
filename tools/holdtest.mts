// Proves the withdrawal hold: rakeback pays at the SEAL of a round that can
// still crash, and a crashed round claws its payouts back — impossible once
// the lamports have left on-chain. So the ledger must refuse to let any
// unsettled (open-round) rakeback out the door, atomically, inside the debit
// statement itself. This is the whole race: seal-pay -> withdraw -> crash.
//
//   npm run test:hold
process.env.DB_PATH = `${process.env.TEMP}\\zinc-holdtest-${Date.now()}.db`;
const { Database } = await import("../apps/server/src/db.ts");
const db = new Database();
const W = "guest:holdtester";
db.player(W); // 5 SOL starting balance
let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  cond ? ok++ : bad++;
};

// Round 1 opens (endedAt NULL) and pays 0.5 SOL of rakeback at its seal.
db.openRound(1, "commit", Date.now());
db.payRakeback(1, W, 500_000_000, 500_000_000);
check("balance shows the drip", db.balanceOf(W) === 5_500_000_000);

// Withdrawing everything must refuse: 0.5 is clawback-able until the round closes.
check("full withdrawal refused while round open", !db.debitForWithdrawal(W, 5_500_000_000));
check("even settled+1 refused", !db.debitForWithdrawal(W, 5_000_000_001));
check("settled part withdraws fine", db.debitForWithdrawal(W, 5_000_000_000));
check("balance now exactly the held drip", db.balanceOf(W) === 500_000_000);
check("held drip still refused", !db.debitForWithdrawal(W, 1));

// Round closes: the drip settles and withdraws.
const noSettle = { bonanza: null, tickets: [], bonanzaPool: "0" };
db.closeRound(1, "seed", 2, 10, 1, null, null, 0, "{}", "digest", noSettle);
check("after close the drip withdraws", db.debitForWithdrawal(W, 500_000_000));
check("balance zero, nothing minted or lost", db.balanceOf(W) === 0);

// The SECOND class of reversible money: a mid-round cash-out's PROFIT. The
// crash sweep claws back `returned - staked`, so profit banked in an open
// round must be held exactly like unsettled rakeback — this was the gap the
// original test never exercised, which is why the missing hold passed it.
db.adjustBalance(W, 1_000_000_000);
db.openRound(2, "commit2", Date.now());
check("entry taken", db.takeEntry(2, W, 100_000_000, 1));
check("staked, balance 0.9", db.balanceOf(W) === 900_000_000);
db.settleEntry(2, W, 1, 260_000_000, 2.6, 10, "cashed", true);
check("cash-out credited, balance 1.16", db.balanceOf(W) === 1_160_000_000);
check("full withdrawal refused while round open", !db.debitForWithdrawal(W, 1_160_000_000));
check("even settled+1 refused", !db.debitForWithdrawal(W, 1_000_000_001));
check("settled part withdraws fine", db.debitForWithdrawal(W, 1_000_000_000));
check("held profit still refused", !db.debitForWithdrawal(W, 1));
db.closeRound(2, "seed2", 2, 10, 2.6, null, null, 0, "{}", "digest2", noSettle);
check("after close the profit withdraws", db.debitForWithdrawal(W, 160_000_000));
check("balance zero again, nothing minted or lost", db.balanceOf(W) === 0);

db.close();
console.log(bad === 0 ? "\n  WITHDRAWAL HOLD HOLDS\n" : `\n  ${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
