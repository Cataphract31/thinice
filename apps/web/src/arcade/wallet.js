/*
 * THE ARCADE'S WALLET. ONE OF THEM, FOR EVERYTHING.
 *
 * Connecting a wallet, proving it is yours, keeping the session, and letting
 * go of it again. Every table needs all four, the portal needs all four, the
 * bank panel needs all four, and the next game somebody adds will need all
 * four before it needs anything else.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * It used to be written out SIX TIMES. Four games carried a 350-line
 * web/wallet.js each, the portal carried its own, and arcade/web/connect.js
 * carried a sixth for the furniture. Measured against each other, the four
 * game copies were 94% identical and the only functional difference between
 * any of them was one string: the localStorage key naming the game.
 *
 * That is not a tidiness complaint. Six copies of a handshake is six places a
 * fix has to land, and the failure mode is silent: whoever fixes one has no
 * way to know about the other five, so the arcade ends up with tables that
 * behave differently from each other for no reason anybody chose. The mobile
 * work is the concrete case: the phone route has now been rebuilt twice, and
 * each time it landed in exactly one provider lookup rather than in five
 * tables that would have drifted apart. See docs/MOBILE_WALLETS.md.
 *
 * ── WHAT A GAME HAS TO DO TO USE IT ──────────────────────────────────────
 *
 * Name itself:
 *
 *     import { Wallet } from '#arcade/web/wallet.js';
 *     const wallet = new Wallet(onChange, { id: 'barrows' });
 *
 * That is the whole integration. The id namespaces one localStorage key and
 * nothing else; every cookie, every route and the balance behind them belong
 * to the ARCADE, because a balance is one balance for the whole arcade and a
 * session earned at one table seats you at every other.
 *
 * The UI stays the game's. This file holds no markup, no colours and no
 * strings a player reads except the ones that have to be exact -- an arcade
 * of tables that all looked the same would be an arcade nobody visits, and
 * Thin Line and the desktop already prove the surface can be anything. What
 * is shared is the BEHAVIOUR, which is the part that must not vary.
 *
 * ── THE TWO THINGS TO UNDERSTAND BEFORE CHANGING ANYTHING ────────────────
 *
 * AN ADDRESS IS A NAME. A SESSION IS A CREDENTIAL. `zinc_wallet` is a claim
 * this browser makes about itself -- anybody can type one -- and it is worth
 * exactly one thing: knowing whether it is worth asking the wallet a silent
 * question. `zinc_session` is the arcade's own proof, minted only against a
 * signature over a nonce the server issued, and it is the only thing that
 * makes a balance safe to key to an address. Nothing in this file ever lets
 * the first become the second. A reader who blurs them writes the
 * impersonation bug.
 *
 * SIGNING PROVES OWNERSHIP AND APPROVES NOTHING. The statement the wallet
 * displays says so in words, and it is issued by the SERVER and signed byte
 * for byte as received. Rebuilding that sentence here would be a second
 * implementation of the one thing that must never disagree -- a signature
 * over slightly different bytes verifies against nothing at all.
 *
 * NO BROWSER GLOBAL IS TOUCHED AT MODULE LOAD, deliberately. Node loads this
 * through four game test suites and through the bank panel's own, and a
 * top-level `window` would make every one of them unloadable. Everything that
 * reads a browser reads it inside a function, and inside a try.
 */

import { arcadeUrl } from './origin.js';
import { isMobile, noWalletAdvice } from './platform.js';

/** How long a claim or a session is carried. A month: a convenience that lapses. */
const MONTH_SECONDS = 60 * 60 * 24 * 30;

/*
 * WHICH WALLET THE SESSION IN THIS BROWSER WAS MINTED FOR.
 *
 * A token is opaque -- it says nothing about whose it is -- and the arcade has
 * exactly one of them at a time, so a browser that connects wallet A and then
 * switches to wallet B in the wallet's own interface holds a credential for A
 * while every screen on the page is captioned B. Everything that follows is
 * wrong in the worst direction: the bank shows A's balance under B's name, and
 * a stake pressed as B is taken from A.
 *
 * WRITTEN BESIDE THE TOKEN RATHER THAN INSIDE IT, because the token is the
 * server's to shape and this is the browser's own bookkeeping. It is NOT a
 * credential and nothing trusts it: it can only ever cause a fresh sign-in to
 * be asked for, never let one be skipped -- see sessionFor().
 */
const SESSION_FOR = 'zinc_session_wallet';

/*
 * THE PHONE'S WALLET, ONCE IT HAS ANSWERED.
 *
 * On a phone there is nothing injected and there never will be: the wallet is
 * another app, reached by opening it. What comes back from that trip is a
 * SESSION -- an address and a token for an encrypted channel -- and this is
 * where the object built around it is kept so that the synchronous lookup
 * below can find it like any other provider.
 *
 * Held at module scope rather than per-Wallet because there is one phone, one
 * wallet app and one session behind it; two objects over the same session
 * would be two answers to the question of who is playing.
 */
