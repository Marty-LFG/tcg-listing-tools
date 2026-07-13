// test/unit/catalog.test.mjs — pure helpers in lib/catalog.mjs. Offline (injected fetchPage).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paginateJson } from '../../lib/catalog.mjs';

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
