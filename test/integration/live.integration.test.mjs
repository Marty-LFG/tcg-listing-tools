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

  it('rb (scrydex, keyed): reports auth state without crashing', async () => {
    const r = await fetch(srv.base + '/api/rb/cards/OGN-001?include=prices', { signal: AbortSignal.timeout(20_000) });
    // 200 = valid key; 401/403 = bad key; 402 = billing lapse (observed 2026-07); 404 = card gone.
    // All mean "proxy works, upstream answered" — the status page turns these into pills.
    assert.ok([200, 401, 402, 403, 404].includes(r.status), `unexpected status ${r.status}`);
  }, { timeout: 25_000 });
});
