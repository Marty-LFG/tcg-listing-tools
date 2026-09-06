// test/unit/shopify-hooks-verify.test.mjs — Shopify webhook HMAC verification.
//
// Offline and deterministic: signatures are computed here with a known secret, so nothing depends on
// having captured a real webhook or on Shopify being reachable.
//
// The things worth testing hardest are the ones that fail SILENTLY in production:
//   - fail-closed behaviour, where a mistake leaves an open endpoint rather than a broken one;
//   - never throwing, because every input is attacker-controlled and a throw is a 500 with a stack
//     trace where a 401 belonged;
//   - the shop-domain check, which is the difference between our ledger and a stranger's orders.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyWebhookHmac, secretProblem, readWebhookHeaders, shopDomainProblem, HMAC_HEADER,
} from '../../lib/shopify-hooks-verify.mjs';

const SECRET = 'shpss_' + 'a'.repeat(32);
const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');

describe('secretProblem — arm-time, so a bad secret is a refusal to start', () => {
  it('accepts a plausible secret', () => {
    assert.equal(secretProblem(SECRET), null);
  });

  it('rejects missing, whitespace-bearing and implausibly short secrets', () => {
    assert.match(secretProblem(''), /not set/);
    assert.match(secretProblem(undefined), /not set/);
    // The realistic version of this: a .env value that picked up a trailing newline or a quote.
    assert.match(secretProblem('abcdefghijklmnop\n'), /whitespace/);
    // And the realistic version of THAT: someone pasted the client id, which is shorter.
    assert.match(secretProblem('short'), /implausibly short/);
  });
});

describe('verifyWebhookHmac', () => {
  const body = JSON.stringify({ id: 12345, total_price: '74.00' });

  it('accepts a genuine signature over the exact bytes', () => {
    assert.deepEqual(verifyWebhookHmac(SECRET, body, sign(body)), { ok: true, reason: null });
  });

  it('accepts a Buffer body identically to the equivalent string', () => {
    assert.equal(verifyWebhookHmac(SECRET, Buffer.from(body, 'utf8'), sign(body)).ok, true);
  });

  it('REJECTS a body that has been round-tripped through JSON', () => {
    // The single most likely way to break this in production: parsing the body before verifying, then
    // re-stringifying it. The parsed data is identical and the bytes are not, so the signature fails
    // and anyone who hits it will be certain their secret is wrong.
    //
    // Note the payload has to carry insignificant whitespace for this to bite — JSON.stringify
    // preserves the insertion order of string keys, so a compact body often survives the round trip
    // byte-for-byte. That is what makes this bug intermittent, and intermittent is worse: it works in
    // testing against Shopify's compact payloads and fails the day something pretty-prints.
    const wire = '{ "id": 12345,  "total_price": "74.00" }';
    const reserialized = JSON.stringify(JSON.parse(wire));
    assert.notEqual(reserialized, wire, 'this fixture must actually change under a round trip');
    assert.equal(verifyWebhookHmac(SECRET, reserialized, sign(wire)).ok, false);
    // ...and the same bytes verify fine, proving the signature itself was good.
    assert.equal(verifyWebhookHmac(SECRET, wire, sign(wire)).ok, true);
  });

  it('rejects a tampered body', () => {
    const tampered = JSON.stringify({ id: 12345, total_price: '7400.00' });
    assert.deepEqual(verifyWebhookHmac(SECRET, tampered, sign(body)),
      { ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const other = sign(body, 'shpss_' + 'b'.repeat(32));
    assert.equal(verifyWebhookHmac(SECRET, body, other).reason, 'signature_mismatch');
  });

  it('fails closed on every missing or malformed input, and names which', () => {
    assert.equal(verifyWebhookHmac(SECRET, body, '').reason, 'no_signature');
    assert.equal(verifyWebhookHmac(SECRET, body, null).reason, 'no_signature');
    assert.equal(verifyWebhookHmac(SECRET, '', sign('')).reason, 'empty_body');
    assert.equal(verifyWebhookHmac(SECRET, null, sign(body)).reason, 'no_body');
    assert.equal(verifyWebhookHmac('', body, sign(body)).reason, 'secret_unusable');
    // A short signature must not reach timingSafeEqual, which throws on a length mismatch — that would
    // turn a malformed request into a 500 and, worse, into a timing signal.
    assert.equal(verifyWebhookHmac(SECRET, body, 'AAAA').reason, 'signature_wrong_length');
  });

  it('never throws, whatever it is handed', () => {
    const junk = [undefined, null, 0, '', ' ', '!!!not base64!!!', 'x'.repeat(10000), {}, []];
    for (const h of junk) {
      assert.doesNotThrow(() => verifyWebhookHmac(SECRET, body, h), `header ${JSON.stringify(h)}`);
      assert.equal(verifyWebhookHmac(SECRET, body, h).ok, false);
    }
    for (const b of junk) {
      assert.doesNotThrow(() => verifyWebhookHmac(SECRET, b, sign(body)), `body ${JSON.stringify(b)}`);
    }
  });
});

describe('readWebhookHeaders', () => {
  it('reads the five headers the ingest path reasons about', () => {
    const got = readWebhookHeaders({
      'x-shopify-webhook-id': 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043',
      'x-shopify-topic': 'orders/paid',
      'x-shopify-shop-domain': 'gkrnva-1k.myshopify.com',
      'x-shopify-triggered-at': '2026-09-06T01:02:03.000Z',
      'x-shopify-api-version': '2026-07',
      [HMAC_HEADER]: 'sig',
    });
    assert.equal(got.webhookId, 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043');
    assert.equal(got.topic, 'orders/paid');
    assert.equal(got.shopDomain, 'gkrnva-1k.myshopify.com');
    assert.equal(got.triggeredAt, '2026-09-06T01:02:03.000Z');
    assert.equal(got.apiVersion, '2026-07');
    assert.equal(got.hmac, 'sig');
  });

  it('returns null rather than empty strings, and survives an absent header bag', () => {
    const got = readWebhookHeaders({ 'x-shopify-topic': '   ' });
    assert.equal(got.topic, null);
    assert.equal(got.webhookId, null);
    assert.doesNotThrow(() => readWebhookHeaders(undefined));
    assert.equal(readWebhookHeaders(undefined).topic, null);
  });

  it('takes the first value when a header arrives more than once', () => {
    assert.equal(readWebhookHeaders({ 'x-shopify-topic': ['orders/paid', 'orders/updated'] }).topic, 'orders/paid');
  });
});

describe('shopDomainProblem — a valid signature is not proof it is OUR shop', () => {
  it('accepts the configured shop, with or without the suffix on either side', () => {
    assert.equal(shopDomainProblem('gkrnva-1k.myshopify.com', 'gkrnva-1k'), null);
    assert.equal(shopDomainProblem('gkrnva-1k', 'gkrnva-1k.myshopify.com'), null);
    assert.equal(shopDomainProblem('GKRNVA-1K.myshopify.com', 'gkrnva-1k'), null);
  });

  it('rejects a different shop the app also happens to be installed on', () => {
    // Same app, same client secret, so the HMAC verifies perfectly. Only this check stops a stranger's
    // orders being ingested as ours.
    assert.match(shopDomainProblem('someone-else.myshopify.com', 'gkrnva-1k'), /is not/);
  });

  it('fails closed when either side is missing', () => {
    assert.match(shopDomainProblem('', 'gkrnva-1k'), /no shop domain/);
    assert.match(shopDomainProblem('gkrnva-1k', ''), /no expected shop/);
  });
});
