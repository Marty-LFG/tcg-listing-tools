// test/unit/bricklink.test.mjs — BrickLink OAuth1 signing (lib/bricklink.mjs). No network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pctEncode, oauthBaseString, bricklinkAuthHeader } from '../../lib/bricklink.mjs';

describe('pctEncode', () => {
  it('encodes the OAuth-reserved extras and space/=; passes unreserved through', () => {
    assert.equal(pctEncode("!*'()"), '%21%2A%27%28%29');
    assert.equal(pctEncode(' '), '%20');
    assert.equal(pctEncode('='), '%3D');
    assert.equal(pctEncode('aZ0-_.~'), 'aZ0-_.~');
    assert.equal(pctEncode(5), '5');   // String() coercion
  });
});

describe('oauthBaseString', () => {
  it('is METHOD&pct(url)&pct(sorted params), double-encoded', () => {
    const url = new URL('https://api.bricklink.com/api/store/v1/orders?status=PENDING&direction=in');
    const base = oauthBaseString('get', url, { oauth_nonce: 'N', oauth_timestamp: '137131200', oauth_consumer_key: 'CK' });
    assert.ok(base.startsWith('GET&'), 'method uppercased');
    assert.ok(base.includes(pctEncode('https://api.bricklink.com/api/store/v1/orders')), 'url pct-encoded');
    assert.ok(base.includes(pctEncode('direction=in')) && base.includes(pctEncode('status=PENDING')), 'query params folded in');
    assert.ok(base.includes(pctEncode('oauth_nonce=N')), 'oauth params folded in');
  });
  it('KNOWN-ANSWER vector pins the exact base string (locks param sort + double-encode)', () => {
    // A hardcoded golden literal — NOT a self-recompute. Dropping the sort or the outer pctEncode in
    // oauthBaseString changes this output and fails here, catching a live-only BrickLink signature break.
    const url = new URL('https://api.bricklink.com/api/store/v1/orders?status=PENDING&direction=in');
    const oauth = { oauth_consumer_key: 'CK', oauth_token: 'TK', oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '1700000000', oauth_nonce: 'FIXEDNONCE', oauth_version: '1.0' };
    assert.equal(oauthBaseString('GET', url, oauth),
      'GET&https%3A%2F%2Fapi.bricklink.com%2Fapi%2Fstore%2Fv1%2Forders&direction%3Din%26oauth_consumer_key%3DCK%26oauth_nonce%3DFIXEDNONCE%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1700000000%26oauth_token%3DTK%26oauth_version%3D1.0%26status%3DPENDING');
  });
});

describe('bricklinkAuthHeader', () => {
  const cred = { consumerKey: 'CK', consumerSecret: 'CS', token: 'TK', tokenSecret: 'TS' };
  const url = new URL('https://api.bricklink.com/api/store/v1/items/SET/75192-1/price');

  it('is deterministic with injected nonce/timestamp; signature == HMAC(base, key)', () => {
    const h = bricklinkAuthHeader('GET', url, cred, { nonce: 'FIXEDNONCE', timestamp: '137131200' });
    assert.ok(h.startsWith('OAuth '));
    assert.ok(h.includes('oauth_nonce="FIXEDNONCE"'));
    assert.ok(h.includes('oauth_timestamp="137131200"'));
    // Independently recompute the signature — the regression lock against any base-string drift.
    const oauth = { oauth_consumer_key: 'CK', oauth_token: 'TK', oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '137131200', oauth_nonce: 'FIXEDNONCE', oauth_version: '1.0' };
    const base = oauthBaseString('GET', url, oauth);
    const sig = crypto.createHmac('sha1', pctEncode('CS') + '&' + pctEncode('TS')).update(base).digest('base64');
    assert.ok(h.includes('oauth_signature="' + pctEncode(sig) + '"'), 'header signature == HMAC(base, signingKey)');
  });

  it('KNOWN-ANSWER vector pins the full signature (hardcoded, not a module self-recompute)', () => {
    const gurl = new URL('https://api.bricklink.com/api/store/v1/orders?status=PENDING&direction=in');
    const h = bricklinkAuthHeader('GET', gurl, { consumerKey: 'CK', consumerSecret: 'CS', token: 'TK', tokenSecret: 'TS' }, { timestamp: '1700000000', nonce: 'FIXEDNONCE' });
    assert.ok(h.includes('oauth_signature="lk%2Fdq0eB1nMVWylpJ1YeGoPP8H0%3D"'), 'signature matches the golden vector');
  });

  it('identical opts → identical header; no opts → a fresh random nonce each call', () => {
    assert.equal(
      bricklinkAuthHeader('GET', url, cred, { nonce: 'X', timestamp: '1' }),
      bricklinkAuthHeader('GET', url, cred, { nonce: 'X', timestamp: '1' }));
    assert.notEqual(bricklinkAuthHeader('GET', url, cred), bricklinkAuthHeader('GET', url, cred));
  });
});
