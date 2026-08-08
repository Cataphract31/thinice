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
FULL participants in the same economy they sit in: same rake, same rakeback
tickets, same bonanza odds per entry (a bot can win the jackpot — excluding
them would quietly stage every human's apparent odds). They play continuously,
humans present or not, so the ticket economies pay around the clock and a
visitor always walks into a running game.

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

packages/sim       Verification. Not tests of the code — measurements of the
                   ECONOMICS, over hundreds of thousands of rounds. These are
                   what back the RTP claims.

apps/server        The authoritative game server. Node 22 + node:sqlite + ws.
                   Owns rounds, balances, the clock, the fairness ceremony,
                   and the house wallet. Money is integer LAMPORTS here.

apps/web           React 19 + Vite. Two clients behind one `Snapshot` type:
                   NetClient (talks to the server) and GameClient (a local
                   single-player demo used when no server is configured).
                   Every component upstream is identical in both modes.

tools              End-to-end tests that run against a real server process.

upload/zinc        BUILD ARTIFACT — a standalone copy of the web client for
                   Vercel. Generated, never edited by hand. See Deploying.

art-drop           Raw art masters (gitignored). The README in it has the
                   exact generation prompts; the packed output ships in
                   apps/web/public.
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
npm run sim:fairness    # RNG quality, replay determinism, jackpot derivation
npm run sim:invariants  # the martingale + pot conservation, asserted
npm run sim             # full economics: RTP by strategy, pacing, jackpot
npm run test:server     # 30 end-to-end checks against a running server
npm run test:crash      # kills the server mid-round, asserts nobody loses money
npm run test:hold       # unsettled seal-time rakeback cannot be withdrawn
npm run test:bank       # real devnet deposit + withdraw round trip
```

`test:server` and `test:crash` need a server; `test:bank` starts its own.

> `test:bank` **skips** if devnet's faucet is rate-limited. It has not yet
> completed a full green run for that reason — the deposit/withdraw path is the
> least-exercised code in the repo. Fund the house address the server prints at
> boot and re-run before trusting it.

---

## The economics

| | |
|---|---|
| Entry | 0.1 SOL, fixed for everyone |
| Rake | 5% — 2% jackpot, 2% rakeback, 1% platform fee |
| In-game RTP | **95.00%** |
| Headline RTP | **99.00%** — only the platform 1% is a true edge |

The jackpot and the rakeback stream are both player money, which is why 99% is
the honest published figure. Only 1% is house revenue.

**The in-game return is identical for every cash-out strategy.** Balance is
conserved and every live player holds the same balance, so no exit timing beats
any other — strategy buys variance, never expected value. This is asserted, not
assumed: `sim:invariants` fails the build if the spread across strategies drifts
or if conservation leaves 100.000%.

**Multi-betting.** One wallet may hold up to five plates in a round — press
bond again to buy another; one cash-out extracts every live plate together at
the shared multiple. This changes no odds: EV per plate is identical however
many one wallet holds (ownership does not exist in the engine — deaths roll
and redistribute per plate), and `npm run sim:multi` measures it. What it buys
is breadth: k plates in one round is actually *lower* variance than the same k
entries across k rounds, because when one of your plates breaks, your own
surviving plates recover their pro-rata share of it. A round still needs two
DISTINCT wallets to seal — one person's plates against themselves is not PvP —
and the moment every live plate belongs to one wallet the round ends itself,
banking that owner on the spot: their deaths would only pass money between
their own hands, so nothing is left to play for. The ending is implemented as
genuine engine cash-outs, so the fairness record replays unchanged.

Two ticket economies, both flat at 200 tickets per entry:

- **Bonanza** — a winner-take-all jackpot, ~1/1500 chance per round. Tickets
  wipe for everyone when it fires, so each cycle is a fresh raffle.
- **Rakeback** — 2% of every entry streams continuously to ticket holders,
  including on rounds they sat out. Weight decays with a 45-day half-life
  (continuously, per ticket, from the moment it was earned — there is no decay
  job and no interval), so the stream tracks recent volume instead of lifetime
  volume. Paid automatically into the balance the moment each round SEALS —
  the rake is collected by then, so the stream is a settled fact — and nobody
  claims anything. A crashed round claws its seal-time payouts back as part
  of the startup refund (`rakeback_payouts` is the per-round record that
  makes those fractional reversals possible).

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
5. the jackpot draw came off the committed seed, not a number the house picked

All five are computed in the player's browser from the record. The server is
never asked to confirm anything — that is the entire point.

Some non-obvious things that are load-bearing. Do not "simplify" them:

- **The seed must be 128 bits.** A 32-bit seed makes the published commitment a
  brute-force oracle: enumerate 4.3 billion candidates inside the lobby and you
  know every elimination before the round starts. The commitment intended to
  prove fairness becomes the thing that breaks it. `rngFromSeedHex` refuses a
  short seed at the source.
- **Player strategies must never draw from the round's RNG.** The draw count is
  what makes replay work. Bots (in the demo) and the jackpot both run on
  separate streams for this reason.
- **The client pins the commitment it saw during the lobby** and refuses a
  finished round whose commitment differs. Checking a server-supplied seed
  against a server-supplied hash that arrived in the same message proves only
  that the server can run sha256.
- **The replayed seed and the revealed seed must be the same seed.** They are
  two fields; if they are allowed to differ, an operator can commit to one seed,
  play on another, and still show three green ticks.

`packages/sim/src/fairness.ts` certifies all of this and fails loudly.

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
- [ ] **Get `npm run test:bank` to a full green run.** The money loop has never
      completed a live round trip.
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

### The `upload/zinc` preview copy

`upload/zinc` is a **standalone copy** of the client that builds with no
monorepo around it (it carries its own copy of the engine, aliased in its
`vite.config.ts`), used for a zero-cost preview deploy. If you are building
from this repo you do not need it. It is generated output:

```bash
rm -rf upload/zinc/src upload/zinc/engine upload/zinc/public
cp -r apps/web/src        upload/zinc/src
cp -r packages/engine/src upload/zinc/engine
cp -r apps/web/public     upload/zinc/public
cp    apps/web/index.html upload/zinc/index.html
```

**Never edit `upload/zinc/src` or `upload/zinc/engine` directly** — it silently
diverges from the real source, and has done so before. Re-sync after any client
change and verify with `diff -rq apps/web/src upload/zinc/src`.

For the current preview it is copied into the `void-website` repo under `zinc/`,
and nothing goes at that repo's root.

Set `VITE_SERVER_URL` at build time or you get the offline demo — with no server
URL the entire networking and wallet layer is tree-shaken out and the deploy is
single-player against simulated opponents. It looks like a working game, which
is exactly what makes it worth stating twice.

---

## Conventions

- **Money is integer lamports** at every persistence boundary. The engine works
  in SOL floats; conversion happens only at the edge, via `toLamports`/`toSol`.
- **Constants are derived, never restated.** Rake, tick interval and entry are
  read from `DEFAULT_CONFIG` even in player-facing copy — a hardcoded rake
  figure in the UI has already gone stale once.
- **Comments explain why, not what.** Several of them are the only record of a
  bug that cost real debugging. The ones marked as load-bearing above are
  warnings, not trivia.
