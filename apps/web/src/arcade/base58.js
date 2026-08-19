/*
 * BASE58: THE ALPHABET SOLANA WRITES EVERYTHING IN.
 *
 * Addresses, signatures, transactions, and -- the reason this file has a
 * decoder -- every field of a wallet deeplink. Phantom and Solflare hand back
 * their encryption key, their nonce and their encrypted payload as base58 text
 * in a query string, so a browser that cannot read base58 cannot complete a
 * connection on a phone at all.
 *
 * -- WHY THERE IS A DECODER, HAVING ONCE ARGUED THERE SHOULD NOT BE -------
 *
 * The first version of this file encoded only, and said so at length: a
 * decoder is the tool for turning a string back into transaction bytes, and
 * the rule this arcade keeps -- argued out in tools/signer-core.mjs and again
 * in arcade/money/custody.js -- is that the bytes which move money have ONE
 * implementation, on the server.
 *
 * That rule has not changed and this does not bend it. What changed is the
 * phone route: it is an encrypted deeplink protocol now, and base58 is its
 * TRANSPORT. The ciphertext, the nonce and the wallet's encryption key all
 * arrive as base58 in a URL and not one of them is a transaction. The browser
 * still composes nothing -- it hands the box's own bytes to a wallet and hands
 * the wallet's answer straight back to the box.
 *
 * The line that matters was never "can this file decode". It is whether
 * anything in the browser BUILDS a transfer. Nothing does, and
 * test/deeplink.test.js keeps checking that nothing has started.
 *
 * -- WHAT IS STILL TRUE ---------------------------------------------------
 *
 * NOTHING HERE IS TRUSTED BY ANYTHING. A string this encodes goes into an
 * explorer link; bytes this decodes go straight into an authenticated cipher
 * that rejects anything tampered with, or to the box, which checks that what
 * it is being asked to broadcast is a transaction it built itself. So the
 * worst a bug in this file can do is fail loudly. That is why it is schoolbook
 * long division rather than a dependency.
 *
 * The alphabet is Bitcoin's, which is the one Solana uses: 0, O, I and l are
 * absent so that no two characters can be confused by a person reading an
 * address out loud.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58 of some bytes.
 *
 * LEADING ZEROS ARE COUNTED SEPARATELY, and this is the classic bug. Base58 is
 * a pure number, and a number does not remember how many zeros were in front
 * of it -- so a payload beginning 0x00 would encode to the same string as the
 * same payload without it. Bitcoin's convention, which Solana inherits, is one
 * literal '1' per leading zero byte, prepended after the arithmetic. Payloads
 * beginning with a zero byte are ordinary (one in 256), so a version of this
 * without the first loop would be wrong about one string in every few hundred
 * and right about all the rest, which is the hardest kind of wrong to notice.
 *
 * @param {Uint8Array|number[]} bytes
 * @returns {string}
 */
export function base58Encode(bytes) {
  const input = Uint8Array.from(bytes ?? []);
  if (input.length === 0) return '';

  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;

  /*
   * Long division by 58 over the whole array, repeatedly, taking the remainder
   * each time. Big-endian digits are pushed and reversed at the end. The
   * inputs here are a signature or a transaction, this runs once per wallet
   * round trip, and obviously correct beats fast on a function whose failure
   * mode is a wrong string nobody can debug.
   */
  const digits = [];
  const work = input.slice();
  let start = zeros;
  while (start < work.length) {
    let carry = 0;
    for (let i = start; i < work.length; i += 1) {
      const value = (carry << 8) + work[i];
      work[i] = Math.floor(value / 58);
      carry = value % 58;
    }
    digits.push(ALPHABET[carry]);
    while (start < work.length && work[start] === 0) start += 1;
  }

  return '1'.repeat(zeros) + digits.reverse().join('');
}

/**
 * Bytes from base58, or null if that is not base58.
 *
 * NULL RATHER THAN A THROW, because every caller is reading a value out of a
 * URL -- which a person can edit, an app can truncate, and a messaging client
 * can mangle on the way through. A bad character there is an ordinary event
 * with an ordinary answer ("that reply is not usable"), and making four call
 * sites wrap this in a try to say so would be four chances to forget.
 *
 * BOUNDED, and not fastidiously. The algorithm is quadratic in the length of
 * its input: fine for the 44-character keys and 300-character transactions
 * this actually sees, and a denial of service if a hostile link hands it a
 * megabyte. chain.js's decoder makes the same choice with a much tighter limit
 * because on the server nothing legitimate is longer than a signature; here a
 * signed transaction is the largest real input, so the ceiling sits well above
 * one and well below anything expensive.
 *
 * @param {string} text
 * @returns {Uint8Array|null}
 */
export function base58Decode(text) {
  const input = String(text ?? '');
  if (input.length === 0 || input.length > 4096) return null;

  const bytes = [];
  for (const ch of input) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // The mirror of the encoder's leading-zero pass, and wrong in the same way
  // if it goes missing: '1' is the digit zero, so a payload that began with a
  // zero byte would come back one byte short, with nothing anywhere to say so.
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) bytes.push(0);

  return Uint8Array.from(bytes.reverse());
}