let phone = null;

/**
 * The providers this page can reach right now, in the order to prefer them.
 *
 * THE ONLY PROVIDER LOOKUP IN THE ARCADE, which is the point.
 *
 * The `is*` flags are checked rather than the object's mere presence: a
 * different wallet occupying `window.phantom.solana` is a thing that happens,
 * and calling it Phantom in the UI would be the arcade lying about which
 * software the player is about to approve a transfer in. The bare
 * `window.solana` fallback is last among the injected ones and deliberately
 * unnamed, because at that point we genuinely do not know.
 *
 * THE PHONE'S SESSION COMES LAST, AND THAT ORDER IS DELIBERATE. Inside a
 * wallet's own in-app browser BOTH can exist -- there is an injected provider
 * and the phone may still hold a deeplink session from an earlier visit -- and
 * the injected one is the wallet the player is already standing in. Preferring
 * the other would bounce somebody out of the app they had just opened.
 *
 * @returns {{provider: any, name: string} | null}
 */
export function findProvider() {
  const w = globalThis.window;
  if (!w) return null;
  if (w.phantom?.solana?.isPhantom) return { provider: w.phantom.solana, name: 'Phantom' };
  if (w.solflare?.isSolflare) return { provider: w.solflare, name: 'Solflare' };
  if (w.backpack?.isBackpack) return { provider: w.backpack, name: 'Backpack' };
  if (w.solana) return { provider: w.solana, name: 'Wallet' };
  return phone;
}

/**
 * THE SAME LOOKUP, BUT ALLOWED TO GO AND BUILD ONE.
 *
 * findProvider() answers from what is already in the page, which is what a
 * constructor and a render pass need. This is what a PRESS needs: on a phone
 * that has connected before, it reconstitutes the wallet from the session kept
 * across the trip to the wallet app, so everything downstream sees an ordinary
 * provider.
 *
 * IT DOES NOT START A CONNECTION. A phone with no session yet gets null, and
 * the caller offers the wallets -- because starting one means LEAVING THIS
 * PAGE, and that is not something a lookup should do behind its caller's back.
 *
 * NOTHING IS FETCHED ON A DESKTOP. The dynamic import sits inside the mobile
 * branch, so a desktop press costs nothing at all.
 *
 * @returns {Promise<{provider: any, name: string} | null>}
 */
export async function ensureProvider() {
  const found = findProvider();
  if (found) return found;
  if (!isMobile()) return null;
  try {
    const link = await import('./deeplink.js');
    const held = link.deeplinkSession();
    if (!held) return null;
    phone = { provider: link.deeplinkProvider(), name: held.name };
  } catch {
    // The module would not load. The wallets are still to be offered, and a
    // failure to reach a fallback must not become the error the player reads.
    phone = null;
  }
  return phone;
}

/**
 * HOW THIS BROWSER CAN CONNECT AT ALL, decided in one place.
 *
 * THE ORDER MATTERS AND IT DOES NOT START WITH THE PLATFORM. Sniffing the
 * user agent first is the common mistake, and it breaks the case that already
 * works: inside a wallet's own in-app browser the user agent still says
 * iPhone or Android, but a provider IS injected and the ordinary desktop path
 * is exactly right. Asking "is there a provider" first covers every desktop
 * extension AND every wallet's browser with no user-agent string involved.
 *
 *   'injected'  something is here already; use it, and stop
 *   'mobile'    a phone; a wallet is one press and one app switch away
 *   'desktop'   no extension, and a browser that could have one
 *
 * 'mobile' IS A STATEMENT ABOUT THIS INSTANT, not a verdict. It says nothing
 * is injected, which is true on a phone that is one press away from a working
 * wallet. What resolves it is ensureProvider(), which is asynchronous because
 * the answer lives in a module worth loading lazily -- and this function is
 * synchronous by design, since a render pass asking "what kind of browser is
 * this" must not be able to await anything.
 *
 * @returns {'injected'|'mobile'|'desktop'}
 */
export function walletRoute() {
  if (findProvider()) return 'injected';
  return isMobile() ? 'mobile' : 'desktop';
}

