// test/unit/pkm-cards-cache.test.mjs — the set-card cache that made picking a set instant.
//
// /api/pkm was a bare proxy: every set pick paged pokemontcg.io live, in every browser, from a
// source that intermittently 500s — and the batch runner re-fetched even when it already held the
// set. A released set's card list never changes, so this cache keeps it forever and only goes
// upstream when someone presses ↻.
//
// Caching forever raises the stakes on WHAT gets cached: an empty or half-fetched set written to
// disk would never expire on its own. That is what most of this file is about.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A throwaway cache folder, set before the module is imported: this cache never expires, so a test
// fixture written into the real one would still be there next month.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-cards-unit-'));
process.env.PKM_CARDS_CACHE_DIR = DIR;
const { isSetId, trimCard, isCompleteSet, decideCardsResponse, readSetCache, writeSetCache, hasDuplicateCards } = await import('../../lib/pkm-cards-cache.mjs');

const NOW = '2026-08-03T00:00:00.000Z';
const card = (n) => ({
  id: 'obf-' + n, name: 'Card ' + n, number: String(n), rarity: 'Common', artist: 'A',
  supertype: 'Pokémon', subtypes: ['Basic'], types: ['Water'], hp: 60,
  images: { small: 's.png', large: 'l.png' },
  set: { id: 'obf', name: 'Obsidian Flames', series: 'SV', ptcgoCode: 'OBF', releaseDate: '2023/08/11', printedTotal: 197, total: 230 },
  tcgplayer: { url: 'x', updatedAt: 'y', prices: { holofoil: { low: 1, mid: 2, high: 9, market: 3, directLow: 4 } } },
  attacks: [{ name: 'Splash', text: 'A very long string nobody here reads' }],
  weaknesses: [{ type: 'Grass', value: '×2' }], legalities: { standard: 'Legal' },
});

describe('isSetId — the id becomes a filename, so it is whitelisted', () => {
  it('accepts real pokemontcg.io ids', () => {
    for (const id of ['obf', 'sv3', 'base1', 'sm35', 'swshp', 'xy7']) assert.equal(isSetId(id), true, id);
  });
  it('refuses anything that could escape the cache directory', () => {
    for (const bad of ['../secrets', 'a/b', '..', '', null, 'x'.repeat(64), 'set id', 'sv3\t', 'sv3\n', '.hidden']) {
      assert.equal(isSetId(bad), false, JSON.stringify(bad));
    }
  });
});

describe('trimCard — what crosses the wire', () => {
  it('keeps every field the pickers read', () => {
    const t = trimCard(card(1));
    assert.equal(t.id, 'obf-1');
    assert.equal(t.name, 'Card 1');
    assert.equal(t.number, '1');
    assert.equal(t.hp, '60', 'stringified, because the builders concatenate it');
    assert.equal(t.set.printedTotal, 197, 'Golden Rule 10 needs this to print 200/197');
    assert.equal(t.images.small, 's.png');
    assert.deepEqual(t.tcgplayer.prices.holofoil, { market: 3, mid: 2, low: 1 });
  });
  it('drops the bulk that no picker has ever read', () => {
    const t = trimCard(card(1));
    for (const k of ['attacks', 'weaknesses', 'legalities']) assert.equal(t[k], undefined, k + ' should not cross the wire');
    assert.equal(t.tcgplayer.prices.holofoil.directLow, undefined);
  });
  it('survives a card with no prices and no images', () => {
    const t = trimCard({ id: 'x', name: 'X', number: '1' });
    assert.equal(t.tcgplayer, null);
    assert.deepEqual(t.images, { small: '', large: '' });
    assert.deepEqual(t.set, {});
  });
});

describe('isCompleteSet — only a whole set is worth keeping forever', () => {
  it('a full set is complete', () => assert.equal(isCompleteSet([card(1), card(2)], 2), true));
  it('more than upstream claims is still complete', () => assert.equal(isCompleteSet([card(1), card(2)], 1), true));
  it('a truncated fetch is not', () => assert.equal(isCompleteSet([card(1)], 197), false, 'half a set, cached forever, is the bad outcome'));
  it('an empty answer is not', () => {
    assert.equal(isCompleteSet([], 197), false);
    assert.equal(isCompleteSet(null, 197), false);
  });
  it('no totalCount at all: trust what arrived', () => assert.equal(isCompleteSet([card(1)], undefined), true));

  // THE regression this whole check exists for, and the one it originally missed. Measured
  // 2026-08-23 on me2pt5 (Ascended Heroes, 295 cards): `orderBy=number` made page 2 re-serve 45
  // rows already on page 1. The fetch was 295 rows long — exactly totalCount — so a row count said
  // "complete" and it went into a cache that never expires, holding 250 unique cards, 45 duplicates,
  // and nothing above #250. Every card past 250 was unlistable and the set looked fine.
  it('rejects a batch padded out to the right LENGTH by duplicates', () => {
    const dupes = [...Array.from({ length: 250 }, (_, i) => card(i + 1)), ...Array.from({ length: 45 }, (_, i) => card(i + 1))];
    assert.equal(dupes.length, 295, 'the row count alone looks complete');
    assert.equal(isCompleteSet(dupes, 295), false, 'and it is 45 cards short');
  });

  it('counts distinct cards by id, so two printings of one number still count twice', () => {
    const a = { ...card(1), id: 'x-1' }, b = { ...card(1), id: 'x-1a' };
    assert.equal(isCompleteSet([a, b], 2), true);
  });
});

