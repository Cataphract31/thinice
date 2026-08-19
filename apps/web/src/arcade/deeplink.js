/*
 * CONNECTING A PHONE WALLET THE WAY EVERY OTHER SITE DOES IT.
 *
 * Press connect. The wallet app opens. Approve. You are back in the browser
 * you started in, connected. No permission dialogs, no local sockets, no
 * modal in somebody else's styling, and nothing that looks like it is asking
 * for more than it needs.
 *
 * -- THE TWO THINGS THIS REPLACED, AND WHY BOTH FAILED --------------------
 *
 * A BROWSE DEEPLINK into the wallet's own in-app browser. Shipped first,
 * still correct on iOS as a manual fallback, and it failed on the first
 * Android phone that used it: Android sent phantom.app to the WEB instead of
 * to the app, and phantom.app's page for a phone is an advert for Phantom. The
 * player had Phantom installed and was shown a download button. That decision
 * belongs to the OS and no URL can override it.
 *
 * MOBILE WALLET ADAPTER. Technically the better Android mechanism -- an OS
 * intent, an OS picker, no wallets named in our code -- and in practice a
 * ceremony that read as a phishing attempt: a modal from the library, then
 * Chrome's native Local Network Access prompt, then the picker, then the
 * wallet. Four screens before anything happened, two of them asking for
 * permissions in language nobody outside this field can evaluate. Then the
 * association did not complete: the wallet opened, the player authenticated,
 * and the browser sat on a spinner because the loopback WebSocket never came
 * back. Removed rather than debugged, because even working it was the wrong
 * experience for a page that is asking somebody to trust it with money.
 *
 * -- WHAT THIS IS -------------------------------------------------------
 *
 * The wallets' own encrypted deeplink protocol. Phantom and Solflare document
 * it identically apart from one parameter name, so this is one implementation
 * and a two-row table.
 *
 *   1. The browser makes an x25519 keypair and sends its public half to the
 *      wallet in a link.
 *   2. The wallet answers with its own public half, and both sides derive the
 *      same shared secret. Everything after that is encrypted end to end, so
 *      the session token cannot be read out of a URL by anything the link
 *      passes through.
 *   3. Each later request is a link carrying an encrypted payload, and each
 *      answer comes back the same way.
 *
 * -- THE SHAPE THIS FORCES, WHICH IS THE PART TO UNDERSTAND ---------------
 *
 * A DEEPLINK IS A NAVIGATION, NOT A FUNCTION CALL. The page is destroyed and
 * a new one is built when the wallet sends the player back. So there is no
 * promise that resolves: `connect()` here navigates and never returns, and
 * the work it started is finished on the NEXT page load by completeReply().
 *
 * That is why this module is a state machine with its state in localStorage,
 * and why every step records what it was doing before it leaves. A step that
 * forgot would strand somebody mid-connect with no way to tell what had
 * happened -- which is exactly the failure that made Mobile Wallet Adapter
 * unusable, arrived at from the other direction.
 *
 * -- WHAT DOES NOT CHANGE ------------------------------------------------
 *
 * THE BROWSER COMPOSES NOTHING. The transaction a wallet is asked to sign is
 * the one the BOX built, from the SESSION's wallet to the arcade's own
 * address, and it travels through here as the base58 the box already
 * published. Coming back it is signed bytes, which go to the box to broadcast
 * -- and the box refuses to broadcast anything it did not build itself. See
 * submitDeposit in arcade/money/custody.js.
 *
 * THE STATEMENT IS SIGNED AS ISSUED. Same rule as every other path: the
 * server writes the words, the wallet signs those exact bytes, and nothing
 * here rewrites them.
 *
 * NO BROWSER GLOBAL IS TOUCHED AT MODULE LOAD. Node loads this through the
 * test suite; everything that reads a browser reads it inside a function.
 */

import { arcadeUrl } from './origin.js';
import { base58Decode, base58Encode } from './base58.js';
import { androidIntent, intentUri } from './wallet-apps.js';

/**
 * THE WALLETS THAT DOCUMENT THIS PROTOCOL, and nothing else.
 *
 * All three were read from the vendor's own current documentation on 19
 * August 2026 and all three describe the same request shape, the same
 * encryption and the same response -- differing only in what they call their
 * own public key on the way back, which is why that is a field rather than a
 * third code path.
 *
 * NOTHING IS LISTED HERE ON REPUTATION. A wallet that appears in this panel
 * and does not honour these links is a button that opens an app and then
 * silently does nothing, which is worse for a player than not offering it at
 * all. Jupiter Mobile is popular and is absent for exactly that reason: it
 * connects over WalletConnect through Reown's AppKit and its own npm adapter
 * (@jup-ag/jup-mobile-adapter, a Reown project id, a QR code to scan), and it
 * publishes no URL a page can simply navigate to.
 *
 * https://docs.phantom.com/phantom-deeplinks/provider-methods/connect
 * https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/connect
 * https://docs.backpack.app/deeplinks/provider-methods/connect
 * https://developers.jup.ag/docs/tool-kits/wallet-kit/jupiter-mobile-adapter
 */
