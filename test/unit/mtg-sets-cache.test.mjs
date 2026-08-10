// test/unit/mtg-sets-cache.test.mjs — Magic's set list cache.
//
// /api/mtg/sets was a bare Scryfall pass-through, so nothing server-side could read the set list at
// all — which is why the Collectr importer had no Magic branch and every Magic row failed to
// resolve. Pure decisions and the sync lookups are covered here; the plugin itself is exercised by
// the integration suite.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-sets-'));
process.env.MTG_SETS_CACHE_DIR = TMP;   // set BEFORE the import — the module reads it per call

const { isCompleteSetList, decideSetsResponse, findMtgSet, listMtgSets, readCache } =
  await import('../../lib/mtg-sets-cache.mjs');

const SETS = [
  { code: 'hob', name: 'The Hobbit', digital: false, icon_svg_uri: 'https://svgs.scryfall.io/sets/hob.svg', set_type: 'expansion' },
  { code: 'hoc', name: 'The Hobbit Eternal', digital: false, icon_svg_uri: 'https://svgs.scryfall.io/sets/hoc.svg', parent_set_code: 'hob' },
  { code: 'ltr', name: 'The Lord of the Rings: Tales of Middle-earth', digital: false, icon_svg_uri: 'https://svgs.scryfall.io/sets/ltr.svg' },
  { code: 'yhob', name: 'The Hobbit', digital: true, icon_svg_uri: 'https://svgs.scryfall.io/sets/yhob.svg' },
];
const write = (data, at = '2026-08-10T00:00:00.000Z') =>
  fs.writeFileSync(path.join(TMP, 'sets.json'), JSON.stringify({ at, body: { object: 'list', has_more: false, data } }));

before(() => write(SETS));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('isCompleteSetList — never cache a half-walked list', () => {
  it('a body still claiming more pages is a SHORT WALK, not a list', () => {
    assert.equal(isCompleteSetList({ data: [{ code: 'hob' }], has_more: true }), false);
  });
  it('an empty 200 from a re-indexing upstream is not a list either', () => {
    assert.equal(isCompleteSetList({ data: [], has_more: false }), false);
    assert.equal(isCompleteSetList(null), false);
    assert.equal(isCompleteSetList({}), false);
  });
  it('a full page is', () => {
    assert.equal(isCompleteSetList({ data: [{ code: 'hob' }], has_more: false }), true);
  });
});

describe('decideSetsResponse — a cached list beats a broken fetch', () => {
  const lastGood = { at: '2026-08-01T00:00:00.000Z', body: { data: SETS } };
  it('stores a complete fetch', () => {
    const d = decideSetsResponse({ data: SETS, has_more: false }, null, 'now');
    assert.equal(d.store, true);
    assert.equal(d.status, 200);
    assert.equal(d.body.stale, false);
  });
  it('serves the cached list, and does NOT overwrite it, when the fetch fails', () => {
    const d = decideSetsResponse(null, lastGood, 'now');
    assert.equal(d.store, false);
    assert.equal(d.status, 200);
    assert.equal(d.body.stale, true);
    assert.equal(d.body.cachedAt, lastGood.at);
  });
  it('a truncated fetch never displaces a good cache', () => {
    const d = decideSetsResponse({ data: [SETS[0]], has_more: true }, lastGood, 'now');
    assert.equal(d.store, false);
    assert.equal(d.body.data.length, SETS.length, 'the cached list, not the short one');
  });
  it('nothing fetched and nothing cached is a 502, not an empty list dressed as success', () => {
    const d = decideSetsResponse(null, null, 'now');
    assert.equal(d.status, 502);
    assert.deepEqual(d.body.data, []);
  });
});

describe('findMtgSet', () => {
  it('resolves by code', () => {
    assert.equal(findMtgSet({ code: 'hob' }).name, 'The Hobbit');
    assert.equal(findMtgSet({ code: 'HOB' }).name, 'The Hobbit', 'case-insensitive');
  });
  it('resolves by name, and by the name the builder stores with its code decoration', () => {
    assert.equal(findMtgSet({ name: 'The Hobbit Eternal' }).code, 'hoc');
    assert.equal(findMtgSet({ name: 'The Hobbit Eternal (HOC)' }).code, 'hoc');
  });
  it('carries the icon — and it comes off the RECORD, never built from the code', () => {
    assert.equal(findMtgSet({ code: 'hob' }).icon_svg_uri, 'https://svgs.scryfall.io/sets/hob.svg');
  });
  it('never returns a digital set — you cannot post an Arena card', () => {
    // 'yhob' shares its NAME with paper 'hob'; the name lookup must not seat the digital one.
    assert.equal(findMtgSet({ code: 'yhob' }), null);
    assert.equal(findMtgSet({ name: 'The Hobbit' }).code, 'hob');
  });
  it('an unknown set is null, not a throw (GR7)', () => {
    assert.equal(findMtgSet({ code: 'nope' }), null);
    assert.equal(findMtgSet({ name: 'No Such Set' }), null);
    assert.equal(findMtgSet({}), null);
    assert.equal(findMtgSet(), null);
  });
  it('re-indexes when the cache changes rather than serving a stale index', () => {
    write([...SETS, { code: 'zzz', name: 'Later Set', digital: false }], '2026-08-11T00:00:00.000Z');
    assert.equal(findMtgSet({ code: 'zzz' }).name, 'Later Set');
    write(SETS);
  });
});

describe('listMtgSets — the shape the Collectr resolver indexes', () => {
  it('is {id,name,code} with the digital ones dropped', () => {
    const list = listMtgSets();
    assert.equal(list.length, 3);
    assert.deepEqual(list[0], { id: 'hob', name: 'The Hobbit', code: 'HOB' });
    assert.ok(!list.some((s) => s.id === 'yhob'));
  });
});

describe('a cold cache', () => {
  it('returns null / empty rather than throwing — no set means no symbol, not a failed listing', () => {
    const keep = process.env.MTG_SETS_CACHE_DIR;
    process.env.MTG_SETS_CACHE_DIR = path.join(TMP, 'does-not-exist');
    try {
      assert.equal(readCache(), null);
      assert.equal(findMtgSet({ code: 'hob' }), null);
      assert.deepEqual(listMtgSets(), []);
    } finally { process.env.MTG_SETS_CACHE_DIR = keep; }
  });
});
