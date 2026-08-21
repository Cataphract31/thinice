# THIN ICE — Pre-Launch Audit

**Date:** 2026-08-21 · **Scope:** full repo (`apps/server`, `apps/web`, `packages/engine`, vendor, deploy config, tests, git hygiene)
**Verification run during audit:** `npm test` 141/141 pass · typecheck clean across all three projects · `npm audit --omit=dev` = 0 vulnerabilities · no secrets or DB files tracked in git.

---

## Executive summary

No critical, directly-exploitable money bug was found. The architecture holds: the engine is the single decision point and conserves balance (tested), the server is the only money authority, the repo holds no keys, and the ledger blast radius of any bug here is "a mispriced round", not "a signed transfer". Integer-lamport discipline at every persistence boundary is real, not aspirational.

The findings that matter are concentrated in three bands:

1. **Pre-mainnet blockers the project already knows about** (guest accounts, unbound login challenge, no Origin allowlist) — confirmed still present, plus one *new* one (deposit bytes never verified client-side before signing).
2. **The fairness claim is weaker than the UI implies** for rounds the browser did not observe from the lobby — the "✓ fair" badge can be earned vacuously.
3. **The network boundary is the untested band**: zero tests cover auth, token expiry, rate limits, or the X-Forwarded-For trust assumption; the systemd unit does not enforce the documented no-egress policy.

Severity counts: **0 Critical · 4 High · 8 Medium · 12 Low · info notes.**

---

## HIGH

### H1. Deposit transaction bytes are never verified client-side before signing
`apps/web/src/game/arcade.ts:178-203`, `apps/web/src/ui/Bank.tsx:302-309`

The deposit flow asks the arcade to prepare a transfer, then hands the returned bytes straight to `signAndSendTransaction`. The client already knows what it asked for (`want`, integer lamports) and receives `prep.lamports` / `prep.to` / `info.address` — but never checks `prep.lamports === want`, never checks `prep.to === info.address`, and never decodes the transaction. The wallet popup is the only guard. A compromised or hostile custody endpoint could return a transaction for more than requested or to a different destination, and a user who habitually approves will sign it.