export const DEEPLINK_WALLETS = Object.freeze([
  Object.freeze({
    id: 'phantom',
    name: 'Phantom',
    base: 'https://phantom.app/ul/v1/',
    keyParam: 'phantom_encryption_public_key',
    // https://docs.phantom.com/phantom-deeplinks/provider-methods/connect
    // "It is also possible (but not recommended) to call these methods using
    //  Phantom's custom protocol handler: phantom://<version>/<method>"
    schemeBase: 'phantom://v1/',
    androidPackage: 'app.phantom',
  }),
  Object.freeze({
    id: 'solflare',
    name: 'Solflare',
    base: 'https://solflare.com/ul/v1/',
    keyParam: 'solflare_encryption_public_key',
    /*
     * NOTE THE ul/ , WHICH PHANTOM DROPS AND SOLFLARE KEEPS. Not documented in
     * prose anywhere; taken from Solflare's own React Native sample app, which
     * builds every request as
     *
     *     `solflare://ul/${path}?${params}`
     *
     * Assuming the two wallets agreed on this because they agree on everything
     * else would have produced solflare://v1/connect -- a link that opens the
     * right app and then does nothing, which is the failure mode with no error
     * message attached to it.
     *
     * https://github.com/solflare-wallet/deep-link-sample-app/blob/master/App.tsx
     */
    schemeBase: 'solflare://ul/v1/',
    androidPackage: 'com.solflare.mobile',
  }),
  Object.freeze({
    id: 'backpack',
    name: 'Backpack',
    // https://docs.backpack.app/deeplinks/provider-methods/connect
    base: 'https://backpack.app/ul/v1/',
    /*
     * NO SCHEME BUT A PACKAGE, which is enough. `app.backpack.mobile`,
     * confirmed against the store listing -- `com.backpack.app` is a real
     * Android app called Backpack Care Companion. With the package named, the
     * https link below can be handed straight to this app instead of being
     * offered to Android to route, which is where Phantom's went wrong.
     */
    androidPackage: 'app.backpack.mobile',
    /*
     * NOT backpack_encryption_public_key. Backpack names its key after the
     * role rather than after itself, and the method pages write it as a
     * placeholder -- it is spelled out only on the encryption page:
     *
     *   "Backpack will return this public key as wallet_encryption_public_key
     *    in the connect response"
     *
     * https://docs.backpack.app/deeplinks/encryption
     */
    keyParam: 'wallet_encryption_public_key',
    /*
     * NO SCHEME, AND THAT IS A REAL GAP RATHER THAN AN OVERSIGHT. Backpack's
     * documentation says universal links "(recommended) or deeplinks" in the
     * same words Solflare uses, so a custom scheme very likely exists -- but it
     * is not written down on the deeplinks page, the provider-methods index,
     * any method page, or in a sample app that could be read.
     *
     * Guessing `backpack://ul/v1/` would be a coin flip between Phantom's shape
     * and Solflare's, and the losing side opens the app and silently does
     * nothing. So on an Android phone whose App Links are not verified for
     * backpack.app, this wallet lands on the website -- exactly the failure
     * Phantom had. Fix it by reading, not by guessing.
     */
  }),
]);

/**
 * The wallet's own encryption key, out of the reply it sent back.
 *
 * THE DOCUMENTED NAME FIRST, THEN ANY WALLET'S NAME. Each vendor labels this
 * after itself -- phantom_encryption_public_key, solflare_... -- except
 * Backpack, which labels it after the role (wallet_encryption_public_key) and
 * writes it as a placeholder on every page but one. Reading three wallets and
 * finding three spellings, one of them nearly unfindable, is the argument for
 * not requiring a fourth to be spelled correctly here before it can work.
 *
 * Falling back to "any parameter ending in _encryption_public_key" costs
 * nothing in safety: the value is only ever used to derive a shared secret, and
 * a wrong one produces a secret that decrypts nothing. A reply that cannot be
 * read is already handled as a refusal. What it buys is a wallet that works
 * when its documentation is vague, and the next wallet working before anybody
 * edits this file.
 */
