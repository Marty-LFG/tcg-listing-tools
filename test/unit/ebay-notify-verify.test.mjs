// test/unit/ebay-notify-verify.test.mjs — the crypto half of eBay push notifications.
//
// Offline and deterministic: signatures are made with a keypair generated right here, so nothing
// depends on eBay being reachable, on which digest eBay currently signs with, or on having captured a
// real notification yet.
//
// The two things worth testing hardest are the two that fail silently in production:
//   - challenge ordering, where a wrong order produces a legitimate-looking hash eBay just rejects;
//   - fail-closed behaviour, where a mistake means an open endpoint rather than a broken one.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  computeChallengeResponse, verificationTokenProblem, parseSignatureHeader, toPem,
  verifyNotification, keyCacheStats, __resetKeyCache,
} from '../../lib/ebay-notify-verify.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const BARE = PEM.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');

const sign = (body, hash = 'sha1') =>
  crypto.sign(hash, Buffer.from(body), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
const header = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const keyFor = (digest = 'SHA1') => async () => ({ pem: PEM, algorithm: 'ECDSA', digest });

beforeEach(() => __resetKeyCache());

describe('computeChallengeResponse — the order of the three inputs is the whole thing', () => {
  const code = 'abc123', token = 'tok-'.padEnd(40, 'x'), endpoint = 'https://x.example/ebay/notifications';

  it('is sha256(challengeCode + verificationToken + endpoint), in that order', () => {
    const expected = crypto.createHash('sha256').update(code).update(token).update(endpoint).digest('hex');
    assert.equal(computeChallengeResponse(code, token, endpoint), expected);
  });

  it('every other ordering produces a DIFFERENT hash', () => {
    // This is the regression that matters: all six orderings are valid-looking hex, and only one is
    // accepted. Nothing downstream can tell you which you produced.
    const right = computeChallengeResponse(code, token, endpoint);
    const others = [
      [code, endpoint, token], [token, code, endpoint], [token, endpoint, code],
      [endpoint, code, token], [endpoint, token, code],
    ];
    for (const [a, b, c] of others) {
      assert.notEqual(computeChallengeResponse(a, b, c), right, `ordering ${a}|${b}|${c} must not collide`);
    }
  });

  it('is sensitive to the endpoint exactly as registered', () => {
    const base = computeChallengeResponse(code, token, endpoint);
    assert.notEqual(computeChallengeResponse(code, token, endpoint + '/'), base, 'a trailing slash is a different endpoint');
    assert.notEqual(computeChallengeResponse(code, token, endpoint.replace('https', 'http')), base, 'scheme counts');
    assert.notEqual(computeChallengeResponse(code, token, endpoint.toUpperCase()), base, 'case counts');
  });

  it('produces plain hex — the response is JSON-serialised, never concatenated', () => {
    assert.match(computeChallengeResponse(code, token, endpoint), /^[0-9a-f]{64}$/);
  });
});

describe('verificationTokenProblem — refuse a bad token at startup, not at handshake time', () => {
  it('accepts a token in eBay’s documented shape', () => {
    assert.equal(verificationTokenProblem('a'.repeat(32)), null);
    assert.equal(verificationTokenProblem('A-Za-z0-9_-'.repeat(6).slice(0, 60)), null);
  });
  it('rejects too short, too long, and illegal characters', () => {
    assert.ok(verificationTokenProblem('a'.repeat(31)), 'under 32');
    assert.ok(verificationTokenProblem('a'.repeat(81)), 'over 80');
    assert.ok(verificationTokenProblem('a'.repeat(20) + '!!' + 'a'.repeat(20)), 'punctuation');
    assert.ok(verificationTokenProblem('a'.repeat(20) + '  ' + 'a'.repeat(20)), 'whitespace');
  });
  it('says something useful when it is simply unset', () => {
    assert.equal(verificationTokenProblem(''), 'not set');
    assert.equal(verificationTokenProblem(null), 'not set');
  });
});

describe('parseSignatureHeader — parsing attacker-controlled input', () => {
  it('reads kid and signature out of the base64 JSON', () => {
    const h = parseSignatureHeader(header({ alg: 'ecdsa', kid: 'k1', signature: 'sig', digest: 'SHA1' }));
    assert.deepEqual(h, { kid: 'k1', signature: 'sig', alg: 'ecdsa', digest: 'SHA1' });
  });
  it('returns null rather than throwing on anything malformed', () => {
    for (const bad of [null, undefined, '', 'not-base64!!', Buffer.from('not json').toString('base64'),
      header({ kid: 'k1' }), header({ signature: 's' }), header([1, 2, 3]), header('a string')]) {
      assert.equal(parseSignatureHeader(bad), null, `input ${String(bad).slice(0, 24)}`);
    }
  });
});

describe('toPem — eBay hands back bare base64', () => {
  it('wraps bare base64 into real PEM', () => {
    const pem = toPem(BARE);
    assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.match(pem, /\n-----END PUBLIC KEY-----\n$/);
    assert.ok(pem.split('\n').slice(1, -2).every((l) => l.length <= 64), 'body wrapped at 64 cols');
    assert.doesNotThrow(() => crypto.createPublicKey(pem), 'node must accept the result');
  });
  it('is idempotent when the markers are already there', () => {
    assert.doesNotThrow(() => crypto.createPublicKey(toPem(PEM)));
    assert.doesNotThrow(() => crypto.createPublicKey(toPem(PEM.replace(/\n/g, ''))), 'markers but no newlines');
  });
  it('null for unusable input', () => {
    assert.equal(toPem(''), null);
    assert.equal(toPem(null), null);
    assert.equal(toPem('-----BEGIN PUBLIC KEY----------END PUBLIC KEY-----'), null);
  });
});

describe('verifyNotification — fails closed, always', () => {
  const body = Buffer.from(JSON.stringify({ metadata: { topic: 'ORDER_CONFIRMATION' }, notification: { notificationId: 'n1' } }));

  it('accepts a genuine signature over the raw bytes', async () => {
    const h = header({ alg: 'ecdsa', kid: 'k1', signature: sign(body), digest: 'SHA1' });
    const r = await verifyNotification({}, h, body, { fetchKey: keyFor() });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.kid, 'k1');
  });

  it('rejects a body altered by a single byte', async () => {
    const h = header({ alg: 'ecdsa', kid: 'k1', signature: sign(body), digest: 'SHA1' });
    const tampered = Buffer.from(body); tampered[tampered.length - 3] ^= 0x01;
    const r = await verifyNotification({}, h, tampered, { fetchKey: keyFor() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  });

  it('rejects a signature made by a different key', async () => {
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sig = crypto.sign('sha1', body, { key: other.privateKey, dsaEncoding: 'der' }).toString('base64');
    const r = await verifyNotification({}, header({ kid: 'k1', signature: sig }), body, { fetchKey: keyFor() });
    assert.equal(r.ok, false);
  });

  it('follows the digest field rather than assuming SHA1', async () => {
    const h = header({ alg: 'ecdsa', kid: 'k1', signature: sign(body, 'sha256'), digest: 'SHA256' });
    assert.equal((await verifyNotification({}, h, body, { fetchKey: keyFor('SHA256') })).ok, true);
    // ...and the same payload signed with the other hash must NOT pass.
    const mismatched = header({ alg: 'ecdsa', kid: 'k1', signature: sign(body, 'sha256'), digest: 'SHA1' });
    assert.equal((await verifyNotification({}, mismatched, body, { fetchKey: keyFor() })).ok, false);
  });

  it('refuses loudly on a digest it does not know, instead of guessing', async () => {
    const h = header({ kid: 'k1', signature: sign(body), digest: 'MD5' });
    const r = await verifyNotification({}, h, body, { fetchKey: keyFor('MD5') });
    assert.equal(r.ok, false);
    assert.match(r.reason, /unsupported signature digest/);
  });

  it('refuses when there is no header, no body, or no key', async () => {
    const h = header({ kid: 'k1', signature: sign(body) });
    assert.equal((await verifyNotification({}, null, body, { fetchKey: keyFor() })).reason, 'bad_header');
    assert.equal((await verifyNotification({}, h, Buffer.alloc(0), { fetchKey: keyFor() })).reason, 'empty_body');
    assert.equal((await verifyNotification({}, h, body, { fetchKey: async () => null })).reason, 'no_key');
  });

  it('a throwing key fetch is a refusal, not an exception escaping into the request', async () => {
    const h = header({ kid: 'k1', signature: sign(body) });
    const r = await verifyNotification({}, h, body, { fetchKey: async () => { throw new Error('network down'); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /key_fetch_failed/);
  });

  it('a garbage signature throws inside OpenSSL and still comes back as a refusal', async () => {
    const h = header({ kid: 'k1', signature: 'bm90LWEtc2lnbmF0dXJl' });
    const r = await verifyNotification({}, h, body, { fetchKey: keyFor() });
    assert.equal(r.ok, false);
  });

  it('exposes cache counters for /api/status', () => {
    const s = keyCacheStats();
    assert.deepEqual(Object.keys(s).sort(), ['cached', 'fetches_this_hour', 'negative']);
  });
});
