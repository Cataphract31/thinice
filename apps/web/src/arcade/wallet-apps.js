/*
 * THE WALLET APPS A PHONE CAN BE HANDED OVER TO.
 *
 * A phone browser cannot hold a wallet extension -- extensions are a desktop
 * mechanism -- so on a phone there is nothing for the arcade to talk to and no
 * amount of waiting will produce one. What every mobile wallet ships instead
 * is a BROWSER OF ITS OWN, and a universal link that opens a given page inside
 * it. In there a provider is injected exactly as on a desktop, so the moment
 * the page reloads in the wallet's browser every existing path -- the sign-in
 * ceremony, the session cookie, the bank's deposit and withdrawal -- works
 * untouched, because from the arcade's point of view nothing is different.
 *
 * That is the whole trick, and it is why this file is a list of URLs rather
 * than an integration.
 *
 * ── WHY THIS IS NOT THE MAIN ROUTE ANY MORE, AND WHY IT IS STILL HERE ──
 *
 * It was the main route once. It is now the second of two, because three
 * wallets -- Phantom, Solflare, Backpack -- publish an encrypted deeplink
 * protocol that answers back to THIS browser, so the player stays where they
 * were instead of ending up living inside a wallet app. That is
 * arcade/web/deeplink.js and it is what CONNECT reaches for first.
 *
 * This file survives that for two reasons, and the second is the bigger one:
 *
 *   1. The protocol has to keep a key across a trip to another app, so a
 *      browser with storage switched off cannot use it at all.
 *   2. EVERY OTHER WALLET ON SOLANA. Trust, OKX, Bitget and the rest publish
 *      no such protocol -- what they publish is either nothing, or an SDK with
 *      a build step, an npm tree and a QR code to scan. For their owners this
 *      list is not a fallback, it is the whole of what the arcade can do, and
 *      a panel that omitted them would be telling somebody holding a perfectly
 *      good wallet that it is not supported.
 *
 * Mobile Wallet Adapter -- the Android OS picker, no wallets named in our code
 * -- was built and removed the same day. Its ceremony is four screens
 * including a native permission prompt, and the verdict from the phone it was
 * built for was "this looks like a fucking scammy wallet drainer". See
 * docs/MOBILE_WALLETS.md.
 *
 * ── THE ONE THING TO TELL PEOPLE, AND IT CANNOT BE ENGINEERED AWAY ───
 *
 * The session lives in the WALLET'S browser. Different app, different cookie
 * jar: connect inside Phantom, switch back to Safari or Chrome, and you are
 * signed out there. Nothing a web page can do changes that -- it is why the
 * encrypted route exists and why these wallets are shown below a line saying
 * so, rather than mixed in with the three that come back.
 */

/**
 * WHAT EACH ENTRY IS, AND WHY IT IS A TEMPLATE AND NOT A FUNCTION.
 *
 * Every one of these was read from the vendor's own current documentation --
 * the `source` beside it, which a test checks is really there -- and no wallet
 * is listed that was not. A wallet in this list that does not honour its link
 * is a button that appears to do nothing, and the player cannot tell whether
 * it is the arcade or their phone that is broken.
 *
 * THE FIRST THREE ALSO DO THE ENCRYPTED PROTOCOL (`deep`), which is a better
 * route in every way -- the wallet opens, you approve, you come back to THIS
 * browser still signed in. They appear here as well because this route still
 * works when the other one cannot: a browser with storage switched off cannot
 * keep a key across the trip. The rest of the list is wallets that publish no
 * such protocol at all, where opening the arcade inside the wallet's own
 * browser is the only thing there is. See arcade/web/deeplink.js.
 *
 * THE SHAPES DO NOT AGREE, so each entry carries its own template rather than
 * a base a shared function decorates. Three of them put the target in the
 * PATH; Trust and Bitget put it in a QUERY parameter; OKX nests a whole
 * custom-scheme URL inside an https download page. `{url}` and `{ref}` are
 * substituted URL-encoded, and `{scheme}` is this entry's own `scheme`
 * rendered and then encoded again, which is the only way OKX's shape can be
 * expressed without a function.
 *
 * A `scheme` IS THE ANDROID ESCAPE HATCH. An https link may be answered by the
 * wallet's WEBSITE rather than the app -- an Android App Links decision the
 * arcade never sees -- and the website then offers to install an app the
 * player already has. Where the vendor documents a custom scheme, the link is
 * rewritten to an intent URI that names the app directly. Where it does not,
 * or forbids it, the https link stands.
 */