function theirKey(wallet, params) {
  const named = params.get(wallet?.keyParam ?? '');
  if (named) return named;
  for (const [key, value] of params) {
    if (key.endsWith('_encryption_public_key') && value) return value;
  }
  return null;
}

/*
 * WHY AN HTTPS LINK IS NOT ENOUGH ON ANDROID.
 *
 * Reported from a real phone, twice, on two different link shapes:
 *
 *   "i press connect, choose phantom, phantom.com domain link opens, few
 *    seconds later it says download for phantom mobile"
 *
 * Phantom was installed. What failed is Android App Links: whether
 * https://phantom.app/... opens the APP or the SITE is a decision the OS makes
 * from domain-verification state and a per-app "open supported links" setting
 * the player has probably never seen. When it decides "site", phantom.app's
 * page for a phone politely offers to install the app they already have. The
 * arcade never sees that decision and cannot override it with a better URL.
 *
 * An intent URI does not ask. It names the app by package and uses the
 * wallet's OWN scheme, so neither domain verification nor a settings toggle is
 * involved -- and `browser_fallback_url` carries the https link for the person
 * who genuinely does not have the wallet, so the install page still happens
 * where it should.
 */
/**
 * The Android-native form of a wallet link, or the https link unchanged.
 *
 * THE SCHEME BASE IS PER-WALLET AND THEY DO NOT AGREE. Phantom's is
 * `phantom://v1/` and Solflare's is `solflare://ul/v1/` -- the `ul/` that marks
 * a UNIVERSAL link is dropped by one and kept by the other. So this splits the
 * wallet's own base rather than deriving one by rewriting the https URL, which
 * is what would quietly produce a working link for one wallet and a link that
 * opens the right app and does nothing for the next.
 *
 * THE URI ITSELF IS BUILT IN ONE PLACE, arcade/web/wallet-apps.js, because the
 * browse links have exactly the same problem with exactly the same fix and two
 * copies of this would eventually disagree. What is here is which wallets have
 * a scheme and where the method goes in it.
 *
 * @param {{schemeBase?: string, androidPackage?: string}} wallet
 * @param {string} method `connect`, `signMessage`, `signTransaction`
 * @param {string} https the universal link, which is also the fallback
 * @returns {string}
 */
export function androidNative(wallet, method, https) {
  if (!wallet?.androidPackage || !androidIntent()) return https;
  /*
   * A WALLET WITH NO PUBLISHED SCHEME STILL GETS THE APP. The intent carries
   * `scheme=https` and the universal link unchanged, aimed at one named
   * package -- which is the part that matters, because naming the component
   * removes Android's domain-verification decision from the path. Backpack is
   * the wallet this is for: it documents the protocol and no scheme at all.
   */
  const target = wallet.schemeBase
    ? `${wallet.schemeBase}${method}${new URL(https).search}`
    : https;
  return intentUri(target, wallet.androidPackage, https);
}

const walletById = (id) => DEEPLINK_WALLETS.find((w) => w.id === id) ?? null;

/** Where the session and the channel keys live between two page loads. */
const STORE = 'zinc.deeplink';
/** Which wallet this browser picked, so it is asked once and not every time. */
const PICKED = 'zinc.deeplink.wallet';
/** The marker on a redirect that says a reply is ours and which step it answers. */
const MARK = 'zinc_link';

/*
 * A STEP IS ABANDONED AFTER TEN MINUTES.
 *
 * The player left for the wallet app and did not come back -- they closed it,
 * got a phone call, or changed their mind and opened the arcade fresh an hour
 * later. Without an expiry, that stale step would be resumed on some future
 * visit and the arcade would silently start signing something nobody asked
 * about. Ten minutes is long enough for an interrupted approval and short
 * enough that nothing surprising resumes.
 */
const STEP_TTL_MS = 10 * 60 * 1000;

function readStore() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORE) ?? 'null') ?? null;
  } catch {
    return null;
  }
}

function writeStore(value) {
  try {
    if (value) globalThis.localStorage.setItem(STORE, JSON.stringify(value));
    else globalThis.localStorage.removeItem(STORE);
  } catch { /* storage disabled: this browser cannot do deeplinks, and says so */ }
}

/** Whether this browser can hold a session across the trip to the wallet. */
export function deeplinkPossible() {
  try {
    const probe = '__zinc_probe';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return Boolean(globalThis.location?.origin) && globalThis.location.origin !== 'null';
  } catch {
    return false;
  }
}