**Fix:** assert amount and destination match before calling `approveTransfer`; ideally decode the tx and display its true contents. (The wrong-*sender* check at `arcade.ts:170-176` exists and is good — this is the amount/destination half that's missing.)

### H2. Login challenge is not domain-bound; no Origin allowlist on the WS upgrade
`apps/server/src/index.ts:59-61` (`challengeText`), `index.ts:161` (no origin check)

The signed text is just `THIN ICE login\nnonce: <hex>`. A malicious site can open its own socket, obtain a nonce, relay it to a victim's wallet extension as an innocuous sign-message request, and use the signature + wallet on that socket to get a fully seated session as the victim. The signature proves wallet possession but is not bound to this site, so it is replayable across origins. Already on the README mainnet checklist; confirming it is still live code.

**Fix:** SIWS-style challenge including the exact domain + URI, and reject upgrade requests whose `Origin` header is not on an allowlist.

### H3. Guest accounts are bearer-token identities
`apps/server/src/index.ts:336-344`

`{t:"guest", id}` seats any sanitized id with no proof of ownership. Current impact is bounded — `game.join` refuses guests (`game.ts:345`) so they cannot stake, and their ledger calls fail as `BAD_ACCOUNT` — so today this buys chat/spectator impersonation only (see L1). But the shape is a money primitive waiting for one refactor to make `join` guest-capable, which is exactly why MAINNET.md lists removal as a hard requirement. Confirmed still present.

**Fix:** delete the branch pre-launch, or gate it behind an env flag that is fatal in production.

### H4. X-Forwarded-For trust is unconditional — per-IP limits bypassable on direct exposure
`apps/server/src/index.ts:162-164`

```ts
const fwd = String(req.headers["x-forwarded-for"] ?? "");
const ip = (fwd.split(",").pop() ?? "").trim() || req.socket.remoteAddress || "?";
```

Taking the **last** XFF entry is correct behind exactly one trusted proxy (nginx appends the real IP last), and DEPLOYMENT.md documents that topology. But nothing enforces it: anyone who can reach :8787 directly fully controls this value, rotating it per connection to defeat `MAX_PER_IP=6` and the cross-socket resume rate limit (`mayResume`, index.ts:148-157) — the two controls that blunt socket-exhaustion DoS and resume-token brute force. Untested (see M7).

**Fix:** only honor XFF when `req.socket.remoteAddress` is a configured trusted proxy; otherwise use `remoteAddress`. Add `IPAddressAllow=`/`IPAddressDeny=any` to the unit so only the proxy can reach the port (also closes H4's sibling: the documented no-egress policy is currently unenforced — see M6).

---

## MEDIUM

### M1. Fairness verdict passes vacuously for rounds the client didn't observe
`apps/web/src/game/client.ts:159`, `client.ts:150-151`, `apps/web/src/game/net.ts:364`

Three holes in `verifyEntry`:

- `const commitPinned = h.observedCommit === undefined || h.observedCommit === h.commit;` — a round whose lobby was never witnessed (history older than the 200-commit window, fresh browser, reconnect mid-round) **passes commit pinning by default**. Server-supplied commit/seed/record that are mutually consistent render "✓ fair" without any pre-registration ever having been observed.
- `else if (interrupted && !rec.seedHex) { seedsAgree = true; }` — a fabricated "interrupted" record gets `seedsAgree` free, and since `verified` only needs `replayOk !== false` (null passes) plus `seedOk === true`, the badge is forgeable for such rows.
- On reconnect, the first state pins whatever commit the server then sends (`net.ts:364`) — indistinguishable from an honest lobby pin even if the outcome was already decided.

The core pinning itself is genuinely well built (first-write-wins, persisted to localStorage, rules hash folded into the commitment, payout recomputed from replay, fails closed without `crypto.subtle`). The gap is the *unobserved* case: the UI should say "not witnessed — unverifiable" rather than "✓ fair".

**Fix:** require `observedCommit !== undefined` for a green verdict (render a distinct "unwitnessed" state otherwise); drop the interrupted free-pass from `verified`.

### M2. Malformed server frame crashes the whole client
`apps/web/src/game/net.ts:360-375` + consumers

`this.snap = { ...IDLE, ...s, ... }` spreads every server field over safe defaults with no numeric validation. One frame with `wallet: null` (or a string) and the next `.toFixed()` call — `Hud.tsx:292`, `App.tsx:368/371/385/448`, `Chars.tsx:202`, `Stats.tsx:32-52`, `Multiplier.tsx:53-90`, `TickRing.tsx:49` — throws, taking down the React tree until reload. Trusted channel today, but it is a remote UI kill-switch and fragility against a future server version skew.

**Fix:** coerce numerics at the boundary (`Number.isFinite` guards) or wrap state application in one validator.

### M3. 30-day custody session in localStorage + JS-readable parent-domain cookie
`apps/web/src/game/net.ts:93-98,181-187`

`zinc.walletSession` (format `wallet.token`) is written both to localStorage and to a `Domain=.voidsolana.com; Max-Age=30d; SameSite=Lax; Secure` cookie that is necessarily not HttpOnly. Any XSS or hijacked dependency anywhere on any sibling subdomain exfiltrates a month-long arcade session. This is a deliberate SSO design, but it should be an explicitly accepted risk with compensating controls (shorter Max-Age, token binding to device/session, or subdomain-scoped handshake). Transport hygiene around it is otherwise good: bearer only on same-origin fetches, tokens never in URLs or logs.

### M4. Process swallows `uncaughtException` / `unhandledRejection`
`apps/server/src/index.ts:454-455`

Both handlers log and continue. On a money-moving process, continuing after an uncaught exception means running in a possibly half-mutated state. The safer design is already built: crash, let systemd restart, and the tested startup recovery path runs (`refundOpenEntries` → `revealInterrupted` → hold sweep).

**Fix:** `process.exit(1)` in the uncaughtException handler (keep logging for the rejection handler only if you are certain no rejection path mutates round state).

### M5. systemd unit permits unlimited egress; LEDGER_KEY in shared plaintext env file
`thinice.service` (no `IPAddressAllow`/`IPAddressDeny`), lines 35-48

The unit is otherwise hardened well above average (`NoNewPrivileges`, `ProtectSystem=strict`, `SystemCallFilter`, empty capability set, `UMask=0077`, …). But both DEPLOYMENT.md (144-147) and MAINNET.md mandate "no outbound network" as a pre-money requirement, and nothing enforces it — the game needs only loopback to talk to the arcade. Separately, `LEDGER_KEY` ("the whole authority to move anybody's money", per the unit's own comment) sits in a shared plaintext `EnvironmentFile`, readable from `/proc/<pid>/environ`.

**Fix:** `IPAddressAllow=localhost` + `IPAddressDeny=any`; migrate the key to `LoadCredential=`.

### M6. CSP allows websockets to any host; inline styles
`vercel.json:25`

`connect-src` includes bare `wss:` (any secure websocket endpoint) plus both Solana RPC hosts, and `style-src 'unsafe-inline'`. For a money UI, pin `connect-src` to the actual game/arcade origins. Note vercel.json is admittedly vestigial (DEPLOYMENT.md:4-6) — apply the same headers wherever production actually terminates TLS. Also missing: COOP/CORP headers, HSTS `preload`.

### M7. The entire WS/auth/rate-limit layer has zero test coverage
`apps/server/src/index.ts` — 0 of 463 lines touched by any test

Tests construct `GameServer` directly with fake sessions. Unexercised: challenge single-use + TTL, signature verification, resume timing-safe compare and the wallet-with-`:` rejection, logout revocation, **token TTL expiry** (`db.ts:452-455` — implemented, untested, and MAINNET.md itself calls a seat "a money primitive"), all rate-limit buckets, payload caps, chat sanitization, and the XFF assumption (H4). Also untested: the arcade-refuses-exposure (409) path at seal time. The engine/DB/fairness suites, by contrast, are excellent — conservation is asserted explicitly (`round.test.ts:42-61`).

### M8. Historical secret key in git history
`.gitignore:14-18` states a real secret key was swept into the first commit of what is now a public repo. The pattern fix prevents recurrence, but the bytes are still in history. If that key was truly destroyed and funded never, document that; otherwise treat as exposed forever (history rewrite + all of git hosting's caches is the only partial cure).

---

## LOW

| # | Finding | Where |
|---|---------|-------|
| L1 | Guest-id squatting: knowing someone's persistent guest id lets you appear as them in chat (id lives forever in their localStorage) | `index.ts:336-344`, `net.ts:43-61` |
| L2 | `logout()` sends revoke but keeps local session; UI stays seated until server answers `session expired` | `net.ts:591-594` |
| L3 | Chat/history arrays shared by reference across snapshots; verify receipts mutate entries owned by rendered state, and stale receipts override refreshed history via `{...h, ...kept}` | `net.ts:369-370,392-394,640-641` |
| L4 | `arcadeRefused` latches forever, even after successful re-auth | `net.ts:260,421,455` |
| L5 | Unvalidated history numbers render as "NaN×"/"NaN ◎" | `net.ts:508-519`, `History.tsx:87-89` |
| L6 | DEPLOYMENT.md example systemd unit (149-168) has **zero** hardening — doc/unit divergence; anyone following the doc deploys naked | `DEPLOYMENT.md` |
| L7 | `itest-ledger.mjs` — an unauthenticated money-mint script (credit deposits) at repo root with trivially editable URL; loopback-only today | `itest-ledger.mjs:5,38` |
| L8 | `balances` cache map grows per unique wallet for process lifetime (minor memory creep) | `game.ts:98,137-139` |
| L9 | Health endpoint discloses ledger-enabled and vendor-drift status publicly | `index.ts:117-121` |
| L10 | `outcomeDigest` float digest can theoretically flip on a last-ulp engine difference (~1e-7) — known/accepted in README, needs planned migration | `engine/fairness.ts:74-81` |
| L11 | No chat moderation tooling (mute/ban/wordlist) — known/accepted; rate-limited, length-capped, control-char stripped, memory-only | `index.ts:393-407` |
| L12 | `MAX_SOCKETS=300` rejects rather than queues under spike; combined with H4, an attacker holding 300 sockets (or spoofed IPs) denies service to real players | `index.ts:137,166-169` |

## INFO / nits

- **`rounds.seedHex` column actually stores the revealed *secret*, not the seed** (`db.ts:352-355`, `closeRound` via `game.ts:772`). Intentional and tested (`db.test.ts:191` "the reveal is what the commitment covered") — the derived seed lives in the record JSON — but the column name invites a future misuse. Rename or comment at the schema.
- History caption says "sha256(seed) matches the hash published before the round" — for ceremony 2 the commitment covers secret+rulesHash, and the seed is one more hash away. Cosmetic honesty nit. (`History.tsx:122`)
- Dev-only dependency advisories (nanoid high, uuid/jayson moderate via `@solana/web3.js` test tooling): `npm audit fix` when convenient; production runtime deps are clean.
- Render-time ref writes in `Bank.tsx:124-132` work but are impure; theoretical same-tick double-submit of deposit/withdraw is backstopped by server idempotency codes.
- `get()` in `arcade.ts:109-128` doesn't catch `JSON.parse` — throws raw SyntaxError instead of `LedgerError` on garbage responses (callers catch broadly, so impact is misclassified error codes only).
- README mentions `Math.pow` inside `outcomeDigest`; current code uses multiplication — the README note appears stale relative to `fairness.ts:76-79`.

---

## What is done well (verified, not taken on faith)

- **Money conservation is real and tested**: `paid + wipeLeak == pot` asserted across field sizes and exit policies; RTP exactly 1−rake; dead players paid exactly 0; multi-plate and sole-owner endings implemented as genuine engine cash-outs so replays stay valid.
- **Integer lamports at every persistence boundary**; client-side `toLamports` parsing rejects NaN/negatives/exponents/>9dp/overflow; max-button round-trips exactly.
- **Auth mechanics**: single-use 120s challenge nonces, timing-safe token compare, 192-bit tokens, TTL enforced, token rotation on login, loopback-only `LEDGER_KEY` transport guard, vendored-money drift check at boot.
- **Join pipeline race-safety**: per-wallet intent generations, in-flight plate counting, replayed-hold detection, stale-hold release queue with reconcile-on-lobby — and the concurrency cases (parallel joins past cap, rollover-during-hold, lost hold, failed release retry, abort-with-settled-seat) are actually tested.
- **Client fairness core**: first-write-wins commit pinning persisted across reloads; rules-hash bound into commitment; payout recomputed from replay; fails closed without WebCrypto.
- **Zero XSS sinks**: all server strings rendered as escaped JSX; charIds whitelisted; external URLs encoded with `rel="noreferrer"`; no `dangerouslySetInnerHTML`/`innerHTML`/`eval` anywhere.
- **Ops hygiene**: WAL + transactional DB writes, graceful SIGTERM refund/reveal path, bufferedAmount kill switch, per-socket budgets, systemd hardening (mostly), decent security headers on the static host, clean git tree (no DBs/env/artifacts tracked).

---

## Recommended order of work before launch

1. **H1** — verify deposit amount+destination client-side (small diff, real-money path).
2. **H2 + H3** — domain-bound challenge, Origin allowlist, delete guest branch (all pre-mainnet checklist items, all small).
3. **H4 + M5** — trusted-proxy XFF gating + `IPAddressAllow/Deny` in the unit (turns documented policy into enforced policy).
4. **M1** — stop showing "✓ fair" for unwitnessed/interrupted-fabricated rounds (protects the product's central claim).
5. **M4** — exit on uncaughtException; recovery paths are already built and tested.
6. **M7** — encode the four known-untested fixes plus auth/TTL/rate-limit tests before the next big change (README already flags this).
7. **M2/M3/M6/M8** — snapshot validation, cookie/localStorage risk acceptance or tightening, CSP pinning, git-history secret verification.

---

## Remediation record — 2026-08-21

All findings above were fixed in the recommended order. M8 was waived by the
owner: the historical key is confirmed dead and was never funded.

| Finding | Fix |
|---|---|
| **H1** Deposit bytes unverified | `approveTransfer` now takes `{lamports, to}` expectations and refuses to hand anything to the wallet unless the prepared transfer moves exactly the requested lamports to exactly the on-screen custody address (`arcade.ts`, `Bank.tsx`). Deeplink path included — checks run before every signing branch. |
| **H2** Unbound challenge / no Origin allowlist | Server folds its public origin into the signed text via `PUBLIC_ORIGIN` (`wire.ts challengeText`) and sends the client the exact bytes to sign; the client sanity-checks the text against its nonce before prompting the wallet. Upgrades from origins not on `ALLOWED_ORIGINS` are closed `1008`; unset list warns loudly (dev only). Integration-tested. |
| **H3** Guest accounts | Branch deleted end to end (protocol, server, client). Spectators exist as server-named ephemeral seats (`~spec:<random>`): read-only — no chat, no join, no settings, no token issued, no persistence — so there is no bearer credential to learn or squat. |
| **H4** XFF spoofing | `clientIpOf` honors X-Forwarded-For only for connections from `TRUSTED_PROXIES` (default loopback), walking right-to-left past trusted hops. Unit + integration tested, including the direct-exposure bypass case. |
| **M1** Vacuous fairness passes | `verified` now requires a witnessed, still-matching pinned commit, a finished round, replay, seed derivation, rules and payout to all hold. Unwitnessed rounds render "not witnessed"; interrupted rounds can never earn a verdict (sealed ones still show their seed-derivation check); the fabricated-interrupted free pass is gone. Lobby-only commit pinning. Seven adversarial fixtures in `apps/web/test/client.test.ts`. |
| **M2** Malformed frame crashes UI | New `snapshot.ts` coerces every field of a state frame at the boundary; nothing unvalidated reaches React state. |
| **M3** Cookie/session exposure | Shared-cookie Max-Age cut 30d → 7d (sliding on fresh sign-ins) while localStorage keeps the seat off-domain; logout clears local session immediately instead of trusting a server round trip. Cross-subdomain SSO remains an accepted design risk (documented here and at the write site). |
| **M4** Swallowed crashes | Both `uncaughtException` and `unhandledRejection` now exit(1); systemd restart + the tested startup recovery path take over. |
| **M5** Unit egress / key in env | `IPAddressAllow=localhost` + `IPAddressDeny=any` added; `LEDGER_KEY` migrates to `LoadCredential` via new `LEDGER_KEY_FILE` support in `arcade.ts`. |
| **M6** Loose CSP | `connect-src` pinned to the site family's wss hosts + Solana RPC; `style-src 'unsafe-inline'` dropped; COOP/CORP added; HSTS preload. Production should narrow the wildcards to exact origins. |
| **M7** Untested wire layer | `wire.test.ts` (unit) + `auth.test.ts` (integration — boots the real server process, real sockets): origin refusal, challenge binding, nonce single-use and cross-socket reuse, signature rejection, spectator restrictions incl. legacy guest door closed, resume good/bad/colon/expired-TTL, message budget, payload cap, cross-socket resume cap with spoofed-XFF inertness. Plus 7 fairness-verdict tests. Suite: 169 passing. |
| **L2** logout round-trip gap | Fixed with M3. |
| **L5** NaN rendering | Covered by M2 boundary coercion for state frames; history numbers still coerce via `Number()` at `toHistory` and display "NaN" only if the server sends non-numerics there — left as-is (display-only, trusted channel). |
| **L6** Doc unit naked | DEPLOYMENT.md example now carries the hardening essentials and points at `thinice.service` for the full form; nginx comment updated to match the new XFF rule. |

Not done, deliberately:

- **M3's deeper fix** (HttpOnly issuance, token binding) lives at the arcade edge by architecture; this repo tightened what it owns.
- **L10/L11** remain accepted per README (digest float formatting needs a planned migration; chat moderation is arcade/product work).
- The four fairness-caption/UI nits marked INFO were folded into M1's rewrite where they overlapped; the rest stay cosmetic.

