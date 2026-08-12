// test/integration/enumerate-mtg.test.mjs — the bulk builder's Magic enumerator.
//
// ENUMERATORS gained an mtg entry so POST /api/bulk/enumerate stops 400ing for Magic. It reads
// lib/mtg-cards-cache.mjs in-process, the same stored set the batch runner loads, so enumerating a
// set someone has already opened costs nothing.
//
// The rows are what matter, and Magic's differ from Pokémon's in three ways that are easy to get
// wrong and silent when you do: the printing matrix is `finishes[]` and not the price keys, the
// collector number goes through verbatim, and the language comes off the print.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A throwaway cache folder, set before the module is imported.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-enum-mtg-'));
process.env.MTG_CARDS_CACHE_DIR = DIR;
const { ENUMERATORS } = await import('../../lib/enumerate.mjs');

const SET = 'zzzmtg1';
const realFetch = globalThis.fetch;

const print = (n, over = {}) => Object.assign({
  id: 'uuid-' + n, name: 'Card ' + n, collector_number: String(n), rarity: 'rare',
  artist: 'Someone', lang: 'en', released_at: '2022-02-18', type_line: 'Creature — Dragon',
  colors: ['R'], finishes: ['nonfoil', 'foil'], promo_types: [], promo: false,
  frame_effects: [], border_color: 'black', full_art: false,
  set: SET, set_name: 'Enum Magic Set',
  image_uris: { small: 's.jpg', normal: 'n.jpg', large: 'l.jpg' },
  prices: { usd: '1.50', usd_foil: '6.00', usd_etched: null },
}, over);

function stub(cards) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ total_cards: cards.length, has_more: false, next_page: null, data: cards }),
  });
}
async function collect(opts = {}) {
  const rows = [], warnings = [];
  for await (const out of ENUMERATORS.mtg(Object.assign({ setId: SET, setName: 'Enum Magic Set' }, opts))) {
    if (out.warning) warnings.push(out.warning); else rows.push(out.row);
  }
  return { rows, warnings };
}

before(() => {});
after(() => { globalThis.fetch = realFetch; try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
beforeEach(() => { try { fs.unlinkSync(path.join(DIR, SET + '.json')); } catch {} });

describe('ENUMERATORS.mtg', () => {
  it('yields one row per (card × finish), not one per card', () => {
    stub([print(1), print(2)]);
    return collect().then(({ rows, warnings }) => {
      assert.deepEqual(warnings, []);
      assert.equal(rows.length, 4, 'two prints, two finishes each');
      assert.deepEqual(rows.map((r) => r.printing_key), ['nonfoil', 'foil', 'nonfoil', 'foil']);
      assert.deepEqual(rows.map((r) => r.variant), ['Base', 'Foil', 'Base', 'Foil']);
      assert.deepEqual(rows.map((r) => r.market_usd), [1.5, 6, 1.5, 6]);
    });
  });

  it('the row carries what the publish path reads back', async () => {
    stub([print(7)]);
    const { rows } = await collect();
    const r = rows[0];
    assert.equal(r.game, 'mtg');
    assert.equal(r.identity_key, SET + '-7', 'set-collector_number, which resolveMtgCard can parse');
    assert.equal(r.set_name, 'Enum Magic Set (ZZZMTG1)', 'the (CODE) suffix the mtg title parts read');
    assert.equal(r.rarity, 'Rare');
    assert.equal(r.image, 'l.jpg', 'imageFrom("mtg") takes the largest art — this is the listing image');
    assert.equal(r.market_source, 'scryfall');
    // The names buildRowIn falls back to when the Scryfall cache is cold.
    assert.equal(r.colour, 'Red');
    assert.equal(r.card_type, 'Creature — Dragon');
    assert.equal(r.treatment, 'Normal');
    assert.equal(r.illustrator, 'Someone');
    assert.equal(r.set_release_date, '2022-02-18');
  });

  // GR10. Run through the Pokémon formatter, '1' comes out '001/531' — a number that is not on the
  // card, and buyers search the exact printed string.
  it('the collector number goes through verbatim', async () => {
    stub([print(1), print(417), print('12a')]);
    const { rows } = await collect();
    assert.deepEqual([...new Set(rows.map((r) => r.number))], ['1', '417', '12a']);
  });

  // NEO ships 10 Japanese and 4 Phyrexian prints. Listing one as English is an INAD exposure.
  it('the language comes off the print, never assumed EN', async () => {
    stub([print(1), print(293, { lang: 'ja' }), print(300, { lang: 'dw' })]);
    const { rows } = await collect();
    assert.equal(rows.find((r) => r.number === '293').language, 'JP');
    assert.equal(rows.find((r) => r.number === '300').language, 'DW');
    assert.equal(rows.find((r) => r.number === '1').language, 'EN');
  });

  it('an etched print prices off usd_etched and keeps its own variant', async () => {
    stub([print(417, { finishes: ['etched'], prices: { usd: null, usd_foil: '3.00', usd_etched: '35.85' } })]);
    const { rows } = await collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].variant, 'Etched Foil');
    assert.equal(rows[0].market_usd, 35.85);
  });

  // Scryfall reports the PLAIN foil figure for a surge print, which is several times off.
  it('a surge foil is its own product and carries no market figure', async () => {
    stub([print(53, { finishes: ['foil'], promo_types: ['surgefoil'], prices: { usd: null, usd_foil: '50.00', usd_etched: null } })]);
    const { rows } = await collect();
    assert.equal(rows[0].printing_key, 'surgefoil');
    assert.equal(rows[0].variant, 'Surge Foil');
    assert.equal(rows[0].market_usd, null);
    assert.equal(rows[0].market_source, null);
  });

  it('reads the stored set — a second enumeration costs nothing upstream', async () => {
    stub([print(1)]);
    await collect();
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('should not be called'); };
    const { rows } = await collect();
    assert.equal(rows.length, 2);
    assert.equal(calls, 0);
  });

  // GR7: a failure yields a warning record and partial rows, never a throw.
  it('degrades to a warning when Scryfall is down and nothing is cached', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'no' });
    const { rows, warnings } = await collect();
    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no cards available/);
  });

  it('the rarity filter still applies', async () => {
    stub([print(1, { rarity: 'common' }), print(2, { rarity: 'mythic' })]);
    const { rows } = await collect({ filters: { rarities: ['rare_plus'] } });
    assert.deepEqual([...new Set(rows.map((r) => r.number))], ['2'], 'mythic classes as rare_plus');
  });
});
