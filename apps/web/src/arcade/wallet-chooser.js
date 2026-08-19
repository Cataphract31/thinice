/*
 * WHICH WALLET, ASKED ONCE.
 *
 * A phone browser cannot hold a wallet extension, so on a phone the arcade
 * reaches a wallet by opening it -- and it has to know which one. That is the
 * only question this panel exists to ask, and it asks it once: the answer is
 * remembered, so the next press of CONNECT goes straight to the wallet with no
 * panel at all.
 *
 * -- IT IS A LIST OF LINKS, AND EACH ONE IS THE REAL THING ----------------
 *
 * Not buttons that navigate. A phone treats a tapped <a> as a user-initiated
 * navigation to another app, which is exactly what is wanted; a button calling
 * location.assign() is the same URL through a path Safari is entitled to
 * block, and it loses long-press, "open in new tab", and the address preview a
 * careful person uses to check where a link goes before touching it. On the
 * screen that hands a wallet over, that preview is worth keeping.
 *
 * The hrefs are built by the caller -- arcade/web/wallet.js -- because what a
 * link should do differs:
 *
 *   CONNECT   an encrypted deeplink into the wallet, which comes back here
 *             connected. The ordinary route, and the only one that leaves the
 *             player signed in to THIS browser. See arcade/web/deeplink.js.
 *   BROWSE    open the arcade inside the wallet's own browser. The fallback
 *             for a browser that cannot keep state across the trip, and the
 *             only route there is for a wallet that publishes no protocol.
 *
 * Both can be on screen at once: `links` first, then `more` under a line that
 * says what is different about them. Three wallets do the good route; every
 * other wallet on Solana does not, and leaving them off the panel entirely
 * reads to their owner as "this site does not support my wallet".
 *
 * This file draws whatever it is given and reports which was tapped. It knows
 * nothing about either protocol, which is why there is only one panel.
 *
 * -- WHAT IS DELIBERATELY NOT HERE ----------------------------------------
 *
 * NO AUTO-REDIRECT. Not on load, not on a timer, not "helpfully" when only one
 * wallet is offered. Sending somebody into another app without asking is
 * hostile, and Safari blocks navigations that did not come from a gesture
 * anyway -- so it would fail silently on the platform it was aimed at.
 *
 * NO DETECTION OF WHICH WALLETS ARE INSTALLED. Not possible from a web page,
 * and every trick that claims to be -- timing a hidden iframe, racing a blur
 * event -- is unreliable and reads as fingerprinting.
 *
 * NO EXPLANATIONS. The one line of copy says what tapping does. An earlier
 * version opened by teaching the reader what a browser extension is, which is
 * a lecture delivered to somebody who was trying to do something.
 */

/*
 * The same three-layer tokens as the bank, and for the same reason: this can
 * open over an OSRS table, over Thin Line's Warcraft gold, or over a room that
 * publishes nothing at all, and it has to be readable before a fetched palette
 * lands. The literals are the measured ones from arcade/web/bank.js.
 */
const css = `
/* Every box measured including its own padding. Without this the wallet
   buttons are 100% wide PLUS 32px of padding and hang off the right edge of
   the panel -- which on the screen that hands a wallet over reads as broken. */
.zinc-wallets, .zinc-wallets * { box-sizing: border-box; }
.zinc-wallets {
  --fill: var(--bank-fill, #3a332a);
  --frame: var(--bank-frame, #474032);
  --rim: var(--bank-rim, var(--osrs-rim, #77705f));
  --edge: var(--bank-edge, var(--osrs-inner-dark, #312a1b));
  --text: var(--bank-text, var(--osrs-text, #fff));
  --dim: var(--bank-dim, #c1b8a9);
  --accent: var(--bank-accent, var(--osrs-orange, #ff981f));
  --hi: var(--bank-hi, var(--osrs-yellow, #ff0));
  --body-font: var(--bank-font, 'osrs-12', 'Courier New', monospace);
  --display-font: var(--bank-font-display, 'osrs-bold-12', 'Courier New', monospace);

  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(0, 0, 0, 0.78);
  display: flex;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 16px;
  font-family: var(--body-font);
  font-size: 16px;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.zinc-wallets__panel {
  margin: auto;
  width: 420px;
  max-width: 100%;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--fill);
  border: 1px solid #000;
  box-shadow: inset 0 0 0 1px var(--rim), 0 10px 44px rgba(0, 0, 0, 0.65);
}
.zinc-wallets__bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 10px 9px 14px;
  background: var(--frame);
  border-bottom: 1px solid var(--edge);
}
.zinc-wallets__title {
  font-family: var(--display-font);
  color: var(--accent);
  text-shadow: 1px 1px 0 #000;
  font-size: 19px;
  letter-spacing: 0.06em;
}
.zinc-wallets__x {
  background: none;
  border: 0;
  color: var(--dim);
  font: inherit;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 10px;
  min-width: 44px;
  min-height: 44px;
}
.zinc-wallets__x:hover { color: var(--hi); }
.zinc-wallets__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 14px;
  padding-bottom: max(14px, env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.zinc-wallets__lede { margin: 0; line-height: 1.5; font-size: 15px; }
.zinc-wallets__app {
  display: block;
  width: 100%;
  padding: 16px;
  font-family: var(--display-font);
  font-size: 18px;
  letter-spacing: 0.05em;
  text-align: left;
  color: var(--accent);
  text-shadow: 1px 1px 0 #000;
  background: var(--frame);
  border: 1px solid #000;
  box-shadow: inset 0 0 0 1px var(--rim);
  cursor: pointer;
  text-decoration: none;
}
.zinc-wallets__app:hover { color: var(--hi); }
.zinc-wallets__app:active { box-shadow: inset 0 0 0 1px #000; }
.zinc-wallets__note {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--dim);
  border-top: 1px solid var(--edge);
  padding-top: 12px;
}
/* The second group. Same target size -- these are still one-tap buttons on a
   phone -- and a quieter colour, because they are the worse route and saying
   so in the styling costs nothing. */
.zinc-wallets__sep {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--dim);
  border-top: 1px solid var(--edge);
  padding-top: 14px;
}
.zinc-wallets__app--other { color: var(--text); }
.zinc-wallets__app--other:hover { color: var(--hi); }
@media (max-width: 560px) {
  .zinc-wallets { padding: 0; }
  .zinc-wallets__panel {
    width: 100%;
    margin: auto 0 0;
    max-height: 92vh;
    max-height: 92dvh;
    border-left: 0;
    border-right: 0;
    border-bottom: 0;
  }
}
`;

