# THIN ICE

A PvP elimination casino game for [zinc.cash](https://zinc.cash), on Solana.

Everyone pays the same entry and stands on a frozen lattice. Every half second
the dice roll and the ice can take anyone still on it; whatever a fallen player was
holding is split among the survivors, so one shared multiplier climbs as the
field empties. Cash out whenever you like and keep what you are holding, or get
caught and keep nothing. Last one standing takes the rest.

It is player-versus-player. The house does not take a position in any round —
it takes a fixed cut of the entries and nothing else. **There are no bots.**
A lobby is real people or it is empty, and an empty one simply rolls over
until somebody arrives. There is no mode, flag or environment variable that
can seat a non-human: that code was deleted rather than switched off, because
a setting which fakes a busy room is one deployment mistake away from doing it
in front of real money. A visitor who finds the room quiet is being told the
truth about how quiet it is.

---

## Read this first if you are picking the project up

Three things decide whether you can trust anything below.

1. **`packages/engine` is the only place outcomes are decided.** Both the
   server and the browser import it. If a number disagrees anywhere, the engine
   is right and the caller is wrong.
2. **`apps/server` is the only authority over money.** Clients send intents
   ("I want in", "get me out") and render what comes back. A client cannot make
   itself survive a tick, pay itself, or learn a seed early, because it is
   never given the chance to hold any of that.
3. **`apps/server/src/chain.ts` is the entire on-chain surface.** Everything
   that touches a keypair, an RPC, or a signature lives in that one file. The
   game logic never touches a wallet. This is the seam you are meant to
   replace — see [Taking this to mainnet](#taking-this-to-mainnet).

---

## Layout

```
packages/engine    Authoritative game logic. Rounds, hazard curve, RNG,
                   ledgers, the provable-fairness record format.
                   Zero dependencies, runs identically in Node and a browser.

apps/server        The authoritative game server. Node 22 + node:sqlite + ws.
                   Owns rounds, balances, the clock, the fairness ceremony,
                   and the house wallet. Money is integer LAMPORTS here.

apps/web           React 19 + Vite. A pure screen for the server's state.
                   One client only, NetClient. Without a server address it
                   refuses to start; there is no offline mode to fall into.

art-drop           The art recipe — the exact generation prompts for every
                   character and tile. The packed output ships in
                   apps/web/public; the raw masters are not kept in-tree.
```

## Running it

Requires Node 22+ (the server uses `node:sqlite`).

```bash
npm install

npm run server     # game server on :8787
npm run dev        # web client on :5173
```

With no `VITE_SERVER_URL` set, the web client runs the **local demo**: opponents
are simulated in your browser, the balance is `localStorage`, and no money or
multiplayer exists. That mode is for UI work. To play the real game, point it at
the server:

```bash
echo "VITE_SERVER_URL=ws://127.0.0.1:8787" > apps/web/.env.local
```

Every environment variable the code reads is documented in `.env.example`.

## Verifying it

Nothing below is a claim you have to take on faith. All of it runs.

```bash
npm run typecheck       # all three projects
```

The economics simulators and the adversarial test harnesses (crash recovery,
withdrawal holds, devnet banking round trips) were retired in August 2026 with
the play-money beta they were built to certify. What they measured is quoted in
[The economics](#the-economics) below. Treat those as findings about the code as
it stood, not as a suite you can re-run: anything you need for mainnet should be
rebuilt against the code as it ships.

The fairness claim a player can check needs no harness at all, and it is the one
that matters publicly. It verifies in the client itself: every finished round
replays in the browser from its revealed seed, against the commitment published
before it sealed.

> **This repo still holds no key and signs nothing.** It now carries a deposit
> and withdrawal *screen* — `apps/web/src/ui/Bank.tsx` — but every verb behind
> it is an HTTP call to the arcade's custody edge, which is a different process
> on a different box. The deposit half asks that edge for the bytes of a
> transfer and hands them to the player's own wallet to approve; the withdrawal
> half posts an amount and no destination, because the payee is whichever
> wallet the session proved. Proving the round trip out is still the first item
> of real work before real money, and it is the arcade's edge to prove, not
> this game's. See [MAINNET.md](MAINNET.md).

---

## The economics

| | |
|---|---|
| Entry | 0.1 SOL, fixed for everyone |
| Rake | 2% — 0.5% platform fee, 1.5% token buyback and burn |
| RTP | **98.00%**, and that is the whole figure |

There is no second number to add. Nothing is pooled, streamed, decayed or
claimed: 98% of every entry goes into the pot of the round that entry paid for,
and every lamport of that pot leaves via a player before the round closes.

This replaced a 5% rake that returned four of its five points through a jackpot
and a rakeback ledger — 99% on paper. Measured over a 135,000-round population,
it was not: 97.5% of wallets never won the jackpot, and the two points funding
it simply left them. Paying those points inside the round moved the **median
wallet up 1.21 points**, took 81.8% of wallets with it, and cut the variance a
player is exposed to by 79% — four fifths of it had been a 1-in-1300 event
almost nobody was ever in.

**The in-game return is identical for every cash-out strategy.** Balance is
conserved and every live player holds the same balance, so no exit timing beats
any other — strategy buys variance, never expected value. This was measured, not
assumed: the invariants sweep ran every exit rule against this engine and found
no spread between them, with conservation landing on 100.000%. Re-measured at
2% over 400,000 paired rounds: a bolter, a rider and a 2x target all return the
same expected multiple, and the paired difference is indistinguishable from
zero. What a policy buys is shape — standard deviation 0.28 bolting against
1.87 riding — never edge.

**Multi-betting.** One wallet may hold up to five plates in a round — press
bond again to buy another; one cash-out extracts every live plate together at
the shared multiple. This changes no odds: EV per plate is identical however
many one wallet holds (ownership does not exist in the engine — deaths roll
and redistribute per plate), and the multi-plate sweep measured it. What it buys
is breadth: k plates in one round is actually *lower* variance than the same k
entries across k rounds, because when one of your plates breaks, your own
surviving plates recover their pro-rata share of it. A round still needs two
DISTINCT wallets to seal — one person's plates against themselves is not PvP —
and the moment every live plate belongs to one wallet the round ends itself,
banking that owner on the spot: their deaths would only pass money between
their own hands, so nothing is left to play for. The ending is implemented as
genuine engine cash-outs, so the fairness record replays unchanged.

Design notes and the measurements behind them are in the config comments —
`packages/engine/src/config.ts` is worth reading in full before changing a
number.

---

## Provable fairness

When a lobby opens, the server draws a 128-bit **secret** from the OS CSPRNG
and publishes

```
sha256("thinice:2" + ":" + roundId + ":" + secret + ":" + rulesHash)
```

When the lobby seals — entrant list final, before the first roll — it draws a
second 128-bit **seal nonce**, and the seed the round actually runs on is

```
sha256("thinice-seed:" + secret + ":" + sealNonce + ":" + entrantIds.join(","))
```

Both are revealed when the round ends, and the browser then rebuilds the seed,
replays the entire round locally, and shows four receipts:

1. the revealed secret hashes to the commitment published **before** the round
2. the round replays tick-for-tick to the same outcome, from a seed rebuilt
   from the entrant list the record claims
3. it ran under the rules this build advertises (the rules are in the hash)
4. your own plate in the replay paid exactly what you were credited

All four are computed in the player's browser from the record. The server is
never asked to confirm anything — that is the entire point.

Some non-obvious things that are load-bearing. Do not "simplify" them:

- **The seed must be 128 bits.** A 32-bit seed makes the published commitment a
  brute-force oracle: enumerate 4.3 billion candidates inside the lobby and you
  know every elimination before the round starts. The commitment intended to
  prove fairness becomes the thing that breaks it. `rngFromSeedHex` refuses a
  short seed at the source.
- **The seed is not drawn until the lobby seals, and the entrant list is inside
  it.** Elimination consumes one draw per live player in join order and the
  hazard curve reads `live/total`, so a seed known during the lobby makes who
  dies a pure function of join order and entrant count — both of which the
  server decides, after seeing it. No grinding needed: one honest seed and a
  free choice of ordering picks the winner, and the replay verifies perfectly
  because the record honestly states the order that was used. Deriving the seed
  at the seal means there is nothing to steer with while the lobby is open, and
  binding the entrant ids means changing, adding, dropping or reordering one of
  them changes the seed to something nobody chose.
- **The ceremony version is inside the commitment.** Without it an operator
  could commit under the ceremony above and then ship a record shaped like the
  one that predates it; the verifier would fall back to the older chain, whose
  hash it can still compute, and the downgrade would render green.
- **Player strategies must never draw from the round's RNG.** The draw count is
  what makes replay work. Bots run on a separate stream for this reason.
- **The client pins the commitment it saw during the lobby** and refuses a
  finished round whose commitment differs. Checking a server-supplied seed
  against a server-supplied hash that arrived in the same message proves only
  that the server can run sha256 — so a round this browser never witnessed
  from its lobby is shown as **"not witnessed"**, never as verified, no matter
  how self-consistent its record is. The pin lives across reloads in
  localStorage; the pinning itself happens only while a lobby is open, because
  after the seal a commit is a description, not a promise.
- **The replayed seed and the revealed secret must be one hash apart, checked.**
  They are two fields; if they are allowed to drift, an operator commits to one
  draw, plays on another, and still shows green ticks.
- **A round nobody finished is still revealed.** A crash, a deploy restart or a
  throw in the tick loop closes the round as `interrupted` and publishes its
  secret, because a round that published a commitment and moved real SOL must
  never become one the operator cannot be asked about. Such a round has no
  outcome to replay against, and the panel says exactly that rather than
  reporting a mismatch it has not found.

All of it is enforced by `verifyEntry` in `apps/web/src/game/client.ts` — the
same code path a player's own browser runs, not a separate certifier that could
drift from it.

---

## Taking this to mainnet

**This game no longer banks.** It holds no keypair and opens no RPC connection
— `chain.ts` and everything that called it were deleted, not disabled.

It does have a bank *screen* again, which is a different claim. `Bank.tsx` and
`game/arcade.ts` are a client for somebody else's custody edge: they read a
balance, ask the arcade to build the bytes of a transfer, and hand those bytes
to the player's own wallet. The server in this repo never sees any of it. The
worst bug reachable from that screen is a request the arcade refuses.

That was the last structural difference between this game and the others in
the arcade. It used to generate its own custodial hot wallet on first boot and
pay withdrawals from it; every other game did not, which meant the arcade had
one game that could sign a transfer and five that could not. Six games each
holding a hot wallet is six deposit verifiers, six double-credit defences and
six chances to get one of them wrong.

So money enters and leaves at **one edge, which belongs to the arcade and not
to any game**. A game moves numbers in the shared ledger; that is its entire
relationship with money. The blast radius of a bug in this repo is now a
mispriced round, never a signed transfer.

### Hard requirements before real money

- [ ] **Build the arcade's one custody edge** — hot/cold split, withdrawal
      caps, and monitoring. This is now arcade work, not game work.
- [x] **Remove guest accounts.** `{t:"guest", id}` used to accept any id as a
      bearer token: anyone who learned an id could spend against it. The
      branch is deleted. A visitor without a wallet may still watch, but the
      server names that connection itself (`~spec:…`), it is read-only — no
      chat, no join, no settings — and it is issued no token, so there is
      nothing to learn, steal or squat. Anything with a voice or a seat
      requires a signed wallet.
- [ ] **Prove the deposit/withdraw round trip on devnet** at the arcade edge.
      The money loop has never completed a live round trip. (The client now
      also verifies the arcade's prepared deposit — amount and destination —
      before handing it to the wallet, so a hostile custody edge cannot get
      extra signed.)
- [x] **Bind the login challenge to a domain** (SIWS-style) and enforce an
      Origin allowlist on the websocket upgrade. The server folds its public
      origin into the signed text (`site: …`, from `PUBLIC_ORIGIN`) and hands
      the client the exact bytes to sign; the upgrade is refused for any page
      origin not on `ALLOWED_ORIGINS`. Both are documented in
      `.env.example`.
- [ ] **Terminate TLS** in front of the server (`wss://`). Note the fairness
      panel needs a secure origin: `crypto.subtle` does not exist otherwise and
      rounds render as "unverifiable" rather than verified.
- [ ] **Independent security audit.** This codebase was written and audited by
      the same author. That catches a lot and cannot catch a shared blind spot.

### Known and accepted, but worth knowing

- **Chat has no moderation tooling.** Lines are rate-limited per socket,
  length-capped, and stripped of control/bidi/zero-width codepoints, and chat
  lives in memory only — but there is no mute, ban, or wordlist. Fine for
  devnet; a public mainnet room wants at least an operator mute.
- **`outcomeDigest` uses float formatting**, whose precision ECMAScript does
  not fully specify across engines. A last-ulp difference could theoretically
  flip a digest and accuse an honest server. Roughly one in 10^7; fixing it
  invalidates every stored digest, so it needs a planned migration, not a
  drive-by change.
- **The websocket error handler and the last-player cash-out deadlock are the
  two fixes tests cannot see directly** (they live inside the connection
  loop). The frame payload cap, the message budget, resume rate limiting,
  token TTL, nonce single-use and the X-Forwarded-For trust rule are all now
  encoded in `apps/server/test/auth.test.ts` and `wire.test.ts`, which boot
  the real server and attack it over real sockets.
- **SQLite is single-writer.** One server process. Horizontal scaling means
  changing the store, not adding processes.

---

## Deploying

**See [DEPLOYMENT.md](DEPLOYMENT.md)** for putting this on your own
infrastructure — static hosting, the Node process, nginx/Caddy websocket
config, TLS, and the two failure modes that waste a day if nobody warns you
(the server URL is baked in at build time, and a default reverse-proxy config
silently breaks websockets).

Nothing in the code is platform-specific. The `vercel.json` at the root exists
only because the current free preview deploy runs there; any host can ignore it.

## Conventions

- **Money is integer lamports** at every persistence boundary. The engine works
  in SOL floats; conversion happens only at the edge, via `toLamports`/`toSol`.
- **Constants are derived, never restated.** Rake, tick interval and entry are
  read from `DEFAULT_CONFIG` even in player-facing copy — a hardcoded rake
  figure in the UI has already gone stale once.
- **Comments explain why, not what.** Several of them are the only record of a
  bug that cost real debugging. The ones marked as load-bearing above are
  warnings, not trivia.
