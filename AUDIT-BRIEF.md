# THIN ICE — full audit brief

You are auditing this repository from scratch. Read this whole brief first,
then do the work with subagents as described at the bottom. Everything you
need is in the repo at `C:\ZINC`.

## What this project is

THIN ICE (repo/brand name ZINC, formerly "Critical Mass") is a PvP
elimination casino game targeting Solana. Players pay a fixed entry (0.1
SOL) to stand on a plate in a hex lattice of ice. Twice a second every live
plate faces the same shatter probability. Fallen players' stakes are
redistributed to survivors, so one number (your multiple) climbs as others
die. You can extract at any moment and keep your multiple, or go under and
keep nothing. Last one standing gets auto-banked. It is currently a live
play-money beta (server on GCP, static client on Vercel); real money and
on-chain banking exist in code (Solana devnet) but are OFF in production.

The operator's core design values, in order: provable fairness, the
"fair game" property (below), terse flat UI, and mobile parity.

## The economics (audit against these numbers)

- Entry 0.1 SOL. Rake is 5% total, split in `packages/engine/src/config.ts`:
  2% bonanza jackpot pool + 2% revenue-share ("rakeback") + 1% house
  (called "platform fee" in UI). So 95% of entries stay in the round's pot
  and 99% flows back to players overall.
- **Fair-game property (the sacred invariant): every exit strategy has
  identical expected value.** No timing, no plate count, no strategy can
  change EV. The engine's design enforces this; sims verify it
  (`npm run sim:fairness`, `sim:invariants`). Any change that breaks this
  is a critical finding regardless of anything else.
- Bonanza: fires with probability 1/1500 per round (memoryless), pays the
  whole pool to ONE ticket drawn from all tickets since the last fire. Flat
  200 tickets per entry. Draw runs on a tagged RNG stream derived from the
  round's committed seed (`BONANZA_TAG`, `deriveRng`).
- Rev-share: permanent tickets, weight decays with a 45-day half-life via a
  decay-normalized O(1) ledger (`packages/engine/src/ledger.ts`).
- Provable fairness ceremony: before each round the server publishes
  sha256(`thinice:{roundId}:{seedHex}:{rulesHash}`); at close it reveals
  seedHex and writes a full replay record (JSON detail column in `rounds`).
  `packages/engine/src/fairness.ts` can recompute everything.

## Layout

npm workspaces monorepo:

- `packages/engine` — authoritative game math. Pure deterministic
  TypeScript, ZERO runtime deps. Round simulation, RNG (sfc32,
  commit/derive), hazard model, ledgers (BonanzaPool, rev-share), fairness
  verification. Everything money-related traces here.
- `packages/sim` — Monte Carlo studies (`npm run sim:*` scripts) used to
  validate the economics.
- `apps/server` — Node 22 + `node:sqlite` + `ws`, run via tsx. The real
  game server: lobbies, seats, sessions, wallet auth, practice bots,
  SQLite persistence, crash recovery, play-money banking, devnet Solana
  banking (off in prod). Key files: `game.ts` (the lobby/round state
  machine, ~1100 lines), `index.ts` (ws message handling + auth),
  `db.ts` (all SQL), `bank.ts`/related (Solana), `config.ts` (env).
- `apps/web` — React 19 + Vite 8 + Tailwind v4 client. Canvas renderer
  (`src/render/lattice.ts`), a full local demo client that mirrors server
  logic for offline play (`src/game/client.ts`), websocket client
  (`src/game/net.ts`), UI in `src/ui/`.
- `upload/zinc` — a STANDALONE copy of the web client (engine vendored
  into `upload/zinc/engine/`) that the non-technical operator drag-uploads
  to GitHub/Vercel. It must stay byte-identical to `apps/web` src/public
  (`diff -rq`). Divergence here ships silently to production.
- `tools/` — probe/crash/bank test harnesses (`npm run test:server`,
  `test:crash`, `test:bank`), art pipeline (`process_art.py`).

Useful commands: `npm run typecheck`, `npm run build`, `npm run sim`,
plus the test/sim scripts above. When running a local server for probing,
use `PORT=8899 BOTS=0` (the developer's browser tabs hold sockets against
the default port and trip MAX_PER_IP).

## Server concepts you must understand before judging it

- **Sessions/seats**: one ws session per connection; a wallet may hold
  multiple seats (multi-plate stacks) that cash out together. Guests get
  namespaced wallets (contain `:`), real wallets are Solana addresses.
