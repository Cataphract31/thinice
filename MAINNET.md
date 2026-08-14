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
      provably cannot pick its own draw. The ceremony has been audited
      honest end to end, but honesty today is not proof against a hostile
      operator tomorrow.
- [ ] **House float monitoring.** Alert when the house wallet drifts from
      the ledger's expectation; a discrepancy is an incident, not a log line.

## Auth and abuse

- [ ] **Session token hardening.** Tokens are 192-bit random, compared with
      timingSafeEqual, minted only on signature (built). Add expiry,
      rotation on withdrawal, and a rate limit on `resume` attempts per IP.
- [ ] **Withdrawal path re-verified.** Withdrawals pay only the
      authenticated session's own wallet (built). Re-test after any auth
      change, every time.
- [ ] **Withdrawal failure is not proof of failure.** A confirmation that
      throws is currently re-credited blind; if the transfer actually
      landed, the player keeps both. Write an intent row before
      broadcasting and re-query the signature's status before re-crediting.
- [ ] **Hold covers ALL reversible money.** The withdrawal hold guards
      mid-round cash-out profit, which is the only money the crash sweep
      can claw back now that nothing is streamed at seal (built). Still
      make shutdown close the open round instead of just stopping the
      timer.
- [ ] **Flip the banking default to off.** BANKING defaults to ON in
      config.ts and .env.example; play money is one forgotten env var away
      from being armed. The safe state should be a property of the code.
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