/** The wallet this browser chose last time, so it is not asked twice. */
export function rememberedWallet() {
  try {
    const id = globalThis.localStorage?.getItem(PICKED);
    return walletById(id) ? id : null;
  } catch {
    return null;
  }
}

/** A connected wallet, or null. */
export function deeplinkSession() {
  const held = readStore();
  if (!held?.session || !held?.address) return null;
  return { wallet: held.wallet, address: held.address, name: walletById(held.wallet)?.name ?? 'Wallet' };
}

/**
 * Forget everything: the channel, the session, the address -- and any trip
 * that was in flight, which now outlives the tab that started it and would
 * otherwise be resumed against a connection that no longer exists.
 */
export function forgetDeeplink() {
  writeStore(null);
  try { globalThis.sessionStorage?.removeItem(`${STORE}.step`); } catch { /* nothing to clear */ }
  try { globalThis.localStorage?.removeItem(`${STORE}.step`); } catch { /* nothing to clear */ }
}

/* ==========================================================================
 * THE ENCRYPTED CHANNEL
 * ====================================================================== */

let naclPromise = null;
const nacl = () => (naclPromise ??= import('./vendor/nacl.min.js'));

/**
 * Make this browser's half of the channel and remember it.
 *
 * THE SECRET KEY GOES IN localStorage, which is worth being explicit about
 * rather than quiet. It is a CHANNEL key and not a signing key: everything it
 * protects is a request the wallet will still show the player before acting
 * on. Somebody who stole it could read the session token, and the session
 * token buys the ability to ASK the wallet for a signature -- which is what
 * the wallet's own approval screen exists to refuse. It cannot move money on
 * its own, and there is nowhere safer to put it, because it has to survive the
 * page being destroyed and rebuilt.
 */
async function freshChannel(walletId) {
  const { box } = await nacl();
  const pair = box.keyPair();
  const held = {
    wallet: walletId,
    secret: base58Encode(pair.secretKey),
    pub: base58Encode(pair.publicKey),
    shared: null,
    session: null,
    address: null,
  };
  writeStore(held);
  return held;
}

/** The shared secret, derived once and kept. */
async function sharedSecret(held) {
  const bytes = base58Decode(held.shared ?? '');
  if (!bytes) throw new Error('no channel');
  return bytes;
}

async function encrypt(held, payload) {
  const { box, randomBytes } = await nacl();
  const nonce = randomBytes(24);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = box.after(plain, nonce, await sharedSecret(held));
  return { nonce: base58Encode(nonce), payload: base58Encode(sealed) };
}

/**
 * Read one of the wallet's answers, or null if it is not readable.
 *
 * NULL COVERS EVERY KIND OF WRONG, and they are all the same wrong from here:
 * a truncated URL, a link a messaging app rewrote, a reply meant for a channel
 * this browser no longer has, or somebody hand-editing the query string. The
 * cipher is authenticated, so a tampered payload does not decrypt to something
 * plausible -- it does not decrypt at all.
 */
