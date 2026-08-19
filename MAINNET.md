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

**A SCREEN CAME BACK; THE CUSTODY DID NOT.** `apps/web/src/ui/Bank.tsx` and
`apps/web/src/game/arcade.ts` put deposits and withdrawals back in front of
the player, in this game's own furniture instead of the arcade's injected
panel. Nothing on that list moves: the browser talks to the arcade's custody
edge directly, this repo's server is not in the path, and the only bytes that
can move money are built by the arcade and signed by the player's own wallet.
The one thing it adds to a mainnet review is the client-side deposit flow, and
what has to be true of it is that it never composes a transaction and never
names a destination in either direction. Both are enforced at the arcade's
routes, not here.

## Money and fairness

- [ ] **Wipe the beta DB.** Rounds, history, profiles — all from a beta where
      the numbers meant nothing. Fresh state on day one, no exceptions.
- [x] **Bots.** Deleted rather than switched off. There is no flag left to set
      wrong because the code a flag would have guarded is gone.
- [ ] **Seed entropy.** Round seeds are still server-chosen. Mix public or
      client entropy into the seed preimage so the house provably cannot pick
      its own draw. The ceremony has been audited honest end to end, but
      honesty today is not proof against a hostile operator tomorrow.

      **THE ENTRY SET HALF OF THIS IS DONE, AND IT WAS THE WORSE HALF.** The
      seed used to be drawn at `openLobby`, before anybody joined, which meant
      the operator held it for the whole lobby. Elimination consumes one draw
      per live player in join order and the hazard curve reads `live/total`, so
      with a known seed *who dies is a pure function of join order and entrant
      count* — both of which the server decides, after seeing it. That needed
      no grinding at all: one honest seed and a free choice of ordering picks
      the winner, and the replay verifies perfectly, because the record
      faithfully states the order that was used.

      Now the lobby commits to a SECRET, the seed is derived at the seal from
      that secret plus a nonce drawn once the entrant list is final plus the
      entrant list itself, and the commitment carries a ceremony version so a
      record shaped like the old one cannot satisfy it. Nothing exists to steer
      with while the lobby is open, and changing, adding, dropping or
      reordering one entrant changes the seed to something nobody chose.

      What is left is exactly this box: an operator willing to redraw the seal
      nonce until it likes the simulated outcome. The fix is entropy the house
      does not choose, folded into the SEAL preimage — after the entrant list
      is final, not at lobby open, or it hands the same free choice back.
- [ ] **Custody reconciliation** *(arcade, not here)*. The ledger's `~mint`
      balance is the negative of every lamport inside the arcade, which is
      exactly what the custody wallet must hold. Alert when the chain and that
      number disagree: a discrepancy is an incident, not a log line.
- [ ] **Overdraft is capped by the exposure register** *(arcade, not here)*.
      This table now reserves its worst case at the seal and releases it at the
      close, so it finally appears in the box-wide total — but the register is
      only consulted when somebody RESERVES. `ledger.settle` funds a payout
      beyond what the house holds with `overdraft: true` and asks nobody, so
      the reservation is a figure on a dashboard rather than a limit. The
      arcade side has to refuse, or at minimum alert on, a settlement that
      overdraws `~house` past what that game reserved.

## Auth and abuse

- [x] **Session token hardening.** Tokens are 192-bit random and minted only on
      signature. They now also expire (`TOKEN_TTL_DAYS`, 30 by default, which
      is what the arcade's own sessions do), `resume` is rate limited per
      address across sockets rather than per socket, and the protocol has a
      `logout` message so disconnecting a wallet REVOKES the row instead of
      merely clearing the browser's copy. That last one was the sharp edge: the
      token rides in a cookie scoped to the whole arcade domain, so any XSS in
      any world on it lifted a permanent seat — and a seat is a money
      primitive, not griefing. Seat the victim, bond their five plates, enter
      the same lobby with your own wallet, extract yours and let theirs die.
- [x] **Shutdown closes the open round** instead of just stopping the timer.
      `GameServer.shutdown()` rolls the entries back and closes the round as
      interrupted, revealing its secret, so a deploy restart no longer leaves a
      published commitment nobody can ever ask about. The startup sweep is
      still the backstop for a hard crash — and it now reveals those rounds
      too, because the secret is written down when the lobby opens.
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


