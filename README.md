# THIN ICE

A PvP elimination casino game for [zinc.cash](https://zinc.cash), on Solana.

Everyone pays the same entry and stands on a frozen lattice. Every half second
the dice roll and the ice can take anyone still on it; whatever a fallen player was
holding is split among the survivors, so one shared multiplier climbs as the
field empties. Cash out whenever you like and keep what you are holding, or get
caught and keep nothing. Last one standing takes the rest.

It is player-versus-player. The house does not take a position in any round —
it takes a fixed cut of the entries and nothing else. **There are no hidden
bots.** A lobby is real people or it is empty — with one loudly-declared
exception: in play-money mode the server may seat a few PRACTICE bots
(`BOTS=n`, default 0) so the room is always live. Two structural rules keep
that honest: every practice bot is labelled `bot·name` on every surface, and
the server refuses to boot with bots and banking enabled together — a bot may
never share a table with real money. Within the play-money room the bots are
FULL participants in the same economy they sit in: same rake, same odds, same
pot. They play continuously, humans present or not, so a visitor always walks
into a running game.

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

> **The deposit/withdraw path has never completed a full live round trip** and
> is the least-exercised code in the repo. Proving it out is the first item of
> real work before banking faces anyone — see [MAINNET.md](MAINNET.md).

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

Before a round seals, the server publishes

```
sha256("thinice:" + roundId + ":" + seedHex + ":" + rulesHash)
```

The seed is 128 bits from the OS CSPRNG. It is revealed when the round ends,
and the browser then replays the entire round locally and shows five receipts:

1. the revealed seed hashes to the commitment published **before** the round
2. the round replays tick-for-tick to the same outcome
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
- **Player strategies must never draw from the round's RNG.** The draw count is
  what makes replay work. Bots run on a separate stream for this reason.
- **The client pins the commitment it saw during the lobby** and refuses a
  finished round whose commitment differs. Checking a server-supplied seed
  against a server-supplied hash that arrived in the same message proves only
  that the server can run sha256.
- **The replayed seed and the revealed seed must be the same seed.** They are
  two fields; if they are allowed to differ, an operator can commit to one seed,
  play on another, and still show three green ticks.

All three are enforced by `verifyEntry` in `apps/web/src/game/client.ts` — the
same code path a player's own browser runs, not a separate certifier that could
drift from it.

---

## Taking this to mainnet

The game is ready to build on. The banking layer is **deliberately not**.

`chain.ts` implements a **custodial hot wallet**: the server holds a keypair,
players deposit to it, the SQLite ledger tracks balances, and withdrawals are
paid from it. That is a reasonable devnet play-money design and an unacceptable
mainnet one. The server **refuses to start against a non-devnet RPC** so this
cannot ship by accident.

Replacing it should not require opening the engine. Deposits are already
verified against the chain rather than trusted from the client, and every
credit is keyed on the transaction signature, so replaying one credits nothing.

### Hard requirements before real money

- [ ] **Replace the custodial wallet** with an escrow program / PDA, or at
      minimum move the key to an HSM with withdrawal limits and monitoring.
- [ ] **Remove guest accounts.** `{t:"guest", id}` accepts any id as a bearer
      token: anyone who learns an id can spend that balance. Fine for devnet
      play money, unacceptable for real money. Delete the branch and require a
      signed wallet.
- [ ] **Set `STARTING_BALANCE=0`.** New wallets are currently granted 5 SOL of
      play money on first sight.
- [ ] **Prove the deposit/withdraw round trip on devnet.** The money loop has
      never completed a live round trip, under a harness or otherwise.
- [ ] **Bind the login challenge to a domain** (SIWS-style) and enforce an
      Origin allowlist on the websocket upgrade. Today the signed text is just
      `THIN ICE login\nnonce: …`, so a signature is not tied to this site.
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
- **`outcomeDigest` uses `Math.pow`**, whose precision ECMAScript does not
  specify. A last-ulp difference between engines could theoretically flip a
  digest and accuse an honest server. Roughly one in 10^7; fixing it invalidates
  every stored digest, so it needs a planned migration, not a drive-by change.
- **Four fixes are not covered by tests** and can regress silently: the
  last-player cash-out deadlock, the websocket error handler, the frame payload
  cap, and the rate-limit clamp. Worth encoding before the next big change.
- **SQLite is single-writer.** One server process. Horizontal scaling means
  changing the store, not adding processes.

---

## Deploying

**See [DEPLOYMENT.md](DEPLOYMENT.md)** for putting this on your own
infrastructure — static hosting, the Node process, nginx/Caddy websocket
config, TLS, and the two failure modes that waste a day if nobody warns you
(the server URL is baked in at build time, and a default reverse-proxy config
silently breaks websockets). It also covers the intended opening move: an
open play-money launch (`BANKING=off` — real multiplayer, fake balances, no
chain) and the one migration trap when real money later arrives.

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
