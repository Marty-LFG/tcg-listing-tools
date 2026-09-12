// test/integration/live.integration.test.mjs — OPT-IN live-network smoke tests.
// Skipped unless TEST_LIVE=1 (BJB skipIf pattern):  PowerShell: $env:TEST_LIVE='1'; pnpm test:integration
// Only keyless sources are asserted reachable; keyed sources must never fail the
// suite for a missing/dead key (GR7) — they may only fail on transport errors.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

const LIVE = process.env.TEST_LIVE === '1';

describe('live upstream smoke (TEST_LIVE=1)', { skip: !LIVE && 'set TEST_LIVE=1 to run live probes' }, () => {
  let srv;
  before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
  after(async () => { await srv?.close(); });

  const KEYLESS = [
    ['fx', '/api/fx/latest?base=USD&symbols=AUD'],
    ['mtg (scryfall)', '/api/mtg/cards/neo/1'],
    ['swu (swu-db)', '/api/swu/cards/sor/010'],
    ['lorcana (lorcast)', '/api/lorcana/cards/1/1'],
    ['rbs (riftscribe)', '/api/rbs/cards?limit=1'],
    // pokemontcg.io is a legacy endpoint with erratic latency (0.4s–15s observed) — generous timeout
    ['pkm (pokemontcg, keyless tier)', '/api/pkm/cards/base1-4', 45_000],
  ];
  for (const [name, path, tmo = 20_000] of KEYLESS) {
    it(`${name} reachable through the proxy`, async () => {
      const r = await fetch(srv.base + path, { signal: AbortSignal.timeout(tmo) });
      assert.ok(r.status < 500, `${name} → HTTP ${r.status}`);
    }, { timeout: 50_000 });
  }

  // The arbitrage finder's one live case: a real Browse call for one card through the booted server.
  // bootServer blanks the eBay keys, so this reads them back from the developer's own .env explicitly —
  // the Browse app token is READ-ONLY (item_summary/search) and cannot list, buy or message. Skipped
  // with a reason when the keys are absent rather than failing the suite (GR7).
  it('arbitrage: one Browse call parses AUD rows, counts one call, and never throws', async (t) => {
    const fs = await import('node:fs');
    const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID) return t.skip('no eBay app keys in .env');
    const { bootServer: boot } = await import('../helpers/boot-server.mjs');
    const live = await boot({ env: { EBAY_APP_ID: env.EBAY_APP_ID, EBAY_CERT_ID: env.EBAY_CERT_ID, EBAY_BUYER_POSTCODE: env.EBAY_BUYER_POSTCODE || '2000' } });
    try {
      const res = await fetch(live.base + '/api/arb/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setId: 'sv3', lines: ['125'] }) }).then((r) => r.json());
      if (!res.cards.length) return t.skip('sv3 is not cached and pokemontcg.io did not answer: ' + JSON.stringify(res.unknown));
      const r = await fetch(live.base + '/api/arb/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cards: [{ card_id: 'sv3-125', printing_key: 'holofoil' }] }), signal: AbortSignal.timeout(40_000) });
      const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
      const card = lines.find((l) => l.card), summary = lines.find((l) => l.summary);
      assert.ok(summary, 'a summary always arrives');
      assert.equal(summary.summary.aborted, null, 'aborted=' + summary.summary.aborted);
      assert.ok(card && card.card.rows > 0, 'at least one AU listing parsed');
      assert.equal(summary.summary.calls, 1);
      const cfg = await fetch(live.base + '/api/arb/config').then((x) => x.json());
      assert.equal(cfg.budget.used, 1, 'exactly one call counted');
      console.log(`[live] arbitrage sv3-125: ${card.card.rows} rows → ${card.card.kept} kept → ${card.card.hits} hits; dropped ${JSON.stringify(card.card.dropped)}`);
    } finally { await live.close(); }
  }, { timeout: 90_000 });

  it('rb (scrydex, keyed): reports auth state without crashing', async () => {
    const r = await fetch(srv.base + '/api/rb/cards/OGN-001?include=prices', { signal: AbortSignal.timeout(20_000) });
    // 200 = valid key; 401/403 = bad key; 402 = billing lapse (observed 2026-07); 404 = card gone.
    // All mean "proxy works, upstream answered" — the status page turns these into pills.
    assert.ok([200, 401, 402, 403, 404].includes(r.status), `unexpected status ${r.status}`);
  }, { timeout: 25_000 });
});