let open = null;

/**
 * Offer the wallets, and resolve once one has been tapped or the panel closed.
 *
 * Resolves rather than throws in both outcomes, because neither is an error
 * and the caller's next step differs: a tap means this page is about to be
 * replaced by the wallet, and there is nothing more to do here; a dismissal
 * means carry on signed out.
 *
 * @param {object} options
 * @param {{id: string, name: string, href: string}[]} options.links what to offer
 * @param {(id: string) => void} [options.onPick] run on the tap, BEFORE the
 *   browser follows the link -- which is the only moment left to record
 *   anything, and is why it must be synchronous
 * @param {string} [options.lede] one line saying what tapping does
 * @param {string} [options.note] one line of small print, or nothing
 * @returns {Promise<{chosen: string|null}>}
 */
export function chooseWallet({ links = [], more, onPick, lede, note } = {}) {
  if (open) return open.promise;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'zinc-wallets';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Choose a wallet');

  const panel = document.createElement('section');
  panel.className = 'zinc-wallets__panel';
  backdrop.appendChild(panel);

  const bar = document.createElement('div');
  bar.className = 'zinc-wallets__bar';
  const title = document.createElement('span');
  title.className = 'zinc-wallets__title';
  title.textContent = 'YOUR WALLET';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'zinc-wallets__x';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  bar.append(title, close);
  panel.appendChild(bar);

  const body = document.createElement('div');
  body.className = 'zinc-wallets__body';
  panel.appendChild(body);

  const line = document.createElement('p');
  line.className = 'zinc-wallets__lede';
  line.textContent = lede ?? 'Tap yours. It opens, you approve, you come back.';
  body.appendChild(line);

  let chosen = null;
  let settle = () => {};
  const promise = new Promise((resolve) => {
    settle = () => { resolve({ chosen }); };
  });

  /**
   * One wallet, one real link.
   *
   * `pick` differs between the groups and that is the whole reason there are
   * two: the first group is remembered, so the next press of CONNECT goes
   * straight to that wallet. Remembering a wallet from the second group would
   * remember an id the connect route has never heard of, and the next press
   * would go nowhere.
   */
  const offer = (app, extra, pick) => {
    const link = document.createElement('a');
    link.className = `zinc-wallets__app${extra}`;
    link.textContent = app.name;
    link.href = app.href;
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', () => {
      chosen = app.id;
      // Synchronous, and it has to be: the browser follows the link straight
      // after this handler and whatever was not written by then is lost.
      try { pick?.(app.id); } catch { /* the navigation still happens */ }
      // The panel is left standing on purpose. The wallet may take a moment to
      // come up, and a panel that vanished first would leave a Connect button
      // behind that looks like nothing happened.
      settle();
    });
    body.appendChild(link);
  };

  for (const app of links) offer(app, '', onPick);

  /*
   * THE SECOND GROUP IS BELOW A LINE THAT SAYS WHAT IS DIFFERENT ABOUT IT.
   * These wallets publish no protocol that can answer back, so the only thing
   * their link can do is reopen the arcade inside the wallet -- where the
   * session lives in the wallet's cookie jar and does not follow anybody back
   * to this browser. That is worth one line above the buttons rather than a
   * discovery afterwards.
   */
  if (more?.links?.length) {
    const sep = document.createElement('p');
    sep.className = 'zinc-wallets__sep';
    sep.textContent = more.lede ?? 'Other wallets open the arcade inside themselves.';
    body.appendChild(sep);
    for (const app of more.links) offer(app, ' zinc-wallets__app--other', more.onPick);
  }

  if (note) {
    const small = document.createElement('p');
    small.className = 'zinc-wallets__note';
    small.textContent = note;
    body.appendChild(small);
  }

  function dismiss() {
    if (!open) return;
    backdrop.remove();
    style.remove();
    document.removeEventListener('keydown', onKey);
    open = null;
    settle();
  }
  function onKey(e) { if (e.key === 'Escape') dismiss(); }

  close.addEventListener('click', dismiss);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dismiss(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);

  open = { promise, dismiss };
  return promise;
}

/** Take the panel down, if it is up. For a caller that has moved on. */
export function closeChooser() {
  open?.dismiss();
}
