# Before real money

The play-money beta cuts corners that are fine for play money and fatal for
real money. Every box below gets checked before BANKING=on faces the public.
Items marked (built) exist and only need to be turned on or verified; the
rest need building.

## Money and fairness

- [ ] **Wipe the beta DB.** Balances, tickets, rounds, history: all play
      money. Fresh ledger on day one, no exceptions.
- [ ] **Bots off.** BOTS=0. The boot guard (built) refuses BOTS>0 with
      BANKING=on; verify it fires, do not merely trust it.
- [ ] **Seed entropy.** Round seeds are server-chosen; a malicious operator
      could grind seeds before committing and no player could detect it.
      Mix public or client entropy into the commit preimage so the house
      provably cannot pick its own draw. The 2026-08-08 bonanza audit
      confirmed the ceremony is honest end to end, but honesty today is not
      proof against a hostile operator tomorrow.
- [ ] **House float monitoring.** Alert when the house wallet drifts from
      the ledger's expectation; a discrepancy is an incident, not a log line.

## Auth and abuse

- [ ] **Session token hardening.** Tokens are 192-bit random, compared with
      timingSafeEqual, minted only on signature (built). Add expiry,
      rotation on withdrawal, and a rate limit on `resume` attempts per IP.
- [ ] **Withdrawal path re-verified.** Withdrawals pay only the
      authenticated session's own wallet (built). Re-test after any auth
      change, every time.
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

## Paper

- [ ] **Jurisdiction and terms.** Real-money gaming has rules everywhere.
      Terms of service, age gating, and a jurisdiction call happen before
      launch, not after the first dispute.