export const WALLET_APPS = Object.freeze([
  Object.freeze({
    id: 'phantom',
    name: 'Phantom',
    deep: true,
    source: 'https://docs.phantom.com/phantom-deeplinks/other-methods/browse',
    https: 'https://phantom.app/ul/browse/{url}?ref={ref}',
    // No scheme: Phantom documents `phantom://<version>/<method>` for the
    // provider methods and nothing at all for browse, and browse has no
    // version in its path to copy. The package is enough -- see below.
    androidPackage: 'app.phantom',
  }),
  Object.freeze({
    id: 'solflare',
    name: 'Solflare',
    deep: true,
    source: 'https://docs.solflare.com/solflare/technical/deeplinks/other-methods/browse',
    https: 'https://solflare.com/ul/v1/browse/{url}?ref={ref}',
    androidPackage: 'com.solflare.mobile',
  }),
  Object.freeze({
    id: 'backpack',
    name: 'Backpack',
    deep: true,
    source: 'https://docs.backpack.app/deeplinks/other-methods/browse',
    https: 'https://backpack.app/ul/v1/browse/{url}?ref={ref}',
    /*
     * `app.backpack.mobile`, confirmed against the store listing rather than
     * assumed. `com.backpack.app` -- the obvious guess -- is a real, installed
     * Android app called Backpack Care Companion, which has nothing to do with
     * this and would be handed the player's tap.
     */
    androidPackage: 'app.backpack.mobile',
  }),
  Object.freeze({
    id: 'trust',
    name: 'Trust',
    /*
     * coin_id is a SLIP-44 index and 501 is Solana. Trust's own example uses
     * 60, which is Ethereum -- copying the example verbatim would open the
     * wallet on the wrong chain.
     *
     * Its docs are explicit about the two forms: link.trustwallet.com "routes
     * users to a download landing page if the app isn't installed", while
     * trust:// "directly deeplinks users already having the app installed".
     * That is the exact failure Phantom had, described by the vendor, so the
     * scheme is used on Android and the https link is the fallback.
     */
    source: 'https://developer.trustwallet.com/developer/develop-for-trust/deeplinking',
    https: 'https://link.trustwallet.com/open_url?coin_id=501&url={url}',
    scheme: 'trust://open_url?coin_id=501&url={url}',
    androidPackage: 'com.wallet.crypto.trustapp',
  }),
  Object.freeze({
    id: 'okx',
    name: 'OKX',
    /*
     * The nested one. OKX documents building the custom-scheme URL first and
     * then handing it to their own download page as an encoded parameter:
     *
     *   const deepLink = "okx://wallet/dapp/url?dappUrl=" + encodedDappUrl
     *   const encodedUrl = "https://web3.okx.com/download?deeplink=" +
     *                      encodeURIComponent(deepLink)
     *
     * which is why `{scheme}` exists. The download page is the right fallback
     * for somebody who genuinely does not have OKX.
     */
    source: 'https://www.okx.com/web3/build/docs/waas/app-universal-link',
    scheme: 'okx://wallet/dapp/url?dappUrl={url}',
    https: 'https://web3.okx.com/download?deeplink={scheme}',
    androidPackage: 'com.okinc.okex.gp',
  }),
  Object.freeze({
    id: 'bitget',
    name: 'Bitget',
    /*
     * NO SCHEME ON PURPOSE, and this one is the vendor's rule rather than a
     * gap in their documentation. Bitget publishes `bitkeep://bkconnect?...`
     * and then says, in as many words, "Android only support
     * https://bkcode.vip?{params}". The user's phone is Android.
     */
    source: 'https://web3.bitget.com/en/docs/reference/deeplink',
    https: 'https://bkcode.vip?action=dapp&url={url}',
    androidPackage: 'com.bitkeep.wallet',
  }),
  Object.freeze({
    id: 'nightly',
    name: 'Nightly',
    /*
     * THE SOURCE HERE IS THE ENDPOINT ITSELF, which is a weaker citation than
     * the rest of this list and is recorded as such rather than dressed up.
     *
     * Nightly's written documentation describes only Nightly Connect, a relay
     * SDK with a QR code, and this URL appears nowhere in it -- so it was left
     * out, and that was wrong. The page is live, it is Nightly's own domain,
     * and it says what it is in its own words:
     *
     *   "Opening Nightly Wallet -- This page is used as the Nightly
     *    universal-link endpoint. If the app did not open, install Nightly and
     *    try the link again from a supported app or browser context."
     *
     * It echoes the `url` parameter back, which is the behaviour a browse link
     * needs. A vendor's own live endpoint saying "this is the universal-link
     * endpoint" outranks the absence of a paragraph about it.
     */
    source: 'https://nightly.app/v1?network=solana',
    https: 'https://nightly.app/v1?network=solana&cluster=mainnet&url={url}',
    androidPackage: 'com.nightlymobile',
  }),
]);

/** The wallets that also do the encrypted protocol, and the ones that do not. */
export const deepApps = () => WALLET_APPS.filter((a) => a.deep);
export const browseOnlyApps = () => WALLET_APPS.filter((a) => !a.deep);

/*
 * `intent://` IS A CHROMIUM CONVENTION. Firefox for Android does not reliably
 * follow one, and a dead link there would trade a browser that mostly works
 * for one that never does -- Firefox prompts to open a matching app itself,
 * which is the behaviour intent URIs are emulating. iOS has no such thing and
 * does not need one: Apple verifies universal links at install time rather
 * than by a setting a player can leave switched off.
 */
