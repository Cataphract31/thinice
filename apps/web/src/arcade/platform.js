/*
 * WHAT KIND OF THING IS LOOKING AT THIS PAGE, and what to tell it when there
 * is no wallet.
 *
 * The arcade told every browser with no injected provider the same sentence:
 * "No Solana wallet found in this browser. Install Phantom or Solflare, then
 * reload." On a desktop that is true and actionable. On a phone it is false in
 * both halves. The person almost certainly HAS the wallet -- they are holding
 * it -- and reloading will never help, because no wallet app can inject a
 * provider into mobile Safari or Chrome at all. Extensions are a desktop
 * mechanism. So the arcade was telling people to fix a problem they did not
 * have, with a step that cannot work, on the platform where they were most
 * likely to give up.
 *
 * That sentence was written out in FIVE shipping files, which is why this
 * module exists rather than five corrections. See docs/MOBILE_WALLETS.md for
 * the mechanisms that actually work on each platform and the vendor
 * documentation they were checked against.
 *
 * ARCADE FURNITURE, LIKE THE BANK. Games may not write a path starting with
 * "/", but arcade-level modules are the stated exception in arcade/games.js:
 * they belong to the origin rather than to any game. A game lifted out of the
 * arcade loses this, which is correct -- it would have no arcade to connect to.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT MONEY. It reads a user-agent string,
 * which is a hint a browser volunteers and can lie about. That is fine for
 * choosing which sentence to show and which button to offer; it would not be
 * fine for anything else, and nothing else asks.
 */

/**
 * iOS, INCLUDING THE IPADS THAT SAY THEY ARE NOT.
 *
 * An iPad reports itself as a Macintosh. A plain /iphone|ipad/ test therefore
 * sends every iPad down the desktop branch, where it gets exactly the dead
 * button this module exists to remove -- and it is the hardest case to notice,
 * because the string looks like a Mac and a Mac is a correct answer for a Mac.
 * maxTouchPoints is what separates them: a real Macintosh reports 0.
 *
 * @returns {boolean}
 */
export function isIOS() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  const ua = String(nav.userAgent ?? '');
  if (/iphone|ipod|ipad/i.test(ua)) return true;
  return /macintosh/i.test(ua) && Number(nav.maxTouchPoints ?? 0) > 1;
}

/** @returns {boolean} */
export function isAndroid() {
  const ua = String(globalThis.navigator?.userAgent ?? '');
  return /android/i.test(ua);
}

/** A phone or a tablet: somewhere an extension cannot exist. @returns {boolean} */
export function isMobile() {
  return isIOS() || isAndroid();
}

/**
 * WHY THERE IS NO WALLET HERE, said truthfully for this device.
 *
 * SHORT, AND IT USED TO BE A PARAGRAPH. The phone message explained what a
 * browser extension is and why one cannot exist on a phone -- a correct and
 * completely unwanted lecture, delivered at the moment somebody was trying to
 * do something. It also arrived AFTER the panel offering a way in, so it was
 * explaining a problem the player had already been handed the fix for.
 *
 * The rule these two lines follow: say what happened, and say the one step
 * that works here. Nothing about mechanism, and nothing at all on a screen
 * where the next control is already visible.
 *
 * @returns {string}
 */
export function noWalletAdvice() {
  // No "install" and no "reload": neither can help on a phone, and being told
  // to install the app you are holding is the bug this module exists to end.
  if (isMobile()) return 'No wallet app found.';
  return 'No wallet found. Install Phantom or Solflare, then reload.';
}
