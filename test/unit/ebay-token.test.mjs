// test/unit/ebay-token.test.mjs — eBay app-token minting (lib/ebay-token.mjs). Stubs global fetch;
// no network. __resetTokenCaches() keeps the module singleton deterministic between cases.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ebayToken, ebayInsightsToken, assertNotSandbox, __resetTokenCaches } from '../../lib/ebay-token.mjs';

const realFetch = globalThis.fetch;
let calls;
const stubFetch = (handler) => { globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); }; };
const okJson = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const errBody = (status, body) => ({ ok: false, status, text: async () => body });
const PRD = { EBAY_APP_ID: 'PRD-a', EBAY_CERT_ID: 'PRD-b' };

beforeEach(() => { calls = []; __resetTokenCaches(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe('mint + cache (singleton, no double-mint)', () => {
  it('mints once then serves from cache', async () => {
    stubFetch(() => okJson({ access_token: 'T1', expires_in: 7200 }));
    assert.equal(await ebayToken(PRD), 'T1');
    assert.equal(await ebayToken(PRD), 'T1');
    assert.equal(calls.length, 1, 'second call is cached');
  });
  it('re-mints once the cached token has expired (early-refresh clamp)', async () => {
    let n = 0;
    stubFetch(() => okJson({ access_token: 'T' + (++n), expires_in: 30 }));   // exp = now + max(0,30-60) = now → expired
    assert.equal(await ebayToken(PRD), 'T1');
    assert.equal(await ebayToken(PRD), 'T2');
    assert.equal(calls.length, 2);
  });
  it('insights token has its OWN cache: no double-mint, and re-mints on expiry (metered quota)', async () => {
    let n = 0;
    stubFetch(() => okJson({ access_token: 'INS' + (++n), expires_in: 7200 }));
    assert.equal(await ebayInsightsToken(PRD), 'INS1');
    assert.equal(await ebayInsightsToken(PRD), 'INS1');
    assert.equal(calls.length, 1, 'second call served from the insights cache — must not burn the metered quota');
    __resetTokenCaches(); calls = [];
    let m = 0;
    stubFetch(() => okJson({ access_token: 'IX' + (++m), expires_in: 30 }));   // expired immediately
    assert.equal(await ebayInsightsToken(PRD), 'IX1');
    assert.equal(await ebayInsightsToken(PRD), 'IX2');
    assert.equal(calls.length, 2, 're-minted after expiry');
  });
});

describe('SBX guard (asymmetric)', () => {
  it('ebayToken throws on sandbox keys and never fetches', async () => {
    stubFetch(() => okJson({ access_token: 'x', expires_in: 7200 }));
    await assert.rejects(() => ebayToken({ EBAY_APP_ID: 'SBX-a', EBAY_CERT_ID: 'PRD-b' }), /SANDBOX/);
    assert.equal(calls.length, 0);
  });
  it('assertNotSandbox: PRD ok, SBX throws with the PRD- hint', () => {
    assert.doesNotThrow(() => assertNotSandbox('PRD-a', 'PRD-b'));
    assert.throws(() => assertNotSandbox('a', 'SBX-b'), /PRD-/);
  });
  it('ebayInsightsToken does NOT apply the SBX guard (preserves prior behavior)', async () => {
    stubFetch(() => okJson({ access_token: 'INS', expires_in: 7200 }));
    assert.equal(await ebayInsightsToken({ EBAY_APP_ID: 'SBX-a', EBAY_CERT_ID: 'PRD-b' }), 'INS');
    assert.equal(calls.length, 1);
  });
});

describe('request shape', () => {
  it('trims keys into Basic auth; Browse uses the base scope (not insights)', async () => {
    stubFetch(() => okJson({ access_token: 'T', expires_in: 7200 }));
    await ebayToken({ EBAY_APP_ID: 'app\n', EBAY_CERT_ID: ' cert ' });
    const { opts } = calls[0];
    assert.equal(opts.headers.Authorization, 'Basic ' + Buffer.from('app:cert').toString('base64'));
    assert.ok(opts.body.includes('scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')));
    assert.ok(!opts.body.includes('buy.marketplace.insights'));
  });
  it('insights token requests the insights scope', async () => {
    stubFetch(() => okJson({ access_token: 'T', expires_in: 7200 }));
    await ebayInsightsToken(PRD);
    assert.ok(calls[0].opts.body.includes(encodeURIComponent('https://api.ebay.com/oauth/api_scope/buy.marketplace.insights')));
  });
});

describe('error mapping', () => {
  it('Browse !ok JSON → HTTP status + error detail + production hint', async () => {
    stubFetch(() => errBody(401, JSON.stringify({ error: 'invalid_client', error_description: 'client authentication failed' })));
    await assert.rejects(() => ebayToken(PRD),
      (e) => /HTTP 401/.test(e.message) && /invalid_client: client authentication failed/.test(e.message) && /Production/.test(e.message));
  });
  it('Browse !ok non-JSON → raw slice', async () => {
    stubFetch(() => errBody(500, 'oops'));
    await assert.rejects(() => ebayToken(PRD), /HTTP 500\).*oops/);
  });
  it('Browse ok but non-JSON body → "response was not JSON"', async () => {
    stubFetch(() => ({ ok: true, status: 200, text: async () => 'notjson' }));
    await assert.rejects(() => ebayToken(PRD), /was not JSON/);
  });
  it('Insights !ok → scope-not-granted message', async () => {
    stubFetch(() => errBody(403, JSON.stringify({ error: 'insufficient_scope' })));
    await assert.rejects(() => ebayInsightsToken(PRD), /Marketplace Insights scope not granted.*403/);
  });
});
