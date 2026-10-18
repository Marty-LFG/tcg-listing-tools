// test/integration/listings-band-guard.test.mjs — the LIVE postage-band check on the publish path
// (audit E1, 2026-10-16).
//
// THE FAILURE THIS PREVENTS. The owner moved the sub-A$50 eBay policy to A$5.85 tracked by hand. The
// band's saved service table still held the old policy's three options (A$1.70 untracked letter
// among them), so every description said "Postage is $5.85 … sent tracked" above a table offering a
// service the checkout does not have. /publish and /batch only ran accountReadyGuard, which reads our
// own config file, so nothing on the publish path ever asked eBay. GR6 calls that an INAD claim on
// every listing in the band, and AGENTS.md said publishing refused it. Now it does.
//
// Three halves: the check itself (cache, TTL, invalidation, unreadable), the route guard's refusal
// shape, and a source scan that every route which puts a description live calls it.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';
import { liveBandCheck, liveBandGuard, noteBandCheck, resetBandCheckCache, BAND_CHECK_TTL_MS } from '../../lib/listings.mjs';
import { testEbayConfig, fulfillmentPolicyRow, fulfillmentPolicyRows } from '../helpers/ebay-config.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };
const realFetch = globalThis.fetch;
let policyReads, policyAnswer;

function resp(status, json) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json || {}) };
}
before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('/sell/account/v1/fulfillment_policy')) { policyReads++; return policyAnswer(); }
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + u }] });
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  resetBandCheckCache();
  policyReads = 0;
  policyAnswer = () => resp(200, { fulfillmentPolicies: fulfillmentPolicyRows() });
});

// The 2026-10-16 state: the letter policy now offers four services at A$5.85+, the band still lists
// the old policy's three.
function driftedRows() {
  const rows = fulfillmentPolicyRows();
  rows[0] = fulfillmentPolicyRow(rows[0].fulfillmentPolicyId, rows[0].name, 170, 'AU_AusPostStandardLetter', { services: [
    { code: 'AU_AusPostStandardLetter', costCents: 170 }, { code: 'AU_Express', costCents: 945 },
  ] });
  return rows;
}
function fakeRes() {
  return { statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
}

describe('liveBandCheck — the same verifyBandPolicies Settings runs, against eBay, on the publish path', () => {
  it('passes a correctly wired account and caches the pass for the TTL', async () => {
    const cfg = testEbayConfig();
    const t0 = 1_000_000;
    const a = await liveBandCheck(ENV, cfg, { now: t0 });
    assert.equal(a.ok, true, (a.errors || []).join(' · '));
    assert.equal(a.cached, false);
    const b = await liveBandCheck(ENV, cfg, { now: t0 + BAND_CHECK_TTL_MS - 1 });
    assert.equal(b.ok, true);
    assert.equal(b.cached, true, 'a hundred-card session costs one policy read, not a hundred');
    assert.equal(policyReads, 1);
    const c = await liveBandCheck(ENV, cfg, { now: t0 + BAND_CHECK_TTL_MS + 1 });
    assert.equal(c.cached, false, 'past the TTL eBay is asked again');
    assert.equal(policyReads, 2);
  });
  it('any change to the band table misses the cache at once', async () => {
    const cfg = testEbayConfig();
    await liveBandCheck(ENV, cfg, { now: 1 });
    const edited = testEbayConfig();
    edited.shipping.bands[0] = { ...edited.shipping.bands[0], services: edited.shipping.bands[0].services.slice(0, 2) };
    const r = await liveBandCheck(ENV, edited, { now: 2 });
    assert.equal(r.cached, false, 'a setup re-run or a Settings edit is re-verified, never served a stale pass');
    assert.equal(policyReads, 2);
  });
  it('REFUSES the drifted table, and does not cache the refusal', async () => {
    policyAnswer = () => resp(200, { fulfillmentPolicies: driftedRows() });
    const cfg = testEbayConfig();
    const r = await liveBandCheck(ENV, cfg, { now: 1 });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' · '), /no longer offers/);
    await liveBandCheck(ENV, cfg, { now: 2 });
    assert.equal(policyReads, 2, 'the fix (Seller Hub or setup) must take effect on the very next attempt');
  });
  it('an unreadable policy list is a refusal, never a pass', async () => {
    policyAnswer = () => resp(403, { errors: [{ errorId: 1100, message: 'Access denied' }] });
    const r = await liveBandCheck(ENV, testEbayConfig(), { now: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.unreadable, true);
    assert.match(r.error, /Access denied/);
  });
  it('a failing check seen elsewhere (Settings, setup) evicts a cached pass', async () => {
    const cfg = testEbayConfig();
    await liveBandCheck(ENV, cfg, { now: 1 });
    noteBandCheck(cfg, { ok: false, errors: ['x'] });
    const r = await liveBandCheck(ENV, cfg, { now: 2 });
    assert.equal(r.cached, false);
    assert.equal(policyReads, 2);
  });
  it('a pass seen elsewhere is a pass here', async () => {
    const cfg = testEbayConfig();
    noteBandCheck(cfg, { ok: true, errors: [], warnings: [], bands: [] });
    const r = await liveBandCheck(ENV, cfg);
    assert.equal(r.cached, true);
    assert.equal(policyReads, 0);
  });
});