/** `7Xb2..9dKp`, which is how an address is written when it is a name. */
export function shortAddress(address) {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 4)}..${a.slice(-4)}` : a;
}

/** One cookie by name, or ''. */
function readCookie(name) {
  try {
    const found = globalThis.document?.cookie?.match(
      new RegExp(`(?:^|;\\s*)${name}=([^;]*)`),
    );
    return found ? decodeURIComponent(found[1]) : '';
  } catch {
    return '';
  }
}

/**
 * Write a cookie for every world on this domain, or clear it.
 *
 * ONE WRITER FOR BOTH COOKIES, because they had drifted into two writers with
 * subtly different rules and that is precisely how a session ends up carried
 * on one page and dropped on the next.
 *
 * The Domain attribute is only ever the registrable domain, and only while
 * standing on it. Off it, a Domain naming another site is not an error -- it
 * is SILENTLY DISCARDED, which is worse than an error, because the cookie
 * then appears to work in development and is quietly missing in production.
 */
function carry(name, value, seconds = MONTH_SECONDS) {
  try {
    const host = globalThis.location.hostname;
    const parts = [`${name}=${value ? encodeURIComponent(value) : ''}`, 'Path=/'];
    if (host === 'voidsolana.com' || host.endsWith('.voidsolana.com')) {
      parts.push('Domain=.voidsolana.com');
    }
    parts.push(`Max-Age=${value ? seconds : 0}`, 'SameSite=Lax');
    if (globalThis.location.protocol === 'https:') parts.push('Secure');
    globalThis.document.cookie = parts.join('; ');
  } catch { /* no cookie jar, or no location; then this browser cannot carry it */ }
}

/**
 * The arcade's proof that you are who you say you are, or null.
 *
 * SHAPE-CHECKED BEFORE IT IS EVER SENT. A truncated or mangled cookie should
 * read as "signed out" rather than as an Authorization header the box has to
 * reject on every single call -- and a session that is malformed is not a
 * session, however much it looks like one.
 */
export function sessionToken() {
  const token = readCookie('zinc_session');
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

/**
 * The session, but only if it belongs to `address`.
 *
 * THE ONE QUESTION A PRESS SHOULD ASK. "Is there a token" is the wrong test at
 * connect time and it is how somebody ends up playing another wallet's money:
 * see SESSION_FOR above. This is the same test plus the only thing that makes
 * it safe -- that the credential and the name on screen are the same person.
 *
 * A SESSION WITH NO OWNER RECORDED IS ACCEPTED, and that is a migration rather
 * than a hole. Browsers signed in before this cookie existed hold a perfectly
 * good token and no note of whose it is; refusing them would sign the whole
 * arcade out on deploy. The box is the authority either way -- it decides whose
 * the token is on every single call -- so the worst this can do is ask for a
 * signature that was not needed, and only until the next sign-in writes it.
 *
 * @param {string|null|undefined} address
 * @returns {string|null}
 */
export function sessionFor(address) {
  const token = sessionToken();
  if (!token) return null;
  const owner = readCookie(SESSION_FOR);
  if (owner && address && owner !== address) return null;
  return token;
}

/**
 * DROP A SESSION THIS BROWSER IS STILL CARRYING AND THE BOX NO LONGER HONOURS.
 *
 * The bug this exists to end, which cost an arcade-wide lockout: `zinc_session`
 * is a month-long cookie and every screen here tests for its PRESENCE, while
 * the box can stop honouring a token at any moment and never gets to say so.
 * Three ordinary things do it -- signing in on a second device (one live
 * session per wallet, so the first is retired), a deploy onto a fresh database,
 * and the month running out at the server before the cookie lapses here.
 *
 * From then on the browser was wedged, and silently. Every panel believed it
 * was signed in, so every panel drew itself as signed in and every read came
 * back 401 into a catch that says nothing -- an empty bank, a game answering
 * "playerId is required", a header showing an address that proves nothing. And
 * the one thing that would have fixed it could not run: connect() signs in only
 * `if (!sessionToken())`, and the dead cookie made that false forever. The only
 * way out was to press disconnect, whose signOut() clears the cookie as a side
 * effect of something the player had no reason to do.
 *
 * NOT signOut(): there is nothing at the box to retire. It has already told us
 * it does not know this token, and a POST to hand it back would be one more
 * request to fail. This is the browser catching up with an answer it was given.
 *
 * NO SIGNATURE IS ASKED FOR HERE, and that is deliberate. This runs from a
 * failed poll, which is not a gesture anybody made; a wallet popup fired from a
 * background timer is the habit every drainer relies on. Clearing the cookie
 * puts the arcade honestly into its signed-out state, where the Connect button
 * says what it does and pressing it now works.
 *
 * @returns {boolean} whether anything was actually let go of
 */
export function forgetSession() {
  const had = Boolean(readCookie('zinc_session') || readCookie(SESSION_FOR));
  if (!had) return false;
  carry('zinc_session', '');
  carry(SESSION_FOR, '');
  return true;
}

/** Headers for an authenticated call, or nothing at all when signed out. */
export function authHeaders() {
  const token = sessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The address this browser SAYS it goes by. A claim, never a credential.
 *
 * Good enough to decide what to draw before the box has answered -- showing
 * somebody their own address a beat early costs nothing if it turns out to be
 * stale. Nothing that moves money reads this: the box takes the wallet from
 * the session, which is the whole argument in arcade/money/routes.js.
 */
export function claimedWallet() {
  return readCookie('zinc_wallet') || null;
}

/**
 * Has this browser opted in to connecting, anywhere on this arcade?
 *
 * TWO SIGNALS, AND EXACTLY TWO. The local preference this page wrote itself,
 * and `zinc_wallet` -- which says the player already pressed connect once
 * somewhere on this domain, on the portal's front page or at another table.
 * Showing them a Connect button they believe they have already pressed reads
 * as the arcade forgetting them between two of its own pages.
 *
 * THE COOKIE'S VALUE IS NEVER READ, and that is load-bearing rather than
 * fastidious. An address in a cookie is a claim anybody can type, so its
 * presence counts only as the opt-in bit; the wallet itself still decides,
 * through onlyIfTrusted, whether this origin gets an address without a popup.
 * A version of this that let the cookie's value become the address would be
 * the first step of exactly the impersonation this file's header warns about.
 */
function optedIn(prefKey) {
  try {
    if (globalThis.localStorage?.getItem(prefKey) === '1') return true;
  } catch { /* storage disabled; the cookie may still say yes */ }
  // Presence, not value -- and an emptied cookie, which is how disconnecting
  // works, is correctly not a presence.
  return Boolean(readCookie('zinc_wallet'));
}

/**
 * Prove ownership of `address` to the arcade and keep the session.
 *
 * Returns false rather than throwing on every failure path -- a declined
 * popup, a wallet that cannot sign, a box that has not been restarted onto a
 * build that has the issuer -- because the caller's fallback is the same in
 * all of them: carry on without a session. There is nothing here worth
 * stopping a player over.
 *
 * @returns {Promise<boolean>} whether a session now exists
 */
export async function signIn(provider, address) {
  if (typeof provider?.signMessage !== 'function') return false;
  try {
    const asked = await fetch(arcadeUrl('/api/auth/challenge'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: address }),
    });
    if (!asked.ok) return false;
    const { nonce, statement } = await asked.json();
    if (!nonce || !statement) return false;

    // Signed exactly as issued. See the header.
    const { signature } = await provider.signMessage(new TextEncoder().encode(statement), 'utf8');
    const proof = await fetch(arcadeUrl('/api/auth/verify'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: address,
        nonce,
        signature: btoa(String.fromCharCode(...signature)),
      }),
    });
    if (!proof.ok) return false;
    const { token } = await proof.json();
    if (typeof token !== 'string' || !token) return false;
    carry('zinc_session', token);
    // Whose it is, so a later account switch cannot spend it. See SESSION_FOR.
    carry(SESSION_FOR, address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retire the session with the BOX, not merely with this browser.
 *
 * A cookie deleted locally leaves a live token on the server that anybody who
 * copied it can still spend with. Signing out retires it there, which is the
 * difference between logging out and hiding the evidence.
 */
/**
 * PUT THE BROWSER'S HALF OF THE SESSION BACK ON ITS FULL MONTH.
 *
 * The cookie's Max-Age is written once, when the signature mints the token, and
 * was never touched again -- so it expired thirty days after the signature no
 * matter how often somebody played. The box now pushes ITS deadline out every
 * time a session is used (see TOKEN_RENEW_AFTER_MS in arcade/money/auth.js),
 * and without this the two halves disagree: the token stays valid on the server
 * and the browser throws away the only copy of it, which is a re-sign for a
 * session that never actually lapsed.
 *
 * SO THE TWO SLIDE TOGETHER. Called from resume(), which runs once per page
 * load per table -- the right cadence, because it costs nothing and anybody who
 * shows up inside a month keeps their session indefinitely.
 *
 * NOT A CREDENTIAL CHANGE. The same token value is written back with a fresh
 * Max-Age; nothing is minted, nothing is sent, and a token the box has already
 * retired is still dead on its next use -- forgetSession() is what notices
 * that, and this does not get in its way.
 */
export function keepSession() {
  const token = sessionToken();
  if (token) carry('zinc_session', token);
}

export async function signOut() {
  const token = sessionToken();
  if (token) {
    try {
      await fetch(arcadeUrl('/api/auth/signout'), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch { /* unreachable box; the cookie still goes */ }
  }
  carry('zinc_session', '');
  carry(SESSION_FOR, '');
}

/**
 * On a phone with nothing to talk to, offer the wallet apps.
 *
 * WHY THIS SITS INSIDE connect() RATHER THAN IN EVERY CALLER. Four games, the
 * bank panel and the portal all already call connect() and all already handle
 * its refusal. Putting the hand-over here means every one of them gained a
 * working phone route without a line changing in any of them -- and, more to
 * the point, none of them can forget to. A chooser wired into one caller is a
 * dead button in the other five, which is the shape of bug this whole file
 * exists to stop.
 *
 * THE REFUSAL STILL FOLLOWS. Whether they pick a wallet or dismiss the panel,
 * this page has no provider and connect() has not connected anything, so it
 * must still say so -- picking an app means the page is about to be replaced
 * by the wallet's browser, and the caller's job in the meantime is exactly
 * what it was.
 *
 * IMPORTED LAZILY, so a desktop never fetches the panel and the games never
 * learn it exists. A failure to load it costs the offer and nothing else: the
 * caller still gets the message that names the real problem.
 *
 * EXPORTED FOR THE PORTAL, WHICH IS THE ONE CALLER THAT IS NOT A TABLE. Its
 * button drives the header, the reveal and the event log rather than a seat,
 * so it keeps its own connect() -- and it has now twice grown a WRONG copy of
 * this because of it. The first time it named the problem and offered nothing;
 * the second time it opened the panel with no wallets in it, because the
 * panel's signature changed underneath a call this file no longer owned.
 *
 * A private helper with a public duplicate is the shape of bug this whole
 * module exists to end. There is one offer now, and the portal calls it.
 */
export async function offerWalletApps() {
  if (!isMobile()) return;
  try {
    const link = await import('./deeplink.js');
    if (link.deeplinkPossible()) {
      /*
       * ASKED ONCE. Somebody who has picked Phantom before should press
       * connect and see Phantom, not a list with Phantom in it. That single
       * tap is what the whole rebuild was for.
       */
      const picked = link.rememberedWallet();
      if (picked) { await link.beginConnect(picked); return; }

      const { links, commit } = await link.prepareConnect();
      const { chooseWallet } = await import('./wallet-chooser.js');
      await chooseWallet({ links, more: await otherWallets(), onPick: commit });
      return;
    }
    await offerBrowseLinks();
  } catch {
    // The protocol could not be set up at all. There is still one thing left
    // to offer, and it must not be lost to the failure of the better route.
    try { await offerBrowseLinks(); } catch { /* then there is nothing */ }
  }
}

/**
 * THE WALLETS THAT CANNOT ANSWER BACK, for the bottom of the panel.
 *
 * Three wallets on Solana implement the encrypted deeplink protocol. Every
 * other one -- Trust, OKX, Bitget, and the rest -- publishes either nothing or
 * an SDK with a build step and a QR code, so the only thing a web page can do
 * for them is reopen itself inside the wallet's own browser. That is worse in
 * a way the player will notice: the session lives in the wallet's cookie jar
 * and does not follow them back here.
 *
 * It is still offered, because a panel that lists three wallets tells somebody
 * holding a fourth that the arcade does not support it, which is not true.
 *
 * NOTHING HERE IS REMEMBERED. `commit` is deliberately not passed on: it
 * records which wallet the CONNECT route should go straight to next time, and
 * an id that route has never heard of would send the next press nowhere.
 *
 * @returns {Promise<{lede: string, links: Array<object>} | undefined>}
 */
async function otherWallets() {
  try {
    const { browseOnlyApps, browseLink, whereWeAre } = await import('./wallet-apps.js');
    const here = whereWeAre();
    if (!here) return undefined;
    return {
      lede: 'Other wallets open the arcade inside themselves. You stay signed in there, not here.',
      links: browseOnlyApps().map((app) => ({
        id: app.id,
        name: app.name,
        href: browseLink(app, here.url, here.ref),
      })),
    };
  } catch {
    // The panel is still worth showing with the three that work.
    return undefined;
  }
}

/**
 * The older route, kept for the browser that cannot do the newer one.
 *
 * The encrypted deeplink protocol has to keep a key across a trip to another
 * app, so a browser with storage switched off -- private mode on some phones,
 * a locked-down profile -- cannot use it at all. Opening the arcade INSIDE the
 * wallet's own browser needs nothing kept, because a provider is injected
 * there exactly as on a desktop.
 *
 * It is second rather than first because it is worse in two ways that cannot
 * be fixed: the session ends up in the wallet's browser and does not follow
 * the player back, and on Android the link may be answered by phantom.app the
 * WEBSITE rather than by the app. Both are why the protocol above exists. See
 * docs/MOBILE_WALLETS.md.
 */
async function offerBrowseLinks() {
  const { WALLET_APPS, browseLink, whereWeAre } = await import('./wallet-apps.js');
  const here = whereWeAre();
  if (!here) return;
  const { chooseWallet } = await import('./wallet-chooser.js');
  await chooseWallet({
    links: WALLET_APPS.map((app) => ({
      id: app.id,
      name: app.name,
      href: browseLink(app, here.url, here.ref),
    })),
    lede: 'Tap yours. The arcade opens inside it.',
    note: 'You stay signed in there, not here.',
  });
}

/**
 * FINISH A TRIP TO A WALLET APP, if this page load is the end of one.
 *
 * The phone route leaves this site, and the player comes back to a FRESH page
 * with the wallet's answer in the query string. Nothing that started the trip
 * is still running -- the tab that did it no longer exists -- so the work has
 * to be picked up here, on load, by whatever runs first.
 *
 * CHEAP WHEN THERE IS NOTHING TO DO, which is almost every page load in the
 * arcade. The marker is looked for in a string; only a page that actually
 * carries an answer imports the protocol, the cipher or the decoder.
 *
 * AND IT CHAINS. A completed connect goes straight on to proving the address,
 * because arriving back half-connected -- named but not signed in -- would
 * leave somebody looking at a screen that expects something of them without
 * saying what. One press, two approvals, done.
 *
 * @returns {Promise<{kind: string, [k: string]: any} | null>}
 */
/*
 * WHERE A FINISHED PHONE DEPOSIT GETS SHOWN, WHICH IS NOT ALWAYS THIS BANK.
 *
 * The trip to the wallet app destroys the page, so the outcome arrives with
 * nothing on screen to put it on and this module has to open something. It
 * opened ./bank.js, which is right for every table that uses the arcade's
 * bank and WRONG for a world that set `ownBank` -- CURSORS.EXE and Thin Ice
 * would have had a gold OSRS panel appear over their own furniture at the end
 * of a deposit, which is the exact thing that flag exists to prevent.
 *
 * So it is the same argument as `ownBank` itself, one level down: a world that
 * brings its own way to the money brings its own way to REPORT it. Register a
 * sink and this hands the outcome there instead; register nothing and the
 * arcade's bank opens exactly as before, which is what the five resident
 * tables want and what they get without touching a line.
 *
 * @param {((result: object) => void|Promise<void>)|null} show
 */
let arrivalSink = null;
export function onDepositArrival(show) {
  arrivalSink = typeof show === 'function' ? show : null;
}

/*
 * WHY A TRIP TO THE WALLET CAME BACK WITH NOTHING, KEPT FOR WHOEVER ASKS.
 *
 * A phone sign-in fails on the page load that ANSWERS it -- there is no button
 * still waiting, no panel open, and nothing on screen that was expecting a
 * result -- so the reason had nowhere to go and was dropped on the floor. That
 * is how the worst version of this reads to a player: they approve in their
 * wallet, land back on the arcade, and it is exactly as it was. Nothing says
 * no. Pressing connect again does the same nothing, twice as slowly.
 *
 * So it is written down here for the next screen that has room for it -- the
 * bank's connect prompt is the one they actually go to -- and it is READ ONCE.
 * A stale "that did not work" surfacing tomorrow, over a session that has been
 * fine since, would be worse than the silence it replaces.
 *
 * NOT KEPT ACROSS PAGE LOADS on purpose. It belongs to the return trip, and
 * the return trip is this page.
 */
let signInProblem = null;

/** Why the last trip to the wallet failed, if it did. Cleared by reading it. */
export function lastWalletProblem() {
  const said = signInProblem;
  signInProblem = null;
  return said;
}

export async function completeDeeplink() {
  try {
    if (!String(globalThis.location?.search ?? '').includes('zinc_link=')) return null;
    const link = await import('./deeplink.js');
    const step = link.deeplinkReply()?.step ?? null;
    const result = await link.completeReply();
    // A refusal or a failure on the deposit step still belongs in the bank:
    // somebody who declined a transfer should see that where they asked for it.
    if (result && step === 'deposit') result.deposit = true;

    if (result?.kind === 'connected') {
      carry('zinc_wallet', result.address);
      /*
       * AND ON TO PROVING IT, unless there is already a session FOR THIS
       * ADDRESS. Testing for a token alone stranded exactly the players this
       * chain exists for: a phone holding a session that had lapsed at the box,
       * or one minted for the account they just switched away from, came back
       * from the wallet app named and not signed in -- and then sat on a screen
       * that expected something of them without saying what, because the trip
       * that would have fixed it had been skipped as unnecessary.
       *
       * Navigates, so nothing after this line runs on this page.
       */
      if (!sessionFor(result.address)) return await link.continueToSignIn(result);
    }
    /*
     * A SIGN-IN THAT DID NOT FINISH IS WRITTEN DOWN RATHER THAN SWALLOWED.
     *
     * `cancelled` is included: somebody who declined in their wallet and came
     * back to an unchanged page has no way to know the arcade heard them, and
     * "nothing happened" is the one thing this route must never leave a player
     * guessing about. The deposit steps have their own report -- see the sink
     * above and reportArrival -- so only the sign-in leg lands here.
     */
    if (step === 'signin' && (result?.kind === 'error' || result?.kind === 'cancelled')) {
      signInProblem = result.message ?? 'That sign-in did not finish.';
    }
    if (result?.kind === 'signed-in') {
      carry('zinc_session', result.token);
      carry(SESSION_FOR, result.address);
      carry('zinc_wallet', result.address);
    }
    /*
     * A DEPOSIT HAS TO BE SHOWN, and there is nothing on screen to show it on.
     * The panel that started it was destroyed by the trip to the wallet, so
     * this reopens it and hands it the outcome to paint as it draws.
     *
     * The default import is dynamic and one-way at runtime: the bank imports
     * this module, and this reaches back only on the one page load in a
     * thousand that is the end of a phone deposit. A static import here would
     * be a cycle, and would also put the whole bank panel on every page that
     * resumes a wallet. A world with its own panel registers a sink instead --
     * see onDepositArrival above -- and never loads this bank at all.
     */
    if (result?.kind === 'deposited' || result?.deposit) {
      if (arrivalSink) {
        await arrivalSink(result);
      } else {
        /*
         * THE SPECIFIER IS A VARIABLE SO THAT A BUNDLER CANNOT FOLLOW IT, and
         * that is load-bearing rather than a style. This file is copied into
         * the worlds that bank in their own furniture -- see the sink above --
         * and those worlds do not ship the arcade's bank at all. A literal
         * './bank.js' is a dependency their bundler resolves at BUILD time and
         * fails on, which would make this module unusable by exactly the
         * worlds the sink exists for. Written this way it is what it actually
         * is: an optional module, fetched only on the arcade's own pages,
         * where it is right there beside this one.
         */
        const HERE = './bank.js';
        const bank = await import(/* @vite-ignore */ HERE);
        bank.reportArrival(result);
        await bank.openBank('deposit');
      }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * MAKE THE SESSION THIS WALLET'S, ON A PRESS.
 *
 * This used to be `if (!sessionToken()) await signIn(...)`, written out twice,
 * and it was wrong in both directions at once.
 *
 * IT SKIPPED A SIGN-IN THAT WAS NEEDED. A token held for wallet A is not a
 * session for wallet B, so connecting B kept A's credential and the arcade
 * spent A's balance under B's name. sessionFor() is the same test with the
 * only condition that makes it true.
 *
 * AND IT SKIPPED THE SIGN-IN THAT WAS THE WAY OUT. A token the box had stopped
 * honouring still passed `sessionToken()`, so the press that was supposed to
 * repair the session was the one press that could not -- see forgetSession().
 * A caller that has already forgotten a refused token arrives here with no
 * cookie and gets the popup, which is the whole repair.
 *
 * THE OTHER WALLET'S SESSION IS RETIRED AT THE BOX RATHER THAN ORPHANED. It
 * belongs to the person standing here, they are done with it, and a live token
 * nobody holds is the difference this file already draws between logging out
 * and hiding the evidence.
 *
 * @returns {Promise<boolean>} whether a session for `address` now exists
 */
async function seat(provider, address) {
  if (sessionFor(address)) return true;
  if (sessionToken()) await signOut();
  return signIn(provider, address);
}

/**
 * Connect, then sign in -- on an explicit press, never on load.
 *
 * The one-shot form, for arcade furniture that has no state to keep: the bank
 * panel and the portal header. A table wants the Wallet class below instead,
 * because a table has to survive the player disconnecting from inside the
 * wallet's own interface.
 *
 * A SIGNATURE POPUP BELONGS TO A GESTURE THE PLAYER JUST MADE. Firing one at
 * somebody who only came back to watch is how a site teaches people to
 * dismiss wallet dialogs without reading them, which is the habit every
 * drainer relies on.
 *
 * @returns {Promise<{address: string, name: string, session: boolean}>}
 * @throws  with something sayable when there is no wallet, or they declined
 */
export async function connect() {
  const found = await ensureProvider();
  if (!found) {
    await offerWalletApps();
    throw Object.assign(new Error(noWalletAdvice()), { code: 'NO_WALLET' });
  }
  const out = await found.provider.connect();
  const key = out?.publicKey ?? found.provider.publicKey;
  if (!key) throw new Error('The wallet connected without giving an address.');
  const address = key.toString();
  carry('zinc_wallet', address);
  const session = await seat(found.provider, address);
  return { address, name: found.name, session };
}

/**
 * A table's wallet: the same handshake, plus the state a table has to keep.
 *
 * The difference from connect() above is that this one LISTENS. A player can
 * disconnect from inside the wallet's own interface, or switch to another
 * account, at any moment and without touching the page -- and a table that
 * went on showing the old address would be lying about who is playing, on the
 * screen where somebody is about to stake money.
 */
export class Wallet {
  /**
   * @param {(state: {address: string|null, name: string|null}) => void} [onChange]
   * @param {{id?: string}} [options] `id` names the game, for its own opt-in key
   */
  constructor(onChange = () => {}, { id = 'arcade' } = {}) {
    this.onChange = onChange;
    this.address = null;
    this.walletName = null;
    /*
     * THE ONLY THING A GAME PERSONALISES, and it is per-game on purpose: the
     * preference records that somebody pressed connect ON THIS TABLE, so a
     * table they have never opened does not resume as though they had. The
     * domain-wide cookie is what carries the opt-in ACROSS tables, and it is
     * read separately -- see optedIn().
     */
    this.prefKey = `gielinor.${id}.wallet`;

    this.provider = null;
    this.providerName = null;
    this.#bind(findProvider());
  }

  /**
   * Take a provider and start listening to it.
   *
   * SEPARATE FROM THE CONSTRUCTOR because on Android the provider does not
   * exist yet when a table is built: Mobile Wallet Adapter arrives later, on
   * the press, from a module that had to be fetched first. A table constructed
   * with nothing and given a provider at connect() time is the same table --
   * but only if the listeners get attached at that moment too, and a version
   * of this that bound only in the constructor would leave every Android
   * player's table deaf to them switching accounts.
   *
   * IDEMPOTENT ON PURPOSE. Attaching twice would double every event, and
   * `accountChanged` firing twice means #set running twice, which means the
   * game's onChange being told twice about one change.
   */
  #bind(found) {
    if (!found?.provider || this.provider === found.provider) return;
    this.provider = found.provider;
    this.providerName = found.name;
    this.provider.on?.('disconnect', () => this.#set(null));
    this.provider.on?.('accountChanged', (key) => this.#set(key ? key.toString() : null));
  }

  /** Whether there is anything here to press. */
  get available() {
    return Boolean(this.provider);
  }

  /** The session, for a caller that wants to know without importing it. */
  get session() {
    return sessionToken();
  }

  #set(address) {
    /*
     * A SWITCH IN THE WALLET'S OWN INTERFACE LEAVES A CREDENTIAL BEHIND.
     *
     * This fires from `accountChanged`, with no press and no chance to ask for
     * a signature -- and the session in the cookie jar still belongs to the
     * account they just left. Held on to, it is the impersonation this file's
     * header warns about arriving by accident: every panel would go on reading
     * the OLD wallet's balance under the NEW wallet's name, and a stake pressed
     * here would come out of an account that is no longer on screen.
     *
     * So it is let go of locally, which is the half that can be done without a
     * gesture. The arcade falls to signed-out, the button says Connect, and the
     * press that follows signs in as whoever they actually switched to.
     */
    if (address && sessionToken() && !sessionFor(address)) forgetSession();
    this.address = address;
    this.walletName = address ? this.providerName : null;
    try {
      if (address) globalThis.localStorage.setItem(this.prefKey, '1');
      else globalThis.localStorage.removeItem(this.prefKey);
    } catch { /* storage disabled; the session still works, it just will not resume */ }
    carry('zinc_wallet', address);
    this.onChange({ address: this.address, name: this.walletName });
  }

  /**
   * Reconnect silently if this browser has connected before.
   *
   * onlyIfTrusted is the whole point: it resolves for a wallet that has
   * already approved this origin and rejects otherwise, so a returning player
   * keeps their name without every fresh visitor being shown a wallet popup
   * they did not ask for.
   */
  async resume() {
    /*
     * BEFORE ANYTHING ELSE, because this page load may BE the answer to a trip
     * to the wallet app -- and the opt-in check below reads a cookie that this
     * call is about to write.
     */
    await completeDeeplink();
    /* Before the opt-in gate, because a signed-in browser deserves its month
       back whether or not this particular table is one it has connected at. */
    keepSession();
    if (!optedIn(this.prefKey)) return;
    // A phone's wallet is not in the page, so it was not there when this table
    // was built. If a session survived the trip, this is where it is found.
    if (!this.provider) this.#bind(await ensureProvider());
    if (!this.provider) return;
    try {
      const out = await this.provider.connect({ onlyIfTrusted: true });
      const key = out?.publicKey ?? this.provider.publicKey;
      if (key) this.#set(key.toString());
    } catch {
      // Not trusted any more, or the wallet is locked. Silence is correct
      // here: this runs on page load and nobody asked for it.
    }
  }

  /** Ask, with the popup. Throws with something sayable if it does not happen. */
  async connect() {
    // Android's provider does not exist until it is asked for. Everywhere else
    // this is the lookup the constructor already did, and costs nothing.
    if (!this.provider) this.#bind(await ensureProvider());
    if (!this.provider) {
      await offerWalletApps();
      throw Object.assign(new Error(noWalletAdvice()), { code: 'NO_WALLET' });
    }
    try {
      const out = await this.provider.connect();
      const key = out?.publicKey ?? this.provider.publicKey;
      if (!key) throw new Error('the wallet connected without giving an address');
      this.#set(key.toString());
      /*
       * AND SIGN IN, here, on the explicit press -- never on resume(). See
       * connect() above for the argument. If they decline they keep the name
       * and play without a session; nothing here is load-bearing enough to
       * insist, and insisting is what trains people to click through.
       */
      await seat(this.provider, this.address);
      return this.address;
    } catch (err) {
      // 4001 is the wallet standard's "user rejected", and it is not an error
      // worth a red line -- they changed their mind, which is allowed.
      if (err?.code === 4001) {
        throw Object.assign(new Error('Wallet connection cancelled.'), { code: 'CANCELLED' });
      }
      throw err;
    }
  }

  /** Let go: of the wallet, of the session at the box, and of the name here. */
  async disconnect() {
    try { await this.provider?.disconnect?.(); } catch { /* it is going regardless */ }
    await signOut();
    /*
     * AND THE PHONE'S SESSION, which the provider's own disconnect above has
     * already cleared when there was one. This covers the other case: a table
     * built with no provider at all, standing on a stale session in storage
     * that would otherwise resume the wallet the player just let go of.
     */
    if (isMobile()) {
      try {
        const link = await import('./deeplink.js');
        link.forgetDeeplink();
      } catch { /* nothing ever loaded it, so there is nothing to forget */ }
    }
    phone = null;
    this.#set(null);
  }
}
