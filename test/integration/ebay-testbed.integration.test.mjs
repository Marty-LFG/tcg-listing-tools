// test/integration/ebay-testbed.integration.test.mjs — the testbed API against a real booted server.
//
// bootServer() blanks every credential (OFFLINE_ENV), so eBay is unreachable here BY DESIGN. That
// makes this the right place to prove the half of the contract that matters most for a bench: the
// pure endpoints work with no network at all, and the networked ones DEGRADE rather than 500.
// A tool for diagnosing bad queries is worthless if it dies the moment a query is bad.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv;
before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const get = async (p) => {
  const r = await fetch(srv.base + p);
  let json = null; try { json = await r.json(); } catch { /* html */ }
  return { status: r.status, json };
};
const post = async (p, body) => {
  const r = await fetch(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* html */ }
  return { status: r.status, json };
};

const CHARIZARD = { game: 'pokemon', name: 'Charizard ex', number: '199/165', setName: 'Scarlet & Violet 151', lang: 'en', condition: 'Near Mint' };

describe('the page is served', () => {
  it('/ebay-testbed.html exists', async () => {
    const r = await fetch(srv.base + '/ebay-testbed.html');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /eBay Testbed/);
    // Vite extracts an inline module script to /<page>?html-proxy&index=N.js, so the import is not
    // in the served HTML. That the page reaches for lib/ebay-links.mjs is asserted at source level
    // by test/invariants/ebay-links-single-source.test.mjs; here we only prove it is served.
    assert.match(html, /html-proxy/, 'the module script should be extracted by Vite');
  });
});

describe('/api/testbed/vocab — static, so it works with no credentials', () => {
  it('returns the modes, packs and measured fill rates', async () => {
    const { status, json } = await get('/api/testbed/vocab');
    assert.equal(status, 200);
    assert.ok(json.modes.length >= 4);
    assert.ok(json.packs.length >= 5);
    assert.ok(json.aspectFill.Graded.fill > 95);
    assert.equal(json.aspectFill.Grade.basis, 'graded', 'the population a fill rate was measured against is part of the fact');
    assert.equal(json.categories.ccgSingles, '183454');
  });

  it('every grader marked unsafe carries the collision that makes it unsafe', async () => {
    const { json } = await get('/api/testbed/vocab');
    for (const g of json.graders) {
      if (g.safe === false) assert.ok(g.unsafeWhy, g.code + ' is unsafe with nothing to show the user');
    }
  });
});

describe('/api/testbed/plan — pure, no eBay call', () => {
  it('builds a full plan offline', async () => {
    const { status, json } = await post('/api/testbed/plan', { identity: CHARIZARD, opts: { mode: 'structured' } });
    assert.equal(status, 200);
    assert.equal(json.nkw, 'Charizard ex 199/165');
    assert.match(json.browse.aspect_filter, /Graded:\{No\}/);
    assert.match(json.browse.filter, /itemLocationCountry:AU/);
    assert.ok(json.webUrl.startsWith('https://www.ebay.com.au/'), 'the clickable link works even when the API does not');
  });

  it('a graded card asks for its grade and grader', async () => {
    const { json } = await post('/api/testbed/plan', {
      identity: { ...CHARIZARD, graded: true, company: 'PSA', grade: 10 }, opts: { mode: 'structured' },
    });
    assert.match(json.browse.aspect_filter, /Grade:\{10\}/);
    assert.match(json.browse.aspect_filter, /Professional Grader:\{Professional Sports Authenticator \(PSA\)\}/);
    assert.match(json.browse.filter, /conditionIds:\{2750\}/);
  });

  // The bug this whole feature exists to fix: today's query is byte-identical for a raw card and a
  // PSA 10 of the same card, so the slab is priced off raw listings. Measured live at the time of
  // writing: A$550 against a real PSA 10 market of ~A$2,787.
  it('recall mode still cannot tell a slab from a raw card — the defect, pinned', async () => {
    const raw = await post('/api/testbed/plan', { identity: CHARIZARD, opts: { mode: 'recall' } });
    const psa = await post('/api/testbed/plan', { identity: { ...CHARIZARD, graded: true, company: 'PSA', grade: 10 }, opts: { mode: 'recall' } });
    assert.equal(raw.json.nkw, psa.json.nkw, 'if this ever differs, recall mode has been changed and this test should be revisited');
    const s = await post('/api/testbed/plan', { identity: { ...CHARIZARD, graded: true, company: 'PSA', grade: 10 }, opts: { mode: 'structured' } });
    assert.match(s.json.browse.aspect_filter, /Grade:\{10\}/, 'structured mode is the fix and must keep telling them apart');
  });

  it('survives a junk identity rather than 500ing (GR7)', async () => {
    for (const identity of [{}, { name: '' }, { name: 'x'.repeat(500) }, { number: null, grade: 'abc' }]) {
      const { status, json } = await post('/api/testbed/plan', { identity, opts: { mode: 'precision' } });
      assert.equal(status, 200, JSON.stringify(identity));
      assert.equal(typeof json.nkw, 'string');
    }
  });
});

describe('the networked endpoints degrade instead of dying', () => {
  // Credentials are blanked, so the proxy 503s. A bench must report that as a reason per lane, not
  // as a stack trace — the whole point is to be usable while things are broken.
  it('/count reports a reason per lane and never 500s', async () => {
    const { status, json } = await post('/api/testbed/count', { identity: CHARIZARD, opts: {} });
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.lanes) && json.lanes.length >= 4);
    for (const l of json.lanes) {
      assert.ok(l.id, 'every lane keeps its identity even when the call failed');
      assert.ok(l.total === null || typeof l.total === 'number');
      if (l.total === null) assert.ok(l.reason, l.id + ' failed with no reason given');
      assert.ok(typeof l.nkw === 'string', 'the query is known regardless of whether eBay answered');
    }
  });

  it('/run returns every lane with a reason rather than an exception', async () => {
    const { status, json } = await post('/api/testbed/run', { identity: CHARIZARD, opts: {} });
    assert.equal(status, 200);
    for (const l of json.lanes) {
      assert.equal(l.comparable, 0);
      assert.equal(l.recommended, null);
      assert.ok(l.reason || l.countReason, l.id + ' gave no reason for having no price');
      assert.ok(l.webUrl, 'the ↗ link is built locally and must survive an eBay outage');
    }
  });

  it('/aspects degrades', async () => {
    const { status, json } = await get('/api/testbed/aspects?q=charizard');
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.ok(json.reason);
  });

  it('an unknown endpoint lists what it does support', async () => {
    const { status, json } = await get('/api/testbed/nope');
    assert.equal(status, 404);
    assert.ok(json.endpoints.includes('/plan'));
  });
});
