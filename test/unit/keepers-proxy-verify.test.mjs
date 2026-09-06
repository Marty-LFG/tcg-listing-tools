// test/unit/keepers-proxy-verify.test.mjs — Shopify App Proxy signature verification.
//
// The construction of the signed string is the half that is easy to get wrong and impossible to debug
// from the outside: every mistake yields a valid-looking 64-character hex digest that simply does not
// match, with no diagnostic from Shopify. So it is tested against Shopify's OWN published worked
// examples rather than against my reading of the prose.
//
// One thing those examples cannot do: serve as golden vectors for the HMAC itself. Their published
// signatures are not reproducible with the documented secret, because the examples carry a redacted
// `{shop}` placeholder — the string that was actually signed is not the string that was printed.
// Verified by computing it; the digests do not match under the documented secret. So the signed-string
// construction is asserted against Shopify, and the crypto is asserted against locally made vectors.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildSignedString, verifyProxySignature, timestampProblem, loggedInCustomerGid, pathPrefixProblem,
} from '../../lib/keepers-proxy-verify.mjs';

const SECRET = 'shpss_' + 'c'.repeat(32);
const signQuery = (qs, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(buildSignedString(qs), 'utf8').digest('hex');
const signed = (qs, secret = SECRET) => `${qs}&signature=${signQuery(qs, secret)}`;

describe("buildSignedString — asserted against Shopify's published worked examples", () => {
  it('matches the documented example WITH a logged-in customer', () => {
    const query = 'extra=1&extra=2&shop={shop}.myshopify.com&logged_in_customer_id=1'
      + '&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555'
      + '&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb';
    assert.equal(
      buildSignedString(query),
      'extra=1,2logged_in_customer_id=1path_prefix=/apps/awesome_reviewsshop={shop}.myshopify.comtimestamp=1317327555',
    );
  });

  it('matches the documented example with NO logged-in customer', () => {
    // The empty value is INCLUDED as `logged_in_customer_id=`, not dropped. Dropping it is the single
    // most natural-looking mistake here and it breaks every signed-out request.
    const query = 'extra=1&extra=2&shop={shop}.myshopify.com&logged_in_customer_id='
      + '&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555'
      + '&signature=e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb';
    assert.equal(
      buildSignedString(query),
      'extra=1,2logged_in_customer_id=path_prefix=/apps/awesome_reviewsshop={shop}.myshopify.comtimestamp=1317327555',
    );
  });

  it('URL-DECODES values before signing', () => {
    // %2F must become / in the signed string. Splitting the raw query string by & and = without
    // decoding is the obvious implementation and it is wrong.
    assert.equal(buildSignedString('path_prefix=%2Fapps%2Fkeepers'), 'path_prefix=/apps/keepers');
  });

  it('joins repeated keys with a comma, in arrival order', () => {
    assert.equal(buildSignedString('a=1&a=2&a=3'), 'a=1,2,3');
  });

  it('uses NO delimiter between pairs', () => {
    // Not '&'. This is the fourth of the four traps and the least visible in a diff.
    assert.equal(buildSignedString('b=2&a=1'), 'a=1b=2');
  });

  it('sorts the assembled pairs, not the arrival order', () => {
    assert.equal(buildSignedString('z=1&a=2&m=3'), 'a=2m=3z=1');
  });

  it('excludes the signature parameter itself', () => {
    assert.equal(buildSignedString('a=1&signature=deadbeef'), 'a=1');
  });

  it('accepts URLSearchParams and plain objects identically to a query string', () => {
    const qs = 'a=1&a=2&b=x';
    assert.equal(buildSignedString(new URLSearchParams(qs)), buildSignedString(qs));
    assert.equal(buildSignedString({ a: ['1', '2'], b: 'x' }), buildSignedString(qs));
  });

  it('includes undocumented parameters rather than filtering to a known list', () => {
    // Shopify explicitly warns not to assume the documented parameters are the only ones. An allowlist
    // would break the day they add one, and break as an unexplainable signature mismatch.
    assert.equal(buildSignedString('shop=x&brand_new_param=7'), 'brand_new_param=7shop=x');
  });
});

describe('verifyProxySignature', () => {
  const base = 'shop=gkrnva-1k.myshopify.com&path_prefix=%2Fapps%2Fkeepers'
    + '&logged_in_customer_id=8675309&timestamp=1789000000';

  it('accepts a genuine signature', () => {
    assert.deepEqual(verifyProxySignature(SECRET, signed(base)), { ok: true, reason: null });
  });

  it('rejects a tampered parameter', () => {
    const good = signQuery(base);
    const swapped = base.replace('8675309', '1111111');
    assert.equal(verifyProxySignature(SECRET, `${swapped}&signature=${good}`).reason, 'signature_mismatch');
  });

  it('rejects a signature made with another secret', () => {
    const other = signed(base, 'shpss_' + 'd'.repeat(32));
    assert.equal(verifyProxySignature(SECRET, other).reason, 'signature_mismatch');
  });

  it('fails closed on missing, non-hex and wrong-length signatures', () => {
    assert.equal(verifyProxySignature(SECRET, base).reason, 'no_signature');
    assert.equal(verifyProxySignature(SECRET, `${base}&signature=nothex!!`).reason, 'signature_not_hex');
    // Short-but-valid hex must be caught before timingSafeEqual, which throws on unequal lengths.
    assert.equal(verifyProxySignature(SECRET, `${base}&signature=abcdef`).reason, 'signature_not_hex');
    assert.equal(verifyProxySignature('', signed(base)).reason, 'secret_unusable');
    assert.equal(verifyProxySignature(SECRET, `signature=${'a'.repeat(64)}`).reason, 'no_parameters');
  });

  it('never throws, whatever it is handed', () => {
    for (const q of [undefined, null, '', '?', '&&&', 'a', {}, [], 'x'.repeat(20000)]) {
      assert.doesNotThrow(() => verifyProxySignature(SECRET, q), JSON.stringify(q));
      assert.equal(verifyProxySignature(SECRET, q).ok, false);
    }
  });
});

describe('timestampProblem — the docs describe NO replay protection, so this is it', () => {
  const now = 1789000000000; // ms

  it('accepts a fresh timestamp', () => {
    assert.equal(timestampProblem('1789000000', { nowMs: now }), null);
    assert.equal(timestampProblem('1788999950', { nowMs: now }), null);
  });

  it('rejects a stale one, and says by how much', () => {
    // A captured check-in URL is valid forever without this. Idempotency in the database stops the
    // same customer checking in twice; only freshness stops last month's URL working at all.
    assert.match(timestampProblem('1788999000', { nowMs: now }), /stale by/);
  });

  it('tolerates a little clock skew but not a lot', () => {
    // Without a future tolerance, a server running seconds slow rejects everything and looks exactly
    // like a wrong secret — which sends the next person debugging in entirely the wrong direction.
    assert.equal(timestampProblem('1789000030', { nowMs: now }), null);
    assert.match(timestampProblem('1789999999', { nowMs: now }), /in the future/);
  });

  it('rejects missing and non-integer timestamps', () => {
    assert.match(timestampProblem('', { nowMs: now }), /no timestamp/);
    assert.match(timestampProblem(undefined, { nowMs: now }), /no timestamp/);
    assert.match(timestampProblem('2026-09-06', { nowMs: now }), /not an integer/);
    assert.match(timestampProblem('1789000000.5', { nowMs: now }), /not an integer/);
  });

  it('honours a caller-supplied window', () => {
    assert.equal(timestampProblem('1788999000', { nowMs: now, maxAgeSec: 3600 }), null);
  });
});

describe('loggedInCustomerGid — the identity signal, and the one under investigation', () => {
  it('returns a GID for a numeric id', () => {
    assert.equal(
      loggedInCustomerGid('logged_in_customer_id=8675309&shop=x'),
      'gid://shopify/Customer/8675309',
    );
  });

  it('returns null when empty, absent or non-numeric — never a guess', () => {
    // Empty is the documented signed-out case AND the symptom of the open Shopify investigation into
    // this going empty for genuinely logged-in customers on new customer accounts. Both must land on
    // "refuse and ask them to tap again", never on a fallback.
    assert.equal(loggedInCustomerGid('logged_in_customer_id=&shop=x'), null);
    assert.equal(loggedInCustomerGid('shop=x'), null);
    assert.equal(loggedInCustomerGid('logged_in_customer_id=abc'), null);
    assert.equal(loggedInCustomerGid('logged_in_customer_id=12x'), null);
    assert.equal(loggedInCustomerGid(undefined), null);
  });
});

describe('pathPrefixProblem — diagnosis only, must never gate the request', () => {
  it('is silent on a match and describes a mismatch', () => {
    assert.equal(pathPrefixProblem('path_prefix=%2Fapps%2Fkeepers', '/apps/keepers'), null);
    assert.match(pathPrefixProblem('path_prefix=%2Fapps%2Frenamed', '/apps/keepers'), /renamed/);
  });

  it('is silent when either side is unknown', () => {
    // A merchant renaming the subpath is legitimate and takes effect immediately on their store while
    // the app config keeps the old value. Gating on this would take the check-in offline with a
    // signature that verified perfectly.
    assert.equal(pathPrefixProblem('shop=x', '/apps/keepers'), null);
    assert.equal(pathPrefixProblem('path_prefix=%2Fapps%2Fkeepers', ''), null);
  });
});
