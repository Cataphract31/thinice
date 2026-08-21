import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NONCE_TTL_MS,
  ResumeLimiter,
  challengeText,
  clientIpOf,
  originAllowed,
  parseOrigins,
  parseTrustedProxies,
  resumeTokenMatches,
  verifySignature,
} from "../src/wire.ts";
import bs58 from "bs58";
import nacl from "tweetnacl";

test("challenge text binds the site when a public origin is configured", () => {
  const bound = challengeText("abcd", "https://thinice.example");
  assert.match(bound, /^THIN ICE login\n/);
  assert.match(bound, /\nsite: https:\/\/thinice\.example\n/);
  assert.match(bound, /\nnonce: abcd$/);
  const bare = challengeText("abcd", "");
  assert.equal(bare, "THIN ICE login\nnonce: abcd");
});

test("a signature verifies only over the exact challenge text and wallet", () => {
  const keys = nacl.sign.keyPair();
  const wallet = bs58.encode(keys.publicKey);
  const text = challengeText("abcd1234", "https://thinice.example");
  const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), keys.secretKey));

  assert.equal(verifySignature(wallet, text, sig.toString("base64")), true);
  assert.equal(
    verifySignature(wallet, challengeText("abcd1234", ""), sig.toString("base64")),
    false,
    "a signature minted for another site's text is no good here",
  );
  assert.equal(verifySignature(wallet, `${text}x`, sig.toString("base64")), false);
  assert.equal(verifySignature(wallet, text, sig.toString("base64").slice(0, -4)), false);
  assert.equal(verifySignature("not-base58!", text, sig.toString("base64")), false);
  assert.equal(verifySignature(wallet, text, "not base64!!!"), false);

  const other = nacl.sign.keyPair();
  assert.equal(
    verifySignature(bs58.encode(other.publicKey), text, sig.toString("base64")),
    false,
    "the wrong wallet's key rejects",
  );
});

test("origin allowlist: empty means anything, set means strict", () => {
  assert.equal(originAllowed(undefined, []), true);
  assert.equal(originAllowed("https://evil.example", []), true);

  const allowed = ["https://thinice.example", "http://localhost:5173"];
  assert.equal(originAllowed("https://thinice.example", allowed), true);
  assert.equal(originAllowed("https://thinice.example/", allowed), true, "trailing slash tolerated");
  assert.equal(originAllowed("http://localhost:5173", allowed), true);
  assert.equal(originAllowed("https://evil.example", allowed), false);
  assert.equal(originAllowed(undefined, allowed), false, "no header, no seat");
  assert.equal(originAllowed("", allowed), false);
});

test("parseOrigins trims, strips slashes, drops empties", () => {
  assert.deepEqual(parseOrigins(" https://a.example/ , https://b.example ,, "), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.deepEqual(parseOrigins(undefined), []);
});

test("client ip: untrusted remotes cannot vote through X-Forwarded-For", () => {
  const trusted = parseTrustedProxies(undefined);
  assert.ok(trusted.has("127.0.0.1"));
  assert.ok(trusted.has("::1"));

  const req = (remote: string, xff?: string) =>
    ({
      socket: { remoteAddress: remote },
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    }) as unknown as Parameters<typeof clientIpOf>[0];

  // Direct hit from the internet: their header is worth nothing.
  assert.equal(clientIpOf(req("203.0.113.7", "9.9.9.9"), trusted), "203.0.113.7");
  assert.equal(clientIpOf(req("203.0.113.7", "1.2.3.4, 5.6.7.8"), trusted), "203.0.113.7");

  // Behind the loopback proxy: walk right-to-left past trusted hops.
  assert.equal(clientIpOf(req("127.0.0.1", "203.0.113.7"), trusted), "203.0.113.7");
  assert.equal(
    clientIpOf(req("127.0.0.1", "9.9.9.9, 203.0.113.7"), trusted),
    "203.0.113.7",
    "spoofed leftmost entries are ignored behind exactly one proxy",
  );
  assert.equal(
    clientIpOf(req("::1", "::ffff:203.0.113.7"), trusted),
    "203.0.113.7",
    "ipv6-mapped ipv4 normalizes",
  );
  assert.equal(
    clientIpOf(req("127.0.0.1", "127.0.0.1, 127.0.0.1"), trusted),
    "127.0.0.1",
    "an all-trusted chain falls back to the socket address",
  );
  assert.equal(clientIpOf(req("127.0.0.1"), trusted), "127.0.0.1", "no header, proxy itself");

  const wider = parseTrustedProxies("10.0.0.1, 127.0.0.1");
  assert.equal(clientIpOf(req("10.0.0.1", "198.51.100.9, 10.0.0.1"), wider), "198.51.100.9");
});

test("resume limiter counts across sockets and resets after the window", () => {
  const limiter = new ResumeLimiter(3, 60_000);
  let now = 1_000_000;
  assert.equal(limiter.may("ip", now), true);
  assert.equal(limiter.may("ip", now + 1), true);
  assert.equal(limiter.may("ip", now + 2), true);
  assert.equal(limiter.may("ip", now + 3), false, "fourth guess inside the window is refused");
  assert.equal(limiter.may("other-ip", now + 3), true, "another ip is its own bucket");
  assert.equal(limiter.may("ip", now + 60_001), true, "the window passes and the bucket clears");
});

test("resume token comparison is exact and length-safe", () => {
  assert.equal(resumeTokenMatches("abc", "abc"), true);
  assert.equal(resumeTokenMatches("abc", "abd"), false);
  assert.equal(resumeTokenMatches("abc", "abcd"), false);
  assert.equal(resumeTokenMatches("", ""), true);
});

test("nonce ttl constant leaves room for a slow wallet prompt", () => {
  assert.equal(NONCE_TTL_MS, 120_000);
});
