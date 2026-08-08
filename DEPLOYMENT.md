# Deploying THIN ICE on your own infrastructure

Written for someone putting this on existing infrastructure rather than a
managed platform. There is nothing platform-specific in the code; the `vercel.json`
at the root is only there because the current preview deploy happens to run
there, and any host can ignore it.

**You are deploying two things:**

| | what it is | needs |
|---|---|---|
| **Web client** | a static single-page app — plain HTML/CSS/JS after build | any static host or path on an existing site |
| **Game server** | one long-lived Node process | a box, a persistent disk, a websocket route |

The client is disposable and can be rebuilt anytime. **The server holds the
money.** Everything that decides an outcome or moves a balance is in the server;
the browser only renders what it is told and sends intents.

---

## Two things that will cost you a day if nobody tells you

### 1. The server URL is baked in at BUILD time, not read at runtime

`VITE_SERVER_URL` is a Vite variable, which means it is **statically substituted
into the bundle during the build**. There is no runtime config file to edit and
no environment variable the browser reads. If you change where the server lives,
you must rebuild the client.

Worse, it fails quietly in a specific way: **if `VITE_SERVER_URL` is unset at
build time, the whole networking layer is tree-shaken out** and you get a fully
playable single-player demo with simulated opponents and a fake `localStorage`
balance. It looks like a working game. It is not connected to anything.

Verify which build you produced before shipping it — this is one grep:

```bash
grep -c signAndSendTransaction apps/web/dist/assets/*.js
# 0 = offline demo build   |   1 = real networked build
```

Beware `apps/web/.env.local`. It is gitignored (so it will not reach you from
this repo), but if one exists on the build machine it silently overrides the
environment and you get a bundle pointing at someone's laptop. It fooled the
author of this document during verification, which is why the grep above is
here.

If you want runtime configuration instead, the change is small and lives in
`apps/web/src/game/session.ts` — read the URL from a `window.__CONFIG__` written
by a small non-cached `config.js`, or from a `<meta>` tag, instead of
`import.meta.env`. Worth doing if you deploy the same artifact to several
environments.

### 2. A normal reverse-proxy config silently breaks websockets

The entire game protocol is one websocket. A default `proxy_pass` block does not
forward the `Upgrade` and `Connection` headers, so the handshake fails and the
client sits on "Reconnecting…" forever while the health endpoint reports fine.
See the nginx block below — the four `proxy_set_header` lines are not optional.

Also set a long `proxy_read_timeout`. The server sends a ping every 20s so an
idle connection is not really idle, but a 60s proxy timeout will still cut
players off mid-round.

---

## The web client

```bash
npm install
VITE_SERVER_URL=wss://your-host/ws npm run build
# output: apps/web/dist  — static files, serve them anywhere
```

Two requirements from the host:

- **SPA fallback.** Serve `index.html` for any path that is not a real file.
  (`vercel.json` expresses this as a rewrite; nginx does it with `try_files`.)
- **HTTPS.** Not optional — see the TLS note below.

It is a normal static bundle: no server-side rendering, no Node at runtime, no
build step on the host. It will happily live in a subdirectory of an existing
site, in an S3 bucket, behind a CDN, or inside a container with nginx.

If you serve it from a **subpath** (e.g. `example.com/play/`), set Vite's base:
`npm run build -- --base=/play/`.

### TLS is a functional requirement, not just good practice

The fairness panel replays finished rounds in the browser and hashes them with
`crypto.subtle`, which **does not exist on an insecure origin**. Over plain HTTP
the code detects this and honestly labels rounds "unverifiable" rather than
faking a verdict — but the headline feature of the product is then dead. Serve
over HTTPS and connect the websocket with `wss://`.

### `upload/zinc` — ignore it

That directory is a generated standalone copy of the client that builds without
the monorepo, used for a free preview deploy. If you are building from this repo
you do not need it and should not edit it. It is committed only so the preview
stays in sync.

---

## The game server

One Node 22+ process (it uses the built-in `node:sqlite`). Single writer, no
external database, no Redis, no queue.

```bash
npm install
PORT=8787 DB_PATH=/var/lib/thinice/zinc.db npm run server
```

Every variable is documented in `.env.example`. Endpoints:

- `GET /health` → `{"ok":true}` — for your load balancer and uptime monitor
- `WS /` — the game protocol

### What it needs from the host

