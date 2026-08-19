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

There is no offline fallback to fail into: the demo client is deleted, and a
production build bakes the beta server address in `apps/web/vite.config.ts`
unless `VITE_SERVER_URL` overrides it. A build that somehow ends up with no
URL at all refuses to boot with an explicit error instead of playing pretend.

Beware `apps/web/.env.local`. It is gitignored (so it will not reach you from
this repo), but if one exists on the build machine it silently overrides the
environment and you get a bundle pointing at someone's laptop. It fooled the
author of this document during verification, which is why the grep above is
here.

`VITE_ARCADE_URL` is the same kind of variable and points at a **different
box**: the arcade, whose custody edge the bank panel calls for balances,
deposits and withdrawals. It defaults to the deployed arcade in
`apps/web/vite.config.ts`, is bypassed on localhost (a local run must not sign
in against production) and can be overridden for one page load with
`?arcade=https://host`. Wherever this client is served from, that origin has to
appear in the box's `ALLOWED_ORIGINS` or the browser blocks the call before it
is sent, and the failure reads as "could not reach the arcade".

If you want runtime configuration instead, the change is small and lives in
`apps/web/src/game/session.ts` — read the URL from a `window.__CONFIG__` written
by a small non-cached `config.js`, or from a `<meta>` tag, instead of
`import.meta.env`. Worth doing if you deploy the same artifact to several
environments.

### 2. A normal reverse-proxy config silently breaks websockets

The entire game protocol is one websocket. A default `proxy_pass` block does not
forward the `Upgrade` and `Connection` headers, so the handshake fails and the
client sits on "Reconnecting…" forever while the health endpoint reports fine.
See the nginx block below — the five `proxy_set_header` lines are not optional.

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
The server is crash-safe by design: any round interrupted by a restart has its
open entries rolled back and its stakes released from arcade escrow at startup,
and that path was exercised during the beta by killing the server mid-round. It
should still not be dying regularly.

Startup also *reveals* an interrupted round: it publishes the secret behind the
commitment that round already showed players, marks it as one that never
finished, and puts it in history where it can be checked. A round that took
real SOL and can never be asked about is worse than a round that ended badly,
so recovery closes the ceremony as well as the books. A clean `SIGTERM` does
the same without waiting for the next boot. Note that a settled seat is left
alone by all of this — a player who cashed out before the crash was genuinely
paid, and this server has no power to take that back.

**No outbound network access at all.** This server talks to its database and to
the browsers connected to it, and to nothing else. It holds no keypair and
opens no RPC connection: money enters and leaves the arcade at one edge that is
not this process. A firewall that lets nothing out is a correct firewall here.

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
ExecStart=/usr/bin/npm run server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

That is the whole environment. There is no starting balance to zero out, no
bot count to hold at zero and no banking switch to leave off, because none of
those settings exist any more — the safe value of a setting you deleted cannot
be typed wrong.

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
        # The server keys its per-IP cap on the LAST X-Forwarded-For entry.
        # Without this line every player keys to 127.0.0.1 and the seventh
        # concurrent socket site-wide is rejected as "server full".
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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

## There is no play-money mode, and no banking mode either

Both are gone, and they left together for the same reason.

This server used to have two personalities selected by `BANKING`: off meant
free balances and no chain, on meant a self-generated hot wallet paying real
withdrawals. One environment variable stood between them — which is to say one
forgotten environment variable stood between free money and withdrawable
money. The migration trap documented here used to read: *flip `BANKING=on`
against the same database and every point ever granted becomes withdrawable
SOL, and the house pays out money nobody put in.*

That trap cannot be sprung now, because neither side of it exists. New players
start at zero, there is no faucet and no starting credit, and this process
cannot sign a transfer under any configuration. Money is a number in the
arcade's shared ledger, and it gets there by a deposit at the arcade's custody
edge or it does not get there.

Starting real money on a **fresh database** is still the right move — beta
rounds and beta history are noise in a ledger you intend to reconcile against
a chain — but it is now hygiene rather than the difference between solvent and
not.

---

## Before real money touches it

The full checklist is in `MAINNET.md`. The ones specifically about deployment:

- [ ] **TLS terminated**, client built against `wss://`.
- [ ] **The database is on backed-up persistent storage.**
- [ ] **Outbound network denied.** Nothing here needs it, and a server that
      cannot reach the internet cannot be talked into paying anybody.

---

## Verifying a deployment

```bash
curl https://your-host/health          # {"ok":true}
```

Past the health check, verify by playing: point a client at the deployed
address, seat two wallets, run a round to completion, and confirm the fairness
panel marks it verified. That exercises the same path the scripted probe used
to — money moving exactly once, the commitment covering the seed and the rules,
a client unable to set fields the server owns.

The scripted end-to-end probe was retired in August 2026 with the rest of the
harnesses. If you rebuild one, one constraint still applies: its chat traffic
lands in the room's 50-line backlog
where every later visitor reads it, so **restart the service after probing
production** (chat is memory-only, so a restart clears it), or probe before you
announce.