async function decrypt(held, nonceText, dataText) {
  try {
    const { box } = await nacl();
    const nonce = base58Decode(nonceText);
    const sealed = base58Decode(dataText);
    if (!nonce || !sealed) return null;
    const plain = box.open.after(sealed, nonce, await sharedSecret(held));
    if (!plain) return null;
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/* ==========================================================================
 * LEAVING, AND COMING BACK
 * ====================================================================== */

/**
 * Where the wallet should send the player, carrying which step it is answering.
 *
 * THE PAGE THEY WERE ON, with its query intact. Somebody who pressed connect
 * at a table wants to come back to that table, and a game's query string can
 * say which world or which seat -- so dropping it would land them somewhere
 * else and look like the arcade losing their place. The fragment is dropped:
 * nothing here reads one, and it is the part most likely to be mangled by a
 * link passing through two apps.
 */
function returnLink(step) {
  const loc = globalThis.location;
  const url = new URL(`${loc.origin}${loc.pathname}${loc.search}`);
  url.searchParams.set(MARK, step);
  return url.toString();
}

/** Which cluster the box is on, in the word these wallets use for it. */
async function cluster() {
  try {
    const answered = await fetch(arcadeUrl('/api/custody/deposit'), {
      headers: { accept: 'application/json' },
    });
    if (answered.ok) {
      const { network } = await answered.json();
      if (network === 'devnet') return 'devnet';
      if (network === 'testnet') return 'testnet';
    }
  } catch { /* unreachable box; the arcade runs on mainnet */ }
  return 'mainnet-beta';
}

/** Where the step is written. See leaveFor: BOTH, on purpose. */
const STEP_KEY = `${STORE}.step`;

/**
 * Record what we are in the middle of, then go.
 *
 * IN BOTH STORES, AND THAT IS THE WHOLE MOBILE SIGN-IN BUG.
 *
 * This wrote the step to sessionStorage alone. sessionStorage IS PER TAB, and
 * the trip this function makes is a trip to another app -- which sends the
 * player back through `redirect_link`, and a wallet is entitled to open that in
 * a NEW TAB. It generally does. A new tab is a new sessionStorage, so the step
 * was simply gone when the answer arrived.
 *
 * The damage was not spread evenly, which is why this hid for so long and
 * looked like several different bugs:
 *
 *   CONNECT SURVIVED. finishConnect() reads the channel out of localStorage and
 *     the wallet's key out of the URL, and never looks at the step at all. So
 *     the address came back, the page said "connected", and everything looked
 *     right.
 *   SIGN-IN DIED, SILENTLY. finishSignIn() needs `authNonce` -- the challenge
 *     the box issued before leaving -- and it lives ONLY in the step. Without
 *     it the arcade was posted a signature over a nonce it was not told, refused
 *     it, and the failure went back up into a page with nothing to show it on.
 *
 * So the phone connected and could never sign in: an address on screen, no
 * session behind it, a bank that says connect your wallet, and a table that
 * says it keeps no guest balance -- over the player's own address. Pressing
 * connect again just repeated the same two trips. The only thing that ever
 * changed anything was disconnecting, which is not a fix, it is a coin flip on
 * whether the next return lands in the tab that started it.
 *
 * localStorage is where the rest of this machine already keeps its state -- the
 * channel keypair, the wallet session, the address -- for exactly this reason;
 * see the header. The step was the one piece left outside it.
 *
 * SESSIONSTORAGE IS STILL WRITTEN, and preferred on the way back. When the
 * return DOES land in the tab that left, it is the tighter answer: scoped to
 * that tab, and it cannot be read by a second one. This is a fallback added
 * beneath it rather than a replacement for it.
 */
function leaveFor(url, step, context = {}) {
  const record = JSON.stringify({ step, at: Date.now(), ...context });
  try { globalThis.sessionStorage?.setItem(STEP_KEY, record); } catch { /* see below */ }
  try { globalThis.localStorage?.setItem(STEP_KEY, record); } catch { /* then this browser cannot deeplink */ }
  globalThis.location.href = url;
}

/**
 * The step being answered, and it is CLEARED FROM BOTH STORES either way.
 *
 * Read once and gone, because a step is a single trip: left behind in the
 * durable store it would be resumed by some later page load, which is the
 * thing STEP_TTL_MS exists to bound and this makes unreachable in the ordinary
 * case. Cleared even when it has expired, and even when the tab-scoped copy is
 * the one that answered -- a stale record in the other store is exactly the
 * one that would surface a week later.
 */
function takeStep() {
  let raw = null;
  try {
    raw = globalThis.sessionStorage?.getItem(STEP_KEY) ?? null;
    globalThis.sessionStorage?.removeItem(STEP_KEY);
  } catch { /* no sessionStorage; the durable copy below is the whole answer */ }
  try {
    raw ??= globalThis.localStorage?.getItem(STEP_KEY) ?? null;
    globalThis.localStorage?.removeItem(STEP_KEY);
  } catch { /* nothing kept it; the caller reports a step it cannot finish */ }
  try {
    const step = JSON.parse(raw ?? 'null');
    if (!step || Date.now() - Number(step.at ?? 0) > STEP_TTL_MS) return null;
    return step;
  } catch {
    return null;
  }
}

/**
 * Take our parameters back out of the address bar.
 *
 * NOT COSMETIC. Left in place, a refresh -- or the browser restoring the tab
 * next week -- would hand the same reply to completeReply() again, and a
 * replayed deposit reply would try to broadcast a transaction a second time.
 * It is also somebody's wallet address and an encrypted session sitting in a
 * URL that gets shared, bookmarked and put in browser history.
 */
function scrubUrl() {
  try {
    const loc = globalThis.location;
    const url = new URL(loc.href);
    for (const key of [MARK, 'nonce', 'data', 'errorCode', 'errorMessage',
      ...DEEPLINK_WALLETS.map((w) => w.keyParam)]) {
      url.searchParams.delete(key);
    }
    globalThis.history?.replaceState?.({}, '', url.pathname + url.search + url.hash);
  } catch { /* no history API; the params stay and the guard below still holds */ }
}

/**
 * Is there a wallet's answer sitting in this page's address bar?
 *
 * SYNCHRONOUS AND CHEAP, deliberately: it runs on every page load in the
 * arcade, and the whole point is that a page with no reply in it never
 * imports a cipher, a decoder or this module's machinery at all.
 *
 * @returns {{step: string} | null}
 */
export function deeplinkReply() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const step = params.get(MARK);
    return step ? { step } : null;
  } catch {
    return null;
  }
}

