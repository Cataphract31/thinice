/*
 * Where the game servers live, from the browser's point of view.
 *
 * The arcade's hosting split is one client, one server, two hosts: Vercel
 * serves everything static (portal, clients, sprites, fonts) and one Node
 * process on the GCP box answers every game's /api/*. Static assets therefore
 * stay relative -- they come from whoever served the page -- while API calls
 * need to reach the box.
 *
 * Because the arcade is one process, this is ONE setting for every game rather
 * than one per game, which is the practical payoff of the merge.
 *
 * Resolution order, most specific first:
 *   1. ?server=https://host   per-load override, ON A LOCAL PAGE ONLY, for
 *                             testing a deploy against a different box without
 *                             redeploying anything. Must be a bare origin --
 *                             see cleanOrigin() below. A deployed page does not
 *                             read it at all; see gameServer().
 *   2. localStorage           sticky version of the same, survives a reload,
 *                             also localhost-only in both directions
 *   3. GAME_SERVER below      what a normal deploy uses
 *   4. same origin            local development, where one process serves both
 *
 * GAME_SERVER below is the box's public TLS origin, and the deployed client
 * calls it DIRECTLY -- the Vercel proxy in api/[...path].js is a fallback, not
 * the path. (It was api/index.js once; that file's own header explains why the
 * catch-all name is not a style choice, and a rewrite never matched.)
 *
 * Direct costs one ALLOWED_ORIGINS entry on the box and buys something that
 * matters: Flower Poker's table is a long-lived Server-Sent-Events stream, and
 * serverless functions cap execution time, so a proxied stream dies mid-round
 * on exactly the player who stayed seated longest. The box has TLS via Caddy,
 * so there is no mixed-content problem to hide from.
 *
 * LOCAL DEVELOPMENT IS EXEMPT by hostname, not by editing this file: served
 * from localhost, the client stays same-origin, so `npm start` keeps working
 * against its own process rather than quietly playing against production.
 */

const GAME_SERVER = 'https://gielinor.34-70-75-204.sslip.io';

const KEY = 'gielinor.server';

const isLocal = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/**
 * Reduce an override to a bare origin, or reject it.
 *
 * Whatever comes back from here is concatenated with a path and, on the two
 * game pages, printed into the "no game server at ..." notice. So it must be an
 * origin and nothing else: no path, no query, no fragment, no credentials, no
 * javascript: or data:, and nothing that can be read as markup. `new URL().origin`
 * is the whole check -- it either parses as an absolute URL or it does not, and
 * the pieces that are not the origin are dropped rather than sanitised.
 *
 * A plain-HTTP box is refused from an HTTPS page. The browser would block the
 * request anyway; refusing here means the reason shows up as "ignored override"
 * rather than as a game that mysteriously will not load.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function cleanOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;
  try {
    if (url.protocol === 'http:' && location.protocol === 'https:' && !isLocal(url.hostname)) return null;
  } catch { /* no location; nothing to downgrade from */ }
  return url.origin;
}