describe('liveBandGuard — the refusal a publish route sends', () => {
  it('409 band_mismatch naming every problem and the fix', async () => {
    policyAnswer = () => resp(200, { fulfillmentPolicies: driftedRows() });
    const res = fakeRes();
    assert.equal(await liveBandGuard(ENV, testEbayConfig(), res), false);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'band_mismatch');
    assert.match(res.body.error, /^Nothing was published/);
    assert.match(res.body.error, /no longer offers/);
    assert.match(res.body.error, /Re-run Settings → eBay listing setup/);
    assert.equal(res.body.bandCheck.ok, false);
  });
  it('503 bands_unverified when eBay cannot be read', async () => {
    policyAnswer = () => resp(403, { errors: [{ errorId: 1100, message: 'Access denied' }] });
    const res = fakeRes();
    assert.equal(await liveBandGuard(ENV, testEbayConfig(), res), false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'bands_unverified');
  });
  it('passes through silently when the bands match', async () => {
    const res = fakeRes();
    assert.equal(await liveBandGuard(ENV, testEbayConfig(), res), true);
    assert.equal(res.statusCode, 0, 'nothing sent');
  });
});

describe('every route that puts a description live runs the live band check', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/listings.mjs'), 'utf8');
  // The route head → the next route head. A block is whatever runs for that route.
  const block = (head) => {
    const at = src.indexOf(head);
    assert.ok(at >= 0, 'route not found: ' + head);
    const next = src.indexOf('\n      if (', at + head.length);
    return src.slice(at, next < 0 ? undefined : next);
  };
  for (const [head, why] of [
    ["if (p === '/publish' && method === 'POST')", 'publishes (or revises) one listing live'],
    ["if (p === '/batch' && method === 'POST')", 'publishes a whole staged batch'],
    ["if ((m = p.match(/^\\/(\\d+)\\/revise-price$/)) && method === 'POST')", 'republishes the offer, description included'],
  ]) {
    it(`${head.slice(0, 48)}… (${why})`, () => {
      const b = block(head);
      const ready = b.indexOf('accountReadyGuard(cfg, res)');
      const live = b.indexOf('liveBandGuard(env, cfg, res)');
      assert.ok(live > 0, 'no live band check on this route');
      assert.ok(ready > 0 && live > ready, 'the cheap config check runs first, then the eBay read');
      assert.ok(live < b.indexOf('runPublish(') || b.indexOf('runPublish(') < 0, 'checked BEFORE anything is published');
      assert.ok(live < b.indexOf('startBatchJob(') || b.indexOf('startBatchJob(') < 0, 'checked BEFORE the batch starts');
    });
  }
});