**A persistent disk.** `DB_PATH` is the entire ledger: balances, rounds,
entries, transfers. If it lives on ephemeral container storage, restarting the
container destroys everyone's money. Mount a volume and back it up — SQLite
backs up by copying the file (take `-wal` and `-shm` alongside it, or use
`sqlite3 .backup`).

**One instance.** SQLite is single-writer and the round state is in memory, so
this does not scale horizontally by adding processes. Two instances against one
database file will corrupt it, and against separate files would be two unrelated
casinos. Scaling means sharding by table/room or moving the store — a real piece
of work, not a config change.

**A process supervisor.** systemd, pm2, Docker restart policy, whatever you use.
The server is crash-safe by design: any round interrupted by a restart is
refunded in full at startup, and that path is covered by `npm run test:crash`.
It should still not be dying regularly.

**Outbound HTTPS to a Solana RPC**, if you keep the built-in banking.

### systemd example

```ini
[Unit]
Description=THIN ICE game server
After=network.target

[Service]
Type=simple
User=thinice
WorkingDirectory=/opt/thinice
Environment=PORT=8787
Environment=DB_PATH=/var/lib/thinice/zinc.db
Environment=STARTING_BALANCE=0
ExecStart=/usr/bin/npm run server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Note `STARTING_BALANCE=0`. The default of 5 grants every new wallet 5 SOL of
devnet play money on first sight, which must not survive contact with real money.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name your-host;

    # ... your ssl_certificate directives ...

    # The static client.
    root /var/www/thinice;
    location / {
        try_files $uri $uri/ /index.html;   # SPA fallback
    }

    # The game protocol. The Upgrade/Connection headers are what make
    # websockets work at all — without them the handshake fails silently
    # and every player sits on "Reconnecting…".
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;
    }

    location /health {
        proxy_pass http://127.0.0.1:8787/health;
    }
}
```

Built with `VITE_SERVER_URL=wss://your-host/ws` to match.

Caddy equivalent is two lines and handles the upgrade automatically:

```
your-host {
    handle /ws* { reverse_proxy 127.0.0.1:8787 }
    handle     { root * /var/www/thinice; try_files {path} /index.html; file_server }
}
```

---

## Launching with play money first (no chain at all)

The intended opening move: real multiplayer, real shared database, fake
balances — and the chain later. This is one environment variable:

```bash
BANKING=off PORT=8787 DB_PATH=/var/lib/thinice/zinc.db npm run server
```

With banking off the server never creates a house keypair, never touches an
RPC, and never offers clients the bank panel (the client renders banking only
when the server names a house account, so nothing needs changing in the web
build). Every new wallet or guest is granted `STARTING_BALANCE` (default 5) of
play money on first sight, and everything else is exactly the real game: one
shared lobby, the full fairness ceremony, rakeback, jackpot, persistent
balances per guest id or signed wallet.

**The one trap, and it is a serious one: play-money balances must not survive
into the real-money era.** The ledger stores balances as plain lamports — it
does not know or care whether they were ever backed by deposits. If you flip
`BANKING=on` against the same database later, every point ever granted or won
during the free period becomes withdrawable SOL, and the house pays out money
nobody ever put in. When real money arrives, start it on a **fresh
`DB_PATH`**. If you want to reward the play-money era, do it as a deliberate,
budgeted airdrop — never by letting the old ledger become real.

---

## Before real money touches it

The full checklist is in `README.md`. The four that are specifically about
deployment:

- [ ] **TLS terminated**, client built against `wss://`.
- [ ] **`STARTING_BALANCE=0`**, or you are giving away free money.
- [ ] **`RPC_URL` is deliberate.** The server refuses to start against a
      non-devnet RPC, because the bundled banking layer is a custodial hot
      wallet — appropriate for devnet play money and not for anything else.
      Replacing it is `apps/server/src/chain.ts` and nothing else.
- [ ] **The database is on backed-up persistent storage.** It is the ledger.

---

## Verifying a deployment

```bash
curl https://your-host/health          # {"ok":true}
npm run test:server wss://your-host/ws # 29 end-to-end checks against it
```

`test:server` seats three real clients, plays a full round, and asserts the
money moved exactly once, the fairness commitment covers the seed and the rules,
a client cannot set fields the server owns, and chat is relayed, truncated and
rate-limited. It is safe to run against a live server — it plays as ordinary
guests — but its chat checks leave test lines in the room's 50-line backlog,
where every later visitor will read them. **Restart the service after probing
production** (chat is memory-only, so a restart clears it), or probe before
you announce.