/* ==========================================================================
 * THE STEPS
 * ====================================================================== */

/**
 * Everything needed to offer a connect, as REAL LINKS.
 *
 * WHY LINKS AND NOT A BUTTON THAT NAVIGATES. A phone treats a tapped <a> as a
 * user-initiated navigation to another app, which is exactly what is being
 * asked for; `location.href = ...` is the same URL through a path Safari is
 * entitled to block, and it also loses long-press, "open in new tab", and the
 * address preview a careful person uses to check where a link goes. On the
 * screen that hands a wallet over, that preview is worth keeping.
 *
 * ONE KEYPAIR FOR BOTH OFFERS, because only one of them will ever be taken and
 * generating a second would mean deciding which to keep at the moment the page
 * is already leaving. The wallet is recorded by commit() in the click handler,
 * which runs before the browser follows the link.
 *
 * @returns {Promise<{links: {id: string, name: string, href: string}[], commit: (id: string) => void}>}
 */
export async function prepareConnect() {
  const held = await freshChannel(null);
  const where = returnLink('connect');
  const net = await cluster();

  const links = DEEPLINK_WALLETS.map((wallet) => {
    const url = new URL(`${wallet.base}connect`);
    url.searchParams.set('app_url', globalThis.location.origin);
    url.searchParams.set('dapp_encryption_public_key', held.pub);
    url.searchParams.set('redirect_link', where);
    url.searchParams.set('cluster', net);
    return { id: wallet.id, name: wallet.name, href: androidNative(wallet, 'connect', url.toString()) };
  });

  /**
   * Record which wallet is being opened, before the browser goes there.
   *
   * NOT OPTIONAL AND NOT ASYNC. The reply carries the wallet's public key
   * under a parameter NAMED FOR THAT WALLET, so a return with no record of
   * which one was tapped cannot be read at all. localStorage is synchronous,
   * which is what makes this safe to do in a click handler that is about to
   * lose the page.
   */
  const commit = (id) => {
    if (!walletById(id)) return;
    held.wallet = id;
    writeStore(held);
    try {
      globalThis.localStorage?.setItem(PICKED, id);
    } catch { /* they will be asked again next time, which is survivable */ }
  };

  return { links, commit };
}

/**
 * Step one, when the wallet is already known: go straight there.
 *
 * The second and every later connect from this browser. Somebody who has
 * picked Phantom once should not be shown a list of wallets again -- press
 * connect, Phantom opens. See rememberedWallet().
 *
 * Navigates and does not return.
 *
 * @param {string} walletId one of DEEPLINK_WALLETS
 */
export async function beginConnect(walletId) {
  const wallet = walletById(walletId);
  if (!wallet) throw new Error(`no such wallet: ${walletId}`);
  const { links, commit } = await prepareConnect();
  commit(wallet.id);
  leaveFor(links.find((l) => l.id === wallet.id).href, 'connect');
}

/**
 * Step two: prove the address is theirs. Navigates and does not return.
 *
 * THE STATEMENT IS THE BOX'S, WORD FOR WORD. It is fetched here and signed
 * exactly as received -- rebuilding that sentence in the browser would be a
 * second implementation of the one thing that must never disagree, because a
 * signature over slightly different bytes verifies against nothing at all.
 */
async function beginSignIn(held, address) {
  const wallet = walletById(held.wallet);
  const asked = await fetch(arcadeUrl('/api/auth/challenge'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: address }),
  });
  if (!asked.ok) throw new Error('the arcade would not issue a challenge');
  const { nonce, statement } = await asked.json();
  if (!nonce || !statement) throw new Error('the arcade issued an empty challenge');

  const { nonce: boxNonce, payload } = await encrypt(held, {
    message: base58Encode(new TextEncoder().encode(statement)),
    session: held.session,
    display: 'utf8',
  });

  const url = new URL(`${wallet.base}signMessage`);
  url.searchParams.set('dapp_encryption_public_key', held.pub);
  url.searchParams.set('nonce', boxNonce);
  url.searchParams.set('redirect_link', returnLink('signin'));
  url.searchParams.set('payload', payload);
  leaveFor(androidNative(wallet, 'signMessage', url.toString()), 'signin', { authNonce: nonce, address });
}

