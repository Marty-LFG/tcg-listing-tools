// test/unit/catalog.test.mjs — pure helpers in lib/catalog.mjs. Offline (injected fetchPage).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paginateJson, decideCardsResponse } from '../../lib/catalog.mjs';

describe('paginateJson (EN card fetch pagination — no dropped cards)', () => {
  // A fake paginated endpoint over a fixed array.
  const pageOf = (all, size) => (page) => ({ data: all.slice((page - 1) * size, (page - 1) * size + size), totalCount: all.length });

  it('collects EVERY page for a set larger than one page (sv2 = 279 > 250)', async () => {
    const all = Array.from({ length: 279 }, (_, i) => ({ n: i + 1 }));
    const got = await paginateJson(pageOf(all, 250), 250);
    assert.equal(got.length, 279, 'no cards dropped past page 1');
    assert.equal(got[278].n, 279, 'the tail card (secret rare) is present');
  });

  it('stops on a short final page (exactly two fetches)', async () => {
    let calls = 0;
    const fetchPage = (page) => { calls++; return { data: Array.from({ length: page === 1 ? 250 : 30 }, () => ({})) }; };
    const got = await paginateJson(fetchPage, 250);
    assert.equal(got.length, 280);
    assert.equal(calls, 2);
  });

  it('stops when totalCount is reached even on a full final page', async () => {
    let calls = 0;
    const fetchPage = () => { calls++; return { data: Array.from({ length: 250 }, () => ({})), totalCount: 500 }; };
    const got = await paginateJson(fetchPage, 250);
    assert.equal(got.length, 500);
    assert.equal(calls, 2);
  });

  it('a single short page → one fetch', async () => {
    let calls = 0;
    const got = await paginateJson(() => { calls++; return { data: [{}, {}], totalCount: 2 }; }, 250);
    assert.equal(got.length, 2);
    assert.equal(calls, 1);
  });

  it('respects the maxPages cap (no runaway loop)', async () => {
    let calls = 0;
    const got = await paginateJson(() => { calls++; return { data: Array.from({ length: 250 }, () => ({})) }; }, 250, 3);
    assert.equal(calls, 3);
    assert.equal(got.length, 750);
  });
});

describe('decideCardsResponse (empty-200 last-good fallback — bug #5)', () => {
  const cards = [{ numRaw: '1', name: 'A' }, { numRaw: '2', name: 'B' }];
  const lastGood = { cards: [{ numRaw: '9', name: 'Stored' }], source: 'pricecharting', at: '2026-07-01T00:00:00Z' };

  it('fresh cards → store + serve them (stale:false)', () => {
    const d = decideCardsResponse(cards, 'pokemontcg', null, 'NOW');
    assert.equal(d.store, true, 'must persist a good list');
    assert.deepEqual(d.body, { cards, source: 'pokemontcg', stale: false, cached: false, cachedAt: 'NOW', count: 2 });
  });
  it('EMPTY upstream WITH a stored copy → serve last-good stale, and do NOT store (no cache poisoning)', () => {
    const d = decideCardsResponse([], 'pokemontcg', lastGood, 'NOW');
    assert.equal(d.store, false, 'must NOT overwrite the good copy with []');
    assert.equal(d.body.stale, true);
    assert.equal(d.body.cached, true);
    assert.equal(d.body.count, 1);
    assert.equal(d.body.cards[0].name, 'Stored');
    assert.equal(d.body.source, 'pricecharting');
    assert.equal(d.body.cachedAt, '2026-07-01T00:00:00Z');
  });
  it('EMPTY upstream with NO stored copy → the empty result, still no store', () => {
    const d = decideCardsResponse([], 'none', null, 'NOW');
    assert.equal(d.store, false);
    assert.equal(d.body.count, 0);
    assert.equal(d.body.stale, false);
  });
});