- **Auth**: guest-first. Wallet connect = Phantom signMessage over a server
  nonce; on success the server mints a 192-bit bearer token
  (`wallet_tokens` table) that later sockets replay via a `resume` message
  (timingSafeEqual compare; never for namespaced wallets). Withdrawals pay
  ONLY the authenticated session's own wallet address.
- **Practice bots**: env BOTS (0-8). Full economic participants (tickets,
  rakeback, can win the bonanza) so the play-money economy is honest.
  Hard rules: always labeled `bot·name`, and the server refuses to boot
  with BOTS>0 while BANKING=on. Temperament table drives exit behavior;
  one shared "brain" per stack so a stack banks together.
- **Crash recovery**: on boot, any round that never reached closeRound is
  rolled back in full (all entries refunded, stats reversed).
- **Atomicity**: bonanza settlement (payout + ticket wipe + pool reset)
  is one transaction; check other multi-write paths for the same rigor.

## What I want from the audit

Audit EVERYTHING, but these are the priority axes:

1. **Money-path correctness.** Every lamport in and out: entries, payouts,
   cash-outs, refunds, bonanza, rakeback claims, withdrawals, bot minting.
   Look for paths where value is created, destroyed, or double-paid,
   especially across crashes, reconnects, and concurrent messages.
   Aggregate conservation must hold: payouts per round = 95% of entries,
   tickets per cycle = entries × 200.
2. **Security.** The ws message surface (every ClientMessage case in
   `index.ts`): validation, type confusion, replay, flooding. Auth: token
   lifecycle, nonce handling, signature verification (tweetnacl), guest
   wallet namespacing (can a client craft a wallet string that collides
   with or impersonates another?). SQL: all statements parameterized?
   Chat: XSS/injection into other clients. DoS: per-IP caps, message rate
   limits, unbounded loops or allocations reachable from the network.
3. **RNG and fairness.** Is any money-bearing decision on an uncommitted
   RNG? Can the recorded replay diverge from what players experienced?
   Does the demo client's mirror of server logic (client.ts) match server
   behavior everywhere it claims to (champion selection, payouts, hazard)?
4. **Database.** Schema sanity, index coverage for hot queries, transaction
   boundaries, WAL implications, the crash-recovery path, meta-table
   consistency (bonanzaPool, lastFireRound vs actual rounds).
5. **Bad and redundant code.** Dead exports, duplicated logic between
   server and demo client that could drift, copy-paste blocks, stale
   comments that lie about the code, config read by nobody.
6. **Client correctness.** Renderer state machine (lattice.ts cell
   lifecycle), reconnect handling in net.ts, localStorage handling,
   mobile layout regressions.
7. **upload/zinc sync.** Verify it is truly identical to apps/web
   (src, public, engine vendoring, vite config divergences that are
   INTENTIONAL: the baked ws URL differs). Flag any drift.

## Constraints, so you do not "fix" things that are on purpose

- The fair-game property overrides taste. Do not propose EV-changing
  features (grace periods that climb the multiplier, risk-weighted
  tickets, etc.).
- Bots with banking on must stay impossible. Play-money DB gets wiped
  before real money; do not design migrations for it.
- UI copy rules: never use the em dash character anywhere player-visible;
  terse copy; no gameplay advice implying colors/patterns are gameable
  (it is pure chance and must read as such).
- `upload/zinc` must remain a byte-identical mirror (except its
  vite.config.ts baked URL). Any fix to apps/web must be copied there.
- The beta server is live; this audit is code-only. Do not attempt to
  reach production systems.

## How to work

Spawn subagents and parallelize; do not read the whole repo in one
context. Suggested split: (a) engine math + sims, (b) server game.ts
state machine, (c) server auth/net surface + db.ts, (d) web client
game/net/render, (e) UI components + upload sync, (f) money-path
end-to-end tracer that follows one lamport through every flow. Then run
an adversarial verification pass over every candidate finding: a second
subagent tries to REFUTE each one against the actual code before it goes
in the report. I only want findings that survive.

Report format: ranked by severity (critical / high / medium / low /
nit), each with file:line, a one-sentence claim, the concrete failure
scenario (inputs/state that trigger it, what goes wrong), and the
minimal fix. Separate section for "redundant/dead code" and one for
"things that look wrong but are correct" (so I stop re-flagging them).
No style opinions, no rewrites for taste, no findings you could not
defend against the refuter.