/**
 * A deposit: the wallet signs the box's transaction. Navigates, does not return.
 *
 * signTransaction RATHER THAN signAndSendTransaction, because the wallets
 * deprecated the second and say so in their own documentation. What comes back
 * is signed bytes that nobody has broadcast, which turns out to be the better
 * arrangement anyway: the box broadcasts, and the box can therefore refuse to
 * broadcast anything it did not build.
 *
 * @param {{transaction: string, lamports: number}} prepared from the box
 */
export async function beginDeposit(prepared) {
  const held = readStore();
  if (!held?.session) throw Object.assign(new Error('No wallet connected.'), { code: 'NO_WALLET' });
  const wallet = walletById(held.wallet);

  const { nonce, payload } = await encrypt(held, {
    transaction: prepared.transaction,
    session: held.session,
  });

  const url = new URL(`${wallet.base}signTransaction`);
  url.searchParams.set('dapp_encryption_public_key', held.pub);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('redirect_link', returnLink('deposit'));
  url.searchParams.set('payload', payload);
  leaveFor(androidNative(wallet, 'signTransaction', url.toString()), 'deposit',
    { lamports: Number(prepared.lamports) });
}

/* ==========================================================================
 * COMING BACK
 * ====================================================================== */

let completing = null;

/**
 * Finish whatever the wallet was asked to do, if this page load is an answer.
 *
 * MEMOISED, because several things on a page have a legitimate reason to ask
 * -- the chrome on load, a table resuming, the bank opening -- and running the
 * continuation twice would mean two sign-in attempts, or two broadcasts of one
 * deposit. The first caller does the work and everybody gets its answer.
 *
 * @returns {Promise<{kind: string, [k: string]: any} | null>}
 */
export function completeReply() {
  return (completing ??= runReply());
}

async function runReply() {
  const reply = deeplinkReply();
  if (!reply) return null;

  const params = new URLSearchParams(globalThis.location.search);
  const step = takeStep();
  scrubUrl();

  const errorCode = params.get('errorCode');
  if (errorCode) {
    /*
     * The player said no, or the wallet refused. 4001 is what every wallet
     * uses for "they changed their mind", which is not an error worth a red
     * line anywhere in the arcade.
     */
    const said = params.get('errorMessage') || 'The wallet refused.';
    return errorCode === '4001'
      ? { kind: 'cancelled', message: 'Cancelled. Nothing happened.' }
      : { kind: 'error', message: said };
  }

  const held = readStore();
  if (!held) return { kind: 'error', message: 'That reply arrived after the connection was cleared.' };

  try {
    if (reply.step === 'connect') return await finishConnect(held, params);
    if (reply.step === 'signin') return await finishSignIn(held, params, step);
    if (reply.step === 'deposit') return await finishDeposit(held, params, step);
  } catch (err) {
    return { kind: 'error', message: err?.message ?? 'That did not finish.' };
  }
  return null;
}

async function finishConnect(held, params) {
  const wallet = walletById(held.wallet);
  const theirs = base58Decode(theirKey(wallet, params) ?? '');
  if (!theirs) return { kind: 'error', message: 'The wallet answered without a key.' };

  const { box } = await nacl();
  const mine = base58Decode(held.secret);
  if (!mine) return { kind: 'error', message: 'This browser lost its half of the connection.' };
  held.shared = base58Encode(box.before(theirs, mine));

  const data = await decrypt(held, params.get('nonce'), params.get('data'));
  if (!data?.public_key || !data?.session) {
    return { kind: 'error', message: 'The wallet’s answer could not be read.' };
  }
  held.address = String(data.public_key);
  held.session = String(data.session);
  writeStore(held);

  return { kind: 'connected', address: held.address, name: wallet.name, held };
}

async function finishSignIn(held, params, step) {
  const data = await decrypt(held, params.get('nonce'), params.get('data'));
  if (!data?.signature) return { kind: 'error', message: 'The wallet did not return a signature.' };
  const signature = base58Decode(String(data.signature));
  if (!signature) return { kind: 'error', message: 'That signature was not readable.' };

  const proof = await fetch(arcadeUrl('/api/auth/verify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wallet: held.address,
      nonce: step?.authNonce,
      signature: btoa(String.fromCharCode(...signature)),
    }),
  });
  if (!proof.ok) return { kind: 'error', message: 'The arcade did not accept that signature.' };
  const { token } = await proof.json();
  if (typeof token !== 'string' || !token) {
    return { kind: 'error', message: 'The arcade issued no session.' };
  }
  return { kind: 'signed-in', address: held.address, token };
}