/**
 * WHY ?server= IS A LOCALHOST TOOL AND NOTHING ELSE
 *
 * This override decides where every stake, every join, every tele-out and --
 * the one that settles the argument -- every custody call is sent. It is a
 * development convenience with the blast radius of a payment redirect, so the
 * rule is the narrowest one that keeps `npm start` working: it is read only
 * on a page served from localhost, which is the only place the workflow it
 * exists for happens.
 *
 * IT GOT THERE IN TWO STEPS, AND THE FIRST ONE WAS NOT ENOUGH.
 *
 * Step one: it used to be WRITTEN to localStorage from the query string on
 * any origin, which made one clicked link a permanent redirection of somebody
 * else's money client -- it survived the tab, the parameter and the session.
 * That was fixed by refusing to persist it off localhost, and by refusing to
 * READ a stored key off localhost too, since localStorage is per-origin and a
 * key sitting on the deployed origin cannot have come from the localhost
 * workflow. It was left by the build that persisted anything, and it went on
 * redirecting that browser's stakes with the parameter long gone from the URL.
 * A key found off localhost is therefore deleted rather than obeyed, and that
 * half of the fix stands exactly as it was.
 *
 * Step two -- THIS ONE -- is the per-load read, which survived step one on the
 * reasoning that a link handed to a stranger "costs them one page view against
 * a server the footer names in plain text". THAT REASONING WAS WRONG, and the
 * thing it missed is the bank.
 *
 * ONE PAGE VIEW IS ENOUGH TO TAKE SOMEBODY'S MONEY. arcade/web/bank.js asks
 * `arcadeUrl('/api/custody/deposit')` for the arcade's deposit address and
 * prints the answer under the words "The arcade's deposit address", beside a
 * COPY button, on a page served over the genuine domain with a valid
 * certificate. Point the override at an attacker's box and that box answers
 * with the attacker's address. There is nothing for a player to notice: the
 * URL bar says voidsolana.com, the padlock is real, the panel is the one they
 * have used before, and the SOL they send by hand is gone with no ledger entry
 * anywhere. The session bearer goes to the same host with every call, as a
 * bonus. A single click on a link in a Discord channel is the whole exploit.
 *
 * So the read is gated the same way the write already was. There is no
 * warning-banner version of this worth building: a page that shows an
 * attacker-supplied address AND a warning is still a page showing an
 * attacker-supplied address, and the workflow the parameter exists for is a
 * developer typing it into their own localhost.
 *
 * TO POINT A DEPLOYED CLIENT SOMEWHERE ELSE, change GAME_SERVER above and
 * deploy it. That is an edit with a reviewer and a git history, which is the
 * correct amount of ceremony for redirecting where an arcade's money goes.
 * (DEPLOY.md still describes the old query-string trick against a Vercel URL;
 * it no longer works, by design.)
 */
export function gameServer() {
  try {
    /*
     * EVERYTHING TO DO WITH THE OVERRIDE LIVES INSIDE THIS BRANCH. Read and
     * write are one rule now rather than two that have to be kept in step --
     * which is how they drifted apart the first time.
     */
    if (isLocal(location.hostname)) {
      const fromQuery = new URLSearchParams(location.search).get('server');
      if (fromQuery !== null) {
        // An empty ?server= clears a stored override and goes back to the default.
        if (!fromQuery) {
          localStorage.removeItem(KEY);
        } else {
          const clean = cleanOrigin(fromQuery);
          if (clean) {
            localStorage.setItem(KEY, clean);
            return clean;
          }
          // Malformed or unsafe: fall through to whatever was already in force.
        }
      }
      const stored = localStorage.getItem(KEY);
      if (stored) {
        const clean = cleanOrigin(stored);
        if (clean) return clean;
        // Written by an older build, or tampered with.
        localStorage.removeItem(KEY);
      }
      // localhost talks to whoever served the page.
      return '';
    }
    /*
     * A DEPLOYED PAGE. The parameter is not read at all, and a stored key
     * cannot have been put here by the workflow above, so it is deleted on
     * sight -- see the second paragraph of the comment.
     */
    if (localStorage.getItem(KEY) !== null) localStorage.removeItem(KEY);
  } catch {
    // Private mode with storage disabled, or no location. Fall through.
  }
  return GAME_SERVER.replace(/\/+$/, '');
}

/**
 * Absolute URL for one game's API path.
 *
 * The mount prefix is included here rather than in each game, so a game keeps
 * asking for "/api/join" and never learns where it lives.
 *
 * @param {string} gameId
 * @param {string} path e.g. '/api/join'
 */
export const gameApi = (gameId, path) => `${gameServer()}/${gameId}${path}`;

/** Static asset paths must NOT go through this -- they are relative by rule. */
export const arcadeUrl = (path) => gameServer() + path;
