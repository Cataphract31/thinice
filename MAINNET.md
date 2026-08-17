# Before real money

The closed beta cut corners that are fine for play money and fatal for real
money. Every box below gets checked before this faces the public. Items marked
(built) exist and only need verifying; the rest need building.

**SCOPE, AND IT CHANGED.** This game no longer banks. The house keypair, the
RPC connection, the deposit verifier and the withdrawal path were **deleted
from this repo**, not disabled — custody is one edge that belongs to the
arcade, and every custody item that used to live on this list has moved there
with the code. What remains below is what a GAME can still get wrong.

That deletion closed four boxes by making them unreachable rather than by
satisfying them, which is the better way to close a box: *flip the banking
default*, *withdrawal failure is not proof of failure*, *withdrawal path
re-verified*, and the bots interlock. None of them can regress, because none
of the code they guarded still exists.

## Money and fairness

- [ ] **Wipe the beta DB.** Rounds, history, profiles — all from a beta where
      the numbers meant nothing. Fresh state on day one, no exceptions.
- [x] **Bots.** Deleted rather than switched off. There is no flag left to set
      wrong because the code a flag would have guarded is gone.
- [ ] **Seed entropy.** Round seeds are server-chosen; a malicious operator
      could grind seeds before committing and no player could detect it.
      Mix public or client entropy into the commit preimage so the house
      provably cannot pick its own draw. The ceremony has been audited
      honest end to end, but honesty today is not proof against a hostile
      operator tomorrow.
- [ ] **Custody reconciliation** *(arcade, not here)*. The ledger's `~mint`
      balance is the negative of every lamport inside the arcade, which is
      exactly what the custody wallet must hold. Alert when the chain and that
      number disagree: a discrepancy is an incident, not a log line.

## Auth and abuse

- [ ] **Session token hardening.** Tokens are 192-bit random, minted only on
      signature (built). Add expiry and a rate limit on `resume` per IP.
- [ ] **Shutdown closes the open round** instead of just stopping the timer.
      The startup sweep makes a crash survivable either way, but a clean stop
      should not need the sweep to clean up after it.
- [ ] **Chat moderation.** Rate limits exist; real money attracts spam,
      phishing links, and impersonation. Minimum: link stripping, a mute
      tool, a report path.

## Operations

- [ ] **Off-box DB backups.** Cron a snapshot (VACUUM INTO) to storage that
      survives the VM dying. The beta already lost one box; real money does
      not get to say "oh well".
- [ ] **Real infrastructure.** Proper domain and TLS (not sslip.io), a VM
      with headroom, uptime monitoring with alerts, and a tested
      redeploy-from-zero runbook.
- [ ] **Load test.** MAX_PER_IP and the socket path have never seen a crowd.
      Simulate one before one arrives.


