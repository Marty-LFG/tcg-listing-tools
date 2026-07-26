// test/unit/pkm-sets-cache.test.mjs — the /api/pkm/sets fallback decision. pokemontcg.io answers an
// empty-bodied HTTP 500 a quarter to half the time (measured 2026-07-26), so what matters is that a
// bad upstream minute NEVER empties a set picker and never overwrites a good cached list with junk.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideSetsResponse } from '../../lib/pkm-sets-cache.mjs';

const NOW = '2026-07-26T02:00:00.000Z';
const fresh = (n) => ({ data: Array.from({ length: n }, (_, i) => ({ id: 'set' + i, name: 'Set ' + i })), totalCount: n });
const lastGood = { at: '2026-07-25T09:00:00.000Z', body: fresh(174) };

describe('decideSetsResponse', () => {
  it('serves and stores a good upstream list', () => {
    const d = decideSetsResponse(fresh(174), null, NOW);
    assert.equal(d.status, 200);
    assert.equal(d.store, true);
    assert.equal(d.body.stale, false);
    assert.equal(d.body.data.length, 174);
  });

  it('upstream down + a cached list → the cached list, flagged stale, cache untouched', () => {
    const d = decideSetsResponse(null, lastGood, NOW);
    assert.equal(d.status, 200);
    assert.equal(d.store, false, 'must not overwrite the good cache');
    assert.equal(d.body.stale, true);
    assert.equal(d.body.cachedAt, lastGood.at);
    assert.equal(d.body.data.length, 174);
  });

  it('empty-but-200 upstream is treated as a failure, not as an empty truth', () => {
    // A re-indexing pokemontcg.io returns 200 with data:[]. Caching that would blank every picker
    // for the TTL — the same trap catalog.mjs decideCardsResponse guards against.
    const d = decideSetsResponse({ data: [], totalCount: 0 }, lastGood, NOW);
    assert.equal(d.store, false);
    assert.equal(d.body.stale, true);
    assert.equal(d.body.data.length, 174);
  });

  it('empty upstream with nothing cached passes the empty result through as 200', () => {
    const d = decideSetsResponse({ data: [], totalCount: 0 }, null, NOW);
    assert.equal(d.status, 200);
    assert.equal(d.store, false);
    assert.deepEqual(d.body.data, []);
  });

  it('upstream down with nothing cached → 502, never a bodyless 500', () => {
    const d = decideSetsResponse(null, null, NOW);
    assert.equal(d.status, 502);
    assert.equal(d.body.code, 'upstream_unreachable');
    assert.deepEqual(d.body.data, [], 'clients that read .data must not crash on the error body');
  });

  it('ignores a cached entry that is itself empty', () => {
    const d = decideSetsResponse(null, { at: NOW, body: { data: [] } }, NOW);
    assert.equal(d.status, 502);
  });
});
