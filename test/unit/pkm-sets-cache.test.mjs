// test/unit/pkm-sets-cache.test.mjs — the /api/pkm/sets fallback decision. pokemontcg.io answers an
// empty-bodied HTTP 500 a quarter to half the time (measured 2026-07-26), so what matters is that a
// bad upstream minute NEVER empties a set picker and never overwrites a good cached list with junk.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideSetsResponse, isCompleteSetList } from '../../lib/pkm-sets-cache.mjs';

const NOW = '2026-07-26T02:00:00.000Z';
const fresh = (n, total) => ({ data: Array.from({ length: n }, (_, i) => ({ id: 'set' + i, name: 'Set ' + i })), totalCount: total == null ? n : total });
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

// ---------------------------------------------------------------------------
// The cache-poisoning bug, reproduced 2026-07-27: one request for ?pageSize=5 wrote a 5-set body
// into the shared memory AND disk cache, and every ?pageSize=500 caller got 5 sets back with
// stale:false for the next 30 minutes — surviving a restart, because it reached the disk.
//
// Two independent fixes, one test suite each: the middleware now ignores the caller's query and
// always fetches the canonical full list, and a short body is never STORED regardless of how it
// was obtained.
describe('isCompleteSetList — what is worth caching', () => {
  it('a full list is complete', () => {
    assert.equal(isCompleteSetList(fresh(174)), true);
  });
  it('a short list is NOT complete, however healthy the HTTP status was', () => {
    assert.equal(isCompleteSetList(fresh(5, 174)), false);
  });
  it('an empty list is not complete', () => {
    assert.equal(isCompleteSetList({ data: [], totalCount: 0 }), false);
    assert.equal(isCompleteSetList({ data: [], totalCount: 174 }), false);
  });
  it('no totalCount at all → trust the list, since there is nothing to compare against', () => {
    assert.equal(isCompleteSetList({ data: [{ id: 'a' }] }), true);
  });
  it('more rows than totalCount claims is still complete (never a reason to discard data)', () => {
    assert.equal(isCompleteSetList(fresh(200, 174)), true);
  });
  it('junk input is not complete, and does not throw', () => {
    assert.equal(isCompleteSetList(null), false);
    assert.equal(isCompleteSetList({}), false);
    assert.equal(isCompleteSetList({ data: 'nope' }), false);
  });
});

describe('decideSetsResponse — a truncated upstream is treated like an empty one', () => {
  it('NEVER stores a body shorter than totalCount — the poisoning half of the bug', () => {
    const d = decideSetsResponse(fresh(5, 174), null, NOW);
    assert.equal(d.store, false, 'a 5-of-174 answer must not reach the disk cache');
  });

  it('prefers the good cached list over a truncated fresh one', () => {
    const d = decideSetsResponse(fresh(5, 174), lastGood, NOW);
    assert.equal(d.store, false);
    assert.equal(d.body.data.length, 174, 'the full cached list wins over a short fresh one');
    assert.equal(d.body.stale, true);
  });

  it('with nothing cached, a truncated list is served but FLAGGED, never passed off as the truth', () => {
    // Something beats nothing for a picker, but a short list reported as complete is exactly how a
    // near-empty dropdown looks like a broken tool instead of a bad upstream minute.
    const d = decideSetsResponse(fresh(5, 174), null, NOW);
    assert.equal(d.status, 200);
    assert.equal(d.body.data.length, 5);
    assert.equal(d.body.truncated, true);
  });

  it('a complete list is never flagged truncated', () => {
    assert.equal(decideSetsResponse(fresh(174), null, NOW).body.truncated, undefined);
  });

  it('a truncated list already ON DISK is served but flagged, so old poisoned caches self-report', () => {
    const poisoned = { at: '2026-07-25T09:00:00.000Z', body: fresh(5, 174) };
    const d = decideSetsResponse(null, poisoned, NOW);
    assert.equal(d.status, 200);
    assert.equal(d.body.truncated, true);
    assert.equal(d.body.stale, true);
  });

  it('a complete fresh list overwrites a poisoned cache', () => {
    const poisoned = { at: '2026-07-25T09:00:00.000Z', body: fresh(5, 174) };
    const d = decideSetsResponse(fresh(174), poisoned, NOW);
    assert.equal(d.store, true, 'a good list must be able to replace a bad cached one');
    assert.equal(d.body.data.length, 174);
    assert.equal(d.body.truncated, undefined);
  });
});
