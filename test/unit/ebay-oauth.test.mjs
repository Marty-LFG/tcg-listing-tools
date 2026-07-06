// test/unit/ebay-oauth.test.mjs — eBay user-token OAuth helpers (lib/ebay-oauth.mjs).
// No network, no token store writes — only the pure/crypto pieces.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsentUrl, keysConfigured, runameConfigured, encryptSecret, decryptSecret, CONSENT_SCOPES } from '../../lib/ebay-oauth.mjs';

const ENV = { EBAY_APP_ID: 'app-id-123', EBAY_CERT_ID: 'cert-id-456', EBAY_RUNAME: 'My_RuName' };

describe('config gates', () => {
  it('keysConfigured needs both App ID and Cert ID', () => {
    assert.equal(keysConfigured({}), false);
    assert.equal(keysConfigured({ EBAY_APP_ID: 'a' }), false);
    assert.equal(keysConfigured(ENV), true);
  });
  it('runameConfigured', () => {
    assert.equal(runameConfigured({}), false);
    assert.equal(runameConfigured(ENV), true);
  });
});

describe('buildConsentUrl', () => {
  const u = new URL(buildConsentUrl(ENV, 'st4te'));
  it('points at eBay authorize with the RuName as redirect_uri', () => {
    assert.equal(u.origin + u.pathname, 'https://auth.ebay.com/oauth2/authorize');
    assert.equal(u.searchParams.get('client_id'), 'app-id-123');
    assert.equal(u.searchParams.get('redirect_uri'), 'My_RuName');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('state'), 'st4te');
  });
  it('requests all consent scopes up front (no re-consent later)', () => {
    const scopes = u.searchParams.get('scope').split(' ');
    assert.deepEqual(scopes, CONSENT_SCOPES);
    assert.ok(scopes.some((s) => s.endsWith('sell.inventory')));
  });
  it('never leaks the Cert ID into the (browser-visible) URL (GR2)', () => {
    assert.ok(!buildConsentUrl(ENV).includes('cert-id-456'));
  });
});

describe('refresh-token encryption at rest (AES-256-GCM)', () => {
  it('round-trips', () => {
    const blob = encryptSecret(ENV, 'v^1.1#i^1#refresh-token-value');
    assert.match(blob, /^v1:/);
    assert.equal(decryptSecret(ENV, blob), 'v^1.1#i^1#refresh-token-value');
  });
  it('unique IV per encryption (same plaintext → different blobs)', () => {
    assert.notEqual(encryptSecret(ENV, 'x'), encryptSecret(ENV, 'x'));
  });
  it('wrong key (Cert ID changed) → null, not a throw', () => {
    const blob = encryptSecret(ENV, 'secret');
    assert.equal(decryptSecret({ ...ENV, EBAY_CERT_ID: 'different' }, blob), null);
  });
  it('tampered blob → null', () => {
    const blob = encryptSecret(ENV, 'secret');
    const raw = Buffer.from(blob.slice(3), 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.equal(decryptSecret(ENV, 'v1:' + raw.toString('base64')), null);
  });
  it('garbage input → null', () => {
    assert.equal(decryptSecret(ENV, null), null);
    assert.equal(decryptSecret(ENV, 'not-a-blob'), null);
  });
});