describe('decideCardsResponse', () => {
  const cached = { at: '2026-01-01T00:00:00.000Z', cards: [card(9)] };

  it('a complete fetch is served and stored', () => {
    const d = decideCardsResponse({ cards: [card(1), card(2)], totalCount: 2 }, null, NOW);
    assert.equal(d.store, true);
    assert.equal(d.source, 'upstream');
    assert.equal(d.cards.length, 2);
  });

  it('upstream down + a copy on disk: serve the copy, flagged, and never overwrite it', () => {
    const d = decideCardsResponse(null, cached, NOW);
    assert.equal(d.store, false, 'the stored copy is the good one — do not write over it');
    assert.equal(d.stale, true);
    assert.equal(d.at, cached.at, 'the age reported is the copy’s, not now');
    assert.equal(d.cards[0].id, 'obf-9');
  });

  it('a TRUNCATED fetch never replaces a good copy', () => {
    const d = decideCardsResponse({ cards: [card(1)], totalCount: 197 }, cached, NOW);
    assert.equal(d.store, false);
    assert.equal(d.source, 'disk');
    assert.equal(d.cards[0].id, 'obf-9', 'the whole set beats a fragment of it');
  });

  it('a truncated fetch with nothing cached is shown but not stored', () => {
    const d = decideCardsResponse({ cards: [card(1)], totalCount: 197 }, null, NOW);
    assert.equal(d.store, false, 'a permanent cache must never learn half a set');
    assert.equal(d.partial, true);
    assert.equal(d.status, 200, 'something to work with beats nothing');
  });

  it('nothing anywhere is a 502 that says so, not an empty 200', () => {
    const d = decideCardsResponse(null, null, NOW);
    assert.equal(d.status, 502);
    assert.equal(d.cards, null);
  });

  it('an empty 200 from a re-indexing upstream is treated as no answer at all', () => {
    const d = decideCardsResponse({ cards: [], totalCount: 0 }, cached, NOW);
    assert.equal(d.source, 'disk');
    assert.equal(d.stale, true);
  });
});

describe('the disk cache round trip', () => {
  const ids = ['zzztest1', 'zzztest2'];
  const clean = () => { for (const id of ids) { try { fs.unlinkSync(path.join(DIR, id + '.json')); } catch {} } };
  before(clean); beforeEach(clean);
  after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

  it('writes and reads back the RAW cards', () => {
    assert.equal(writeSetCache('zzztest1', NOW, [card(1), card(2)]), true);
    const back = readSetCache('zzztest1');
    assert.equal(back.count, 2);
    assert.equal(back.at, NOW);
    assert.ok(back.cards[0].attacks, 'raw on disk: a shape change costs a re-serve, never a re-fetch');
  });

  it('a missing set reads back as null rather than throwing', () => {
    assert.equal(readSetCache('zzztest2'), null);
  });

  it('refuses to read or write a set id that is not one', () => {
    assert.equal(writeSetCache('../escape', NOW, [card(1)]), false);
    assert.equal(readSetCache('../escape'), null);
  });

  it('an empty file is treated as no cache, not as an empty set', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'zzztest2.json'), JSON.stringify({ v: 1, setId: 'zzztest2', at: NOW, count: 0, cards: [] }));
    assert.equal(readSetCache('zzztest2'), null, 'otherwise a bad write blanks the picker forever');
  });

  it('a corrupt file is treated as no cache', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'zzztest2.json'), '{"v":1,"cards":[{"id"');
    assert.equal(readSetCache('zzztest2'), null);
  });
});

// The cache never expires, so a copy written before the paging fix would be served forever. This is
// how getSetCards notices one and goes upstream instead of waiting to be told.
describe('hasDuplicateCards — the self-heal for a pre-fix cached copy', () => {
  it('a real set has no repeated card id', () => {
    assert.equal(hasDuplicateCards([{ id: 'me2pt5-1' }, { id: 'me2pt5-2' }]), false);
  });
  it('spots the duplicate-inflated shape', () => {
    assert.equal(hasDuplicateCards([{ id: 'me2pt5-1' }, { id: 'me2pt5-2' }, { id: 'me2pt5-1' }]), true);
  });
  it('falls back to the number when a row carries no id', () => {
    assert.equal(hasDuplicateCards([{ number: '7' }, { number: '7' }]), true);
    assert.equal(hasDuplicateCards([{ number: '7' }, { number: '8' }]), false);
  });
  it('empty and junk are not duplicates', () => {
    assert.equal(hasDuplicateCards([]), false);
    assert.equal(hasDuplicateCards(null), false);
  });
});
