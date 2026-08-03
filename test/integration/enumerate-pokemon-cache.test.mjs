// test/integration/enumerate-pokemon-cache.test.mjs — the bulk builder reads the shared set cache.
//
// ENUMERATORS.pokemon used to page pokemontcg.io itself, through the proxy, every time a set was
// enumerated — the same live-fetch-every-time the batch runner had, and worse here: working through
// a shelf meant doing it per set, against a source that regularly answers 500. It now reads
// lib/pkm-cards-cache.mjs in-process, so the first set anyone loads anywhere serves everyone.
//
// What must NOT change is the rows. The cache stores the RAW upstream card, so every field the
// enumerator reads is still there — that is the thing worth pinning.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A throwaway cache folder, set before the module is imported — see the note in the route test.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-enum-cache-'));
process.env.PKM_CARDS_CACHE_DIR = DIR;
const { ENUMERATORS } = await import('../../lib/enumerate.mjs');

const ID = 'zzzenum1';
const realFetch = globalThis.fetch;

const card = (n, over = {}) => Object.assign({
  id: ID + '-' + n, name: 'Card ' + n, number: String(n), rarity: 'Rare Holo',
  images: { small: 's.png', large: 'l.png' },
  set: { id: ID, name: 'Enum Set', series: 'SV', ptcgoCode: 'ZZZ', releaseDate: '2023/08/11', printedTotal: 197 },
  tcgplayer: { prices: { normal: { market: 1.5, mid: 1.6 }, reverseHolofoil: { market: 4, mid: 4.2 } } },
}, over);

function stubUpstream(total, { fail = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (fail) return { ok: false, status: 500, text: async () => 'no' };
    const page = Number(new URL(String(url)).searchParams.get('page') || 1);
    const data = [];
    for (let i = (page - 1) * 250; i < Math.min(page * 250, total); i++) data.push(card(i + 1));
    return { ok: true, status: 200, text: async () => JSON.stringify({ data, totalCount: total }) };
  };
  return calls;
}
async function drain(opts) {
  const rows = [], warnings = [];
  for await (const out of ENUMERATORS.pokemon(Object.assign({ env: {}, setId: ID, setName: 'Enum Set' }, opts))) {
    if (out.warning) warnings.push(out.warning); else rows.push(out.row);
  }
  return { rows, warnings };
}

const clean = () => { try { fs.unlinkSync(path.join(DIR, ID + '.json')); } catch {} };
before(clean);
after(() => { globalThis.fetch = realFetch; try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
beforeEach(clean);

describe('ENUMERATORS.pokemon — through the cache', () => {
  it('enumerates one row per card × printing, unchanged by where the cards came from', async () => {
    stubUpstream(2);
    const { rows, warnings } = await drain();
    assert.deepEqual(warnings, []);
    assert.equal(rows.length, 4, '2 cards × 2 price keys');
    const r = rows[0];
    assert.equal(r.game, 'pokemon');
    assert.equal(r.identity_key, ID + '-1');
    assert.equal(r.set_name, 'Enum Set');
    assert.equal(r.number, '001/197', 'Golden Rule 10 still pads this era, because the card does');
    assert.equal(r.market_usd, 1.5);
    assert.equal(r.image, 'l.png', 'the large art, the way imageFrom picks it');
    assert.deepEqual(rows.map((x) => x.printing_key), ['normal', 'reverseHolofoil', 'normal', 'reverseHolofoil']);
  });

  it('the SECOND enumeration of a set costs nothing upstream', async () => {
    stubUpstream(3);
    await drain();
    const calls = stubUpstream(3);
    const { rows } = await drain();
    assert.equal(calls.length, 0, 'this is the whole change');
    assert.equal(rows.length, 6);
  });

  it('works with pokemontcg.io down, once the set has been seen once', async () => {
    stubUpstream(2);
    await drain();
    stubUpstream(0, { fail: true });
    const { rows, warnings } = await drain();
    assert.equal(rows.length, 4, 'a shelf of sets does not stop because upstream is having a minute');
    assert.deepEqual(warnings, [], 'nothing to warn about — the copy is the good one');
  });

  it('a cold set with a dead upstream warns and yields nothing, rather than throwing', async () => {
    stubUpstream(0, { fail: true });
    const { rows, warnings } = await drain();
    assert.equal(rows.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no cards available/);
  });

  it('honours the rarity filter', async () => {
    stubUpstream(2);
    const { rows } = await drain({ filters: { rarities: ['common'] } });
    assert.equal(rows.length, 0, 'every card here is Rare Holo');
  });
});
