// test/integration/collector-cache-bypass.test.mjs — the price tracker reads the market, not a copy.
//
// THE REGRESSION THIS LOCKS DOWN: the card caches answer exactly the routes the collector fetches
// prices from (lib/normalize.mjs pricePath → /api/pkm/cards/:id, /api/mtg/cards/:set/:num, and the
// rest). The moment those routes started serving stored sets for the builders' benefit, the tracker
// was quietly recording the same number every pass — a price history that only moves when a cache
// does, and buy signals reading their own echo.
//
// So every request the collector makes carries the bypass header. This drives a real pass against a
// real (temp) tracker DB with a stubbed upstream, and checks the header is on the wire.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { runPass } from '../../lib/collector.mjs';
import { BYPASS_HEADER } from '../../lib/set-cache.mjs';

let db, tmpDir;
const realFetch = globalThis.fetch;
const seen = [];

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-collector-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  db.prepare(`INSERT INTO watchlist (game, identity_key, name, variant, source, active)
              VALUES ('pokemon', 'sv3-200', 'Palafin', 'Holofoil', 'user', 1)`).run();
});
after(() => {
  globalThis.fetch = realFetch;
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('the collector never reads a cached card', () => {
  it('sends the bypass header on every request it makes', async () => {
    globalThis.fetch = async (url, opts = {}) => {
      seen.push({ url: String(url), bypass: (opts.headers || {})[BYPASS_HEADER] });
      if (String(url).includes('/api/fx/')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { AUD: 1.5 }, date: '2026-08-03' }), json: async () => ({ rates: { AUD: 1.5 }, date: '2026-08-03' }) };
      }
      // A pokemontcg.io single card, priced.
      const card = { id: 'sv3-200', name: 'Palafin', number: '200', set: { id: 'sv3', name: 'Obsidian Flames' },
        tcgplayer: { prices: { holofoil: { market: 12.34, mid: 12, low: 10 } } } };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: card }), json: async () => ({ data: card }) };
    };

    await runPass({ db, base: 'http://127.0.0.1:5399', trigger: 'test' });

    assert.ok(seen.length >= 2, 'the pass fetched FX and the card');
    const cardCalls = seen.filter((c) => c.url.includes('/api/pkm/cards/'));
    assert.equal(cardCalls.length, 1, 'the watched card was fetched');
    for (const c of seen) {
      assert.equal(c.bypass, '1', 'missing the bypass header on ' + c.url);
    }
  });

  it('and the snapshot it recorded is the price it was given', () => {
    const snap = db.prepare(`SELECT market, currency, source FROM price_snapshots ORDER BY id DESC LIMIT 1`).get();
    assert.ok(snap, 'a pass with a live price writes a snapshot');
    assert.equal(snap.market, 12.34, 'the market figure from the stubbed upstream, not a cached one');
    assert.equal(snap.source, 'pokemontcg');
  });
});