async function finishDeposit(held, params, step) {
  const data = await decrypt(held, params.get('nonce'), params.get('data'));
  if (!data?.transaction) return { kind: 'error', message: 'The wallet did not return a transaction.' };
  const signed = base58Decode(String(data.transaction));
  if (!signed) return { kind: 'error', message: 'That transaction was not readable.' };

  /*
   * TO THE BOX, NOT TO A CHAIN. The browser has no RPC and should not have
   * one, and the box refuses to broadcast anything it did not build -- so the
   * only thing that can be submitted through here is the deposit the player
   * was already shown. Base64 because that is what survives a JSON body
   * without a decoder at the other end.
   */
  const sent = await fetch(arcadeUrl('/api/custody/deposit/submit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify({ transaction: btoa(String.fromCharCode(...signed)) }),
  });
  const answer = await sent.json().catch(() => ({}));
  if (!sent.ok) {
    return { kind: 'error', message: answer?.error?.message ?? 'The arcade could not send that.' };
  }
  return { kind: 'deposited', signature: answer.signature, lamports: Number(step?.lamports ?? 0) };
}

/** The arcade session, read the same way everything else reads it. */
function authHeader() {
  try {
    const found = globalThis.document?.cookie?.match(/(?:^|;\s*)zinc_session=([^;]*)/);
    const token = found ? decodeURIComponent(found[1]) : '';
    return /^[0-9a-f]{64}$/.test(token) ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * Carry on from a completed connect into signing in, without asking again.
 *
 * TWO WALLET SCREENS AND ONE PRESS. Connecting says who you are; the arcade
 * still needs proof, and proof is a second trip. Chaining it here means the
 * player taps connect once and approves twice, rather than pressing connect,
 * arriving back half-connected, and having to work out that something else is
 * expected of them.
 */
export async function continueToSignIn(result) {
  if (result?.kind !== 'connected') return result;
  await beginSignIn(result.held, result.address);
  return result;
}

/* ==========================================================================
 * WEARING THE SHAPE THE REST OF THE ARCADE READS
 * ====================================================================== */

/**
 * The phone's wallet, dressed as the provider everything else expects.
 *
 * WHY IT LOOKS LIKE AN EXTENSION. Four games, the bank panel and the portal
 * were written against the injected-provider shape -- connect(), publicKey,
 * disconnect() -- because that is what a browser extension gives you. Making
 * the phone route wear the same shape is what let it arrive without a line
 * changing in any of them.
 *
 * WHERE THE RESEMBLANCE STOPS, and this is the part to understand before
 * using it: an extension answers in place, and a phone wallet answers by
 * REPLACING THIS PAGE. So the methods that need the wallet navigate away and
 * their promises never settle -- there is nothing to return to a caller that
 * is about to stop existing. `isDeeplink` is how a caller that must know can
 * tell; the bank is the only one that does.
 *
 * @returns {object|null} null when this browser has no session
 */
export function deeplinkProvider() {
  const held = readStore();
  if (!held?.session || !held?.address) return null;

  const key = { toString: () => held.address, toBase58: () => held.address };

  return {
    /** Says the wallet is another app, so a caller can expect to be replaced. */
    isDeeplink: true,
    get publicKey() { return key; },
    get connected() { return true; },

    /** Already connected: the trip that proved it happened on an earlier load. */
    async connect() { return { publicKey: key }; },

    /**
     * Prove the address again. Navigates and does not return.
     *
     * Reached when the arcade has an address but no session -- the cookie
     * lapsed, or they cleared it -- and the argument is ignored on purpose:
     * the statement is fetched fresh from the box inside beginSignIn, because
     * a nonce that has already been spent proves nothing.
     */
    async signMessage() {
      await beginSignIn(readStore(), held.address);
      return new Promise(() => {});
    },

    /** A deposit: the box's transaction, into the wallet. Navigates. */
    async deposit(prepared) {
      await beginDeposit(prepared);
      return new Promise(() => {});
    },

    async disconnect() {
      forgetDeeplink();
    },

    /*
     * NO EVENTS, AND NOT AN OVERSIGHT. An extension can tell a page that the
     * player switched accounts, because it is in the page. A wallet app cannot
     * -- it has no channel to a browser tab it is not in -- so there is nothing
     * to subscribe to. Accepting the call and doing nothing is right: every
     * caller registers listeners unconditionally, and a missing method would
     * make each of them decide what to do about it separately.
     */
    on() {},
    off() {},
  };
}