const INTENT_UNSUPPORTED = /firefox|fxios/i;

/**
 * Whether this browser can be handed an intent URI at all.
 *
 * READ AT CALL TIME, never at module load: Node loads this file through the
 * test suite, where there is no navigator until a test puts one there.
 *
 * @returns {boolean}
 */
export function androidIntent() {
  const ua = String(globalThis.navigator?.userAgent ?? '');
  return /android/i.test(ua) && !INTENT_UNSUPPORTED.test(ua);
}

/**
 * An Android intent URI for a custom-scheme wallet link.
 *
 * NAMES THE APP BY PACKAGE, which is the whole point: no domain verification
 * and no per-app "open supported links" toggle stands between the tap and the
 * wallet. `browser_fallback_url` carries the https link for a phone that does
 * not have the app, so the install page still happens where it should.
 *
 * THE FALLBACK IS ENCODED because everything after `#Intent` is separated by
 * semicolons, and a whole URL with its own query would otherwise end the
 * declaration early and be parsed as something else entirely.
 *
 * @param {string} schemeUrl e.g. `trust://open_url?coin_id=501&url=...`
 * @param {string} androidPackage e.g. `com.wallet.crypto.trustapp`
 * @param {string} fallback the https link, used verbatim if this cannot be built
 * @returns {string}
 */
export function intentUri(schemeUrl, androidPackage, fallback) {
  const at = String(schemeUrl).indexOf('://');
  if (at < 1 || !androidPackage) return fallback;
  return `intent://${String(schemeUrl).slice(at + 3)}#Intent`
    + `;scheme=${String(schemeUrl).slice(0, at)}`
    + `;package=${androidPackage}`
    + `;S.browser_fallback_url=${encodeURIComponent(fallback)}`
    + ';end';
}

/**
 * Fill one template.
 *
 * BOTH SUBSTITUTIONS ARE ENCODED, which matters more than it looks. The target
 * is a whole URL sitting inside another URL -- in the path for three of these
 * wallets, in a query parameter for the rest -- so an unencoded `?` or `#` in
 * it would be read as the OUTER link's query or fragment and the wallet would
 * open something else, or, with a `#`, silently drop everything after it.
 * encodeURIComponent is the right tool precisely because it escapes the
 * delimiters encodeURI leaves alone.
 */
function fill(template, url, ref, scheme) {
  return String(template)
    .replaceAll('{url}', encodeURIComponent(url))
    .replaceAll('{ref}', encodeURIComponent(ref))
    .replaceAll('{scheme}', encodeURIComponent(scheme));
}

/**
 * The link that opens `url` inside `app`'s own browser.
 *
 * @param {object} app one of WALLET_APPS
 * @param {string} url  where the wallet should land: an absolute https URL
 * @param {string} ref  who is asking, for the wallet to show the player
 * @returns {string}
 */
export function browseLink(app, url, ref) {
  const scheme = app.scheme ? fill(app.scheme, url, ref, '') : '';
  const https = fill(app.https, url, ref, scheme);
  if (!app.androidPackage || !androidIntent()) return https;
  /*
   * A PACKAGE IS ENOUGH, EVEN WITH NO CUSTOM SCHEME. `intent://` does not have
   * to carry a private scheme: with `scheme=https` and a package it is the
   * ordinary universal link handed to ONE NAMED APP, and naming the component
   * is what takes Android's domain-verification decision out of the loop --
   * the decision that answers a wallet's https link with the wallet's WEBSITE
   * and its download button.
   *
   * These are the vendors' own universal-link hosts, so the app declares a
   * filter for them by definition; that is what makes them universal links.
   * And the floor is today's behaviour either way: an intent that resolves to
   * nothing falls through to `browser_fallback_url`, which is the same https
   * link this would otherwise have returned.
   */
  return intentUri(scheme || https, app.androidPackage, https);
}

/**
 * Where a wallet should be sent, and who is asking.
 *
 * THE CURRENT PAGE, NOT THE FRONT DOOR. Somebody pressing connect at the
 * Barrows table wants to arrive at the Barrows table, not at the portal with
 * their place lost -- and the arcade carries no state in the URL that would
 * survive being dropped at the root.
 *
 * A HASH IS DROPPED and a query is kept. The query can carry which world or
 * which table a page is, and losing it changes where the wallet lands; the
 * fragment is never read by anything here and is exactly the character most
 * likely to be mangled by a link passing through two apps.
 *
 * @returns {{url: string, ref: string} | null} null off a browser
 */
export function whereWeAre() {
  const loc = globalThis.location;
  if (!loc?.origin || loc.origin === 'null') return null;
  return {
    url: `${loc.origin}${loc.pathname}${loc.search}`,
    ref: loc.origin,
  };
}
