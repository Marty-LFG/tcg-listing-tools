// test/unit/lorcana-sets-cache.test.mjs — Lorcana's set list cache.
//
// /api/lorcana/sets was a bare Lorcast pass-through, so the builder hit the network on every load
// and nothing server-side could read the set list at all — which is why composeMetaFor had no
// Lorcana branch and a Lorcana row fell into the POKÉMON set-identity path instead.
//
// The shape is the difference from Magic: Lorcast wraps in {results:[...]}, not Scryfall's
// {data:[...]}, and there is no pagination to guard. Pure decisions and the sync lookups are
// covered here; the plugin itself is exercised by the integration suite.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lorcana-sets-'));
process.env.LORCANA_SETS_CACHE_DIR = TMP;   // set BEFORE the import — the module reads it per call

const { isCompleteSetList, decideSetsResponse, findLorcanaSet, listLorcanaSets, readCache } =
  await import('../../lib/lorcana-sets-cache.mjs');

// Real Lorcast shape, including the mixed-case promo codes that make the lookup case-sensitivity
// load-bearing ('cp' and 'D23' in the same list).
const SETS = [
  { id: 'set_7ecb0e', code: '1', name: 'The First Chapter', released_at: '2023-08-18' },
  { id: 'set_142d2d', code: '2', name: 'Rise of the Floodborn', released_at: '2023-11-17' },
  { id: 'set_57c681', code: '13', name: 'Attack of the Vine!', released_at: '2026-07-17' },
  { id: 'set_aa11bb', code: 'D23', name: 'D23 Collection', released_at: '2024-08-09' },
  { id: 'set_cc22dd', code: 'cp', name: 'Challenge Promo', released_at: '2024-05-17' },
];
const write = (results, at = '2026-08-14T00:00:00.000Z') =>
  fs.writeFileSync(path.join(TMP, 'sets.json'), JSON.stringify({ at, body: { results } }));

before(() => write(SETS));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('isCompleteSetList — keyed on `results`, not Scryfall`s `data`', () => {
  it('an empty 200 from a re-indexing upstream is not a list', () => {
    assert.equal(isCompleteSetList({ results: [] }), false);
    assert.equal(isCompleteSetList(null), false);
    assert.equal(isCompleteSetList({}), false);
  });
  it('a body carrying `data` instead of `results` is NOT accepted', () => {
    // If this ever passes, the module has quietly been pointed at the wrong upstream shape and the
    // cache would store a body the builder's loadSets() cannot read.
    assert.equal(isCompleteSetList({ data: SETS }), false);
  });
  it('a populated results array is a list', () => {
    assert.equal(isCompleteSetList({ results: SETS }), true);
  });
});

describe('decideSetsResponse — a cached list beats a broken fetch', () => {
  const lastGood = { at: '2026-08-01T00:00:00.000Z', body: { results: SETS } };
  it('stores a complete fetch', () => {
    const d = decideSetsResponse({ results: SETS }, null, 'now');
    assert.equal(d.store, true);
    assert.equal(d.status, 200);
    assert.equal(d.body.stale, false);
    assert.equal(d.body.results.length, SETS.length);
  });
  it('serves the cached list, and does NOT overwrite it, when the fetch fails', () => {
    const d = decideSetsResponse(null, lastGood, 'now');
    assert.equal(d.store, false);
    assert.equal(d.status, 200);
    assert.equal(d.body.stale, true);
    assert.equal(d.body.cachedAt, lastGood.at);
    assert.equal(d.body.results.length, SETS.length);
  });
  it('an empty fetch never displaces a good cache', () => {
    const d = decideSetsResponse({ results: [] }, lastGood, 'now');
    assert.equal(d.store, false);
    assert.equal(d.body.results.length, SETS.length, 'the cached list, not the empty one');
  });
  it('nothing fetched and nothing cached is a 502, not an empty list dressed as success', () => {
    const d = decideSetsResponse(null, null, 'now');
    assert.equal(d.status, 502);
    assert.deepEqual(d.body.results, []);
  });
});

describe('findLorcanaSet', () => {
  it('resolves by code, including the mixed-case promo codes', () => {
    assert.equal(findLorcanaSet({ code: '1' }).name, 'The First Chapter');
    assert.equal(findLorcanaSet({ code: '13' }).name, 'Attack of the Vine!');
    assert.equal(findLorcanaSet({ code: 'D23' }).name, 'D23 Collection');
    assert.equal(findLorcanaSet({ code: 'd23' }).name, 'D23 Collection', 'case-insensitive');
    assert.equal(findLorcanaSet({ code: 'CP' }).name, 'Challenge Promo');
  });
  it('does not confuse set "1" with set "13"', () => {
    // Lorcana codes are bare numbers, so a prefix match instead of an exact one would seat the
    // wrong set — and with it the wrong set name on the listing.
    assert.equal(findLorcanaSet({ code: '1' }).code, '1');
    assert.equal(findLorcanaSet({ code: '3' }), null, 'there is no set 3 in this fixture');
  });
  it('resolves by name, and by a name carrying a code decoration', () => {
    assert.equal(findLorcanaSet({ name: 'Rise of the Floodborn' }).code, '2');
    assert.equal(findLorcanaSet({ name: 'Rise of the Floodborn (ROF)' }).code, '2');
  });
  it('matches a name through punctuation — "Attack of the Vine!" carries a bang', () => {
    assert.equal(findLorcanaSet({ name: 'Attack of the Vine' }).code, '13');
  });
  it('carries NO icon, because Lorcast publishes none', () => {
    // Deliberate: findMtgSet answers icon_svg_uri off the record, and the equivalent field simply
    // does not exist here. composeMetaFor must leave the rail symbol empty rather than build a URL
    // from the code (AGENTS.md 19's placeholder trap, GR4).
    const s = findLorcanaSet({ code: '1' });
    assert.equal(s.icon_svg_uri, undefined);
    assert.equal(s.icon, undefined);
  });
  it('an unknown set is null, not a throw (GR7)', () => {
    assert.equal(findLorcanaSet({ code: 'nope' }), null);
    assert.equal(findLorcanaSet({ name: 'No Such Set' }), null);
    assert.equal(findLorcanaSet({}), null);
    assert.equal(findLorcanaSet(), null);
  });
  it('re-indexes when the cache changes rather than serving a stale index', () => {
    write([...SETS, { id: 'set_zz', code: '14', name: 'Later Set', released_at: '2026-11-01' }], '2026-08-15T00:00:00.000Z');
    assert.equal(findLorcanaSet({ code: '14' }).name, 'Later Set');
    write(SETS);
  });
});

describe('listLorcanaSets — the shape the Collectr resolver indexes', () => {
  it('reports the CODE as the id, because that is what every other route takes', () => {
    // Lorcast's own `set_…` uuid would be an id the card route and identity_key cannot round-trip.
    const list = listLorcanaSets();
    assert.equal(list.length, SETS.length);
    assert.ok(list.every((s) => !String(s.id).startsWith('set_')), 'never the uuid');
    const first = list.find((s) => s.code === '13');
    assert.deepEqual(first, { id: '13', name: 'Attack of the Vine!', code: '13', releaseDate: '2026-07-17' });
  });
  it('is newest first', () => {
    const list = listLorcanaSets();
    assert.equal(list[0].code, '13');
    assert.deepEqual(list.map((s) => s.releaseDate), [...list.map((s) => s.releaseDate)].sort().reverse());
  });
  it('drops a set with no code — it could not be looked up anyway', () => {
    write([...SETS, { id: 'set_nocode', name: 'Codeless' }], '2026-08-16T00:00:00.000Z');
    assert.ok(!listLorcanaSets().some((s) => s.name === 'Codeless'));
    write(SETS);
  });
});

describe('a cold cache', () => {
  it('returns null / empty rather than throwing — no set means no set art, not a failed listing', () => {
    const keep = process.env.LORCANA_SETS_CACHE_DIR;
    process.env.LORCANA_SETS_CACHE_DIR = path.join(TMP, 'does-not-exist');
    try {
      assert.equal(readCache(), null);
      assert.equal(findLorcanaSet({ code: '1' }), null);
      assert.deepEqual(listLorcanaSets(), []);
    } finally { process.env.LORCANA_SETS_CACHE_DIR = keep; }
  });
});
