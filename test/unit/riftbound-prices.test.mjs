// test/unit/riftbound-prices.test.mjs — the keyless Riftbound price lane.
//
// Scrydex was the ONLY Riftbound price source and its subscription lapsed (402
// SUBSCRIPTION_INACTIVE). Because 100% of the tracker watchlist is Riftbound, price_snapshots had
// never accrued a row for ANY game. This lane replaces it with TCGplayer's public search API.
//
// The load-bearing fact under test: TCGplayer's `customAttributes.number` uses EXACTLY this repo's
// normNum() shape, so a watchlist identity_key maps onto a product with no name matching —
// which matters because the offline bake writes "Darius, Trifarian" and TCGplayer writes
// "Darius - Trifarian". Every fixture below is real upstream data (2026-07-30).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexRows, codeBySetName, resolveSetCode, isPromoSet } from '../../scripts/build-riftbound-prices.mjs';
import { priceFor } from '../../lib/riftbound-prices.mjs';
import { mapPrice, pricePath, lookupPath } from '../../lib/normalize.mjs';

const row = (o) => ({ productName: '', setName: 'Origins', number: '', rarity: '', market: 1, low: null, listings: 1, ...o });

// The set-name -> code join is DERIVED from data/riftbound.json, which is gitignored. Pin a fixture
// here so these tests describe the mapping rather than whatever happens to be baked on this machine.
const SETS = [
  { id: 'ogn', code: 'OGN', name: 'Origins' },
  { id: 'ogs', code: 'OGS', name: 'Proving Grounds' },
  { id: 'sfd', code: 'SFD', name: 'Spiritforged' },
  { id: 'unl', code: 'UNL', name: 'Unleashed' },
  { id: 'ven', code: 'VEN', name: 'Vendetta' },
];
const BY_NAME = codeBySetName(SETS);
const idx = (rows) => indexRows(rows, BY_NAME);

describe('indexRows — identity_key mapping', () => {
  it('maps a base print and its Alternate Art to DIFFERENT keys (the 027 / 027a split)', () => {
    const { cards } = idx([
      row({ productName: 'Darius - Trifarian', number: '027/298', rarity: 'Rare', market: 1.63 }),
      row({ productName: 'Darius - Trifarian (Alternate Art)', number: '027a/298', rarity: 'Showcase', market: 7.02 }),
    ]);
    assert.equal(cards['OGN-27'].market, 1.63);
    assert.equal(cards['OGN-27a'].market, 7.02);      // the watchlist key
  });
  it('keeps the Signature * suffix distinct from the plain number', () => {
    const { cards } = idx([
      row({ setName: 'Spiritforged', productName: 'Darius - Executioner (Overnumbered)', number: '236/221', market: 41.12 }),
      row({ setName: 'Spiritforged', productName: 'Darius - Executioner (Signature)', number: '236*/221', market: 299.3 }),
    ]);
    assert.equal(cards['SFD-236'].market, 41.12);
    assert.equal(cards['SFD-236*'].market, 299.3);
  });
  it('maps every catalogued set code, including the one whose name differs from the bake', () => {
    const { cards } = idx([
      row({ setName: 'Origins', number: '001/298' }),
      row({ setName: 'Origins: Proving Grounds', number: '001/024' }),   // bake calls it "Proving Grounds"
      row({ setName: 'Spiritforged', number: '001/221' }),
      row({ setName: 'Unleashed', number: '001/200' }),
      row({ setName: 'Vendetta', number: '001/166' }),
    ]);
    assert.deepEqual(Object.keys(cards).sort(), ['OGN-1', 'OGS-1', 'SFD-1', 'UNL-1', 'VEN-1']);
  });
  it("indexes Vendetta's SP##/### showcase promos under the key the catalog bakes them at", () => {
    const { cards, dropped } = idx([
      row({ setName: 'Vendetta', productName: "Kai'Sa - Survivor", number: 'SP1/006', rarity: 'Showcase', market: 71.21 }),
      row({ setName: 'Vendetta', productName: 'Ahri - Inquisitive', number: 'SP3/006', rarity: 'Showcase', market: 71.18 }),
    ]);
    assert.equal(cards['VEN-sp1'].market, 71.21);
    assert.equal(cards['VEN-sp3'].market, 71.18);
    assert.equal(dropped.special, 0, 'SP numbering used to be dropped outright');
  });
});

describe('the setName -> code join (derived, not hardcoded)', () => {
  it("aliases TCGplayer's one divergent set name onto the baked one", () => {
    // TCGplayer says "Origins: Proving Grounds"; Riot's gallery says "Proving Grounds".
    assert.equal(resolveSetCode('Origins: Proving Grounds', BY_NAME), 'OGS');
    assert.equal(resolveSetCode('Proving Grounds', BY_NAME), 'OGS');
  });
  it('joins a brand-new set with no code change — the whole point of deriving it', () => {
    const withNew = codeBySetName([...SETS, { id: 'xyz', code: 'XYZ', name: 'Some Future Set' }]);
    assert.equal(resolveSetCode('Some Future Set', withNew), 'XYZ');
    const { cards } = indexRows([row({ setName: 'Some Future Set', number: '007/180', market: 3 })], withNew);
    assert.equal(cards['XYZ-7'].market, 3);
  });
  it('is case- and whitespace-insensitive on both sides', () => {
    assert.equal(resolveSetCode('  vENDETTA ', BY_NAME), 'VEN');
  });
  it('names every promo set it denies, and denies nothing else', () => {
    for (const n of ['Riftbound Organized Play Promotional Cards', 'Riftbound Promotional Cards',
      'Riftbound Judge Promotional Cards', 'Some Future Promotional Cards']) {
      assert.equal(isPromoSet(n), true, n);
    }
    for (const n of ['Origins', 'Vendetta', 'Origins: Proving Grounds', '']) {
      assert.equal(isPromoSet(n), false, n);
    }
  });
  it('an unrecognised NON-promo set is surfaced, not silently indexed or mislabelled a promo', () => {
    // This is what "TCGplayer listed the set before Riot's gallery did" looks like. Silence here
    // would read as full coverage while a whole set was missing from the price index.
    const { cards, dropped } = idx([row({ setName: 'Brand New Set', number: '001/200', market: 5 })]);
    assert.deepEqual(cards, {});
    assert.equal(dropped.unknownSet['Brand New Set'], 1);
    assert.deepEqual(dropped.promoSet, {});
  });
  it('falls back to the seed roster when the catalog is missing, rather than emptying the join', () => {
    // data/riftbound.json is gitignored and baked ~60s after boot. An empty join would index
    // nothing, throw "no prices indexed", and wipe the only price lane the tracker has.
    const seeded = codeBySetName([]);
    assert.equal(resolveSetCode('Origins', seeded), 'OGN');
    assert.equal(resolveSetCode('Vendetta', seeded), 'VEN');
    assert.equal(resolveSetCode('Origins: Proving Grounds', seeded), 'OGS');
  });
});

describe('indexRows — what it refuses to index, and why', () => {
  it('drops promo sets (no identity_key addresses them, and their numbers collide)', () => {
    const { cards, dropped } = idx([
      row({ setName: 'Riftbound Organized Play Promotional Cards', productName: 'Darius - Hand of Noxus', number: '253/298' }),
      row({ setName: 'Riftbound Organized Play Promotional Cards', productName: 'Darius - Hand of Noxus (Metal) (Best Of)', number: '253/298' }),
    ]);
    assert.deepEqual(cards, {});
    assert.equal(dropped.promoSet['Riftbound Organized Play Promotional Cards'], 2);
  });
  it('drops sealed product, which has no collector number at all', () => {
    const { cards, dropped } = idx([row({ productName: 'Origins - Booster Display', number: '', market: 306.1 })]);
    assert.deepEqual(cards, {});
    assert.equal(dropped.sealed, 1);
  });
  it('drops rune reprints and tokens — neither is in the identity space', () => {
    const { dropped } = idx([
      row({ setName: 'Spiritforged', productName: 'Mind Rune', number: 'R03' }),
      row({ setName: 'Spiritforged', productName: 'Fury Rune (Alternate Art)', number: 'R01a' }),
      row({ setName: 'Spiritforged', productName: 'Sand Soldier // Buff', number: 'T02' }),
    ]);
    assert.equal(dropped.rune, 2);
    assert.equal(dropped.token, 1);
  });
  it('drops a real card that simply has no market price yet (newest set, no sales)', () => {
    const { cards, dropped } = idx([
      row({ setName: 'Vendetta', productName: 'Shen - Leader of the Kinkou Order (Alternate Art)', number: '138a/166', market: null }),
    ]);
    assert.deepEqual(cards, {});
    assert.equal(dropped.unpriced, 1);
  });
  it('on a same-key collision it keeps the BASE print, never the tagged one', () => {
    // Attaching a Signature's $509 to an ordinary card would silently corrupt a price history.
    const tagFirst = idx([
      row({ productName: 'Card (Signature)', number: '005/298', market: 509 }),
      row({ productName: 'Card', number: '005/298', market: 1.2 }),
    ]);
    const plainFirst = idx([
      row({ productName: 'Card', number: '005/298', market: 1.2 }),
      row({ productName: 'Card (Signature)', number: '005/298', market: 509 }),
    ]);
    assert.equal(tagFirst.cards['OGN-5'].market, 1.2, 'base print must win regardless of row order');
    assert.equal(plainFirst.cards['OGN-5'].market, 1.2);
    assert.equal(tagFirst.collisions, 1);
  });
});

describe('priceFor — identity_key lookup', () => {
  const data = { cards: { 'OGN-27a': { market: 7.02, currency: 'USD' } } };
  it('resolves the exact key', () => assert.equal(priceFor('OGN-27a', data).market, 7.02));
  it('is case-tolerant on both halves (keys are UPPER set + lower normNum)', () => {
    assert.equal(priceFor('ogn-27A', data).market, 7.02);
    assert.equal(priceFor('OGN-27A', data).market, 7.02);
  });
  it('returns null rather than guessing', () => {
    assert.equal(priceFor('OGN-27', data), null);      // base print is a DIFFERENT card
    assert.equal(priceFor('', data), null);
    assert.equal(priceFor('nonsense', data), null);
    assert.equal(priceFor('OGN-27a', null), null);     // index never baked
  });
});

describe('mapPrice(riftbound) — both provider shapes', () => {
  it('maps the flat keyless TCGplayer row', () => {
    const p = mapPrice('riftbound', { market: 7.02, low: 4.5, currency: 'USD', source: 'tcgplayer' }, 'Foil');
    assert.deepEqual(p, { market: 7.02, low: 4.5, currency: 'USD', source: 'tcgplayer' });
  });
  it('still maps the Scrydex shape, so a reactivated subscription needs no code change', () => {
    const scrydex = { variants: [{ name: 'normal', prices: [{ condition: 'NM', market: 3.5, currency: 'USD', trends: { days_7: { percent_change: -2 } } }] }] };
    const p = mapPrice('riftbound', scrydex, 'Non-foil');
    assert.equal(p.market, 3.5);
    assert.equal(p.source, 'scrydex');
    assert.equal(p.pct_7d, -2);
  });
  it('no price → null (collector records no_price, not a fake zero)', () => {
    assert.equal(mapPrice('riftbound', { market: null }, ''), null);
    assert.equal(mapPrice('riftbound', {}, ''), null);
  });
});

describe('pricePath — split from lookupPath on purpose', () => {
  it('riftbound prices go to the keyless index', () => {
    assert.equal(pricePath('riftbound', 'OGN-27a'), '/api/riftbound/prices/OGN-27a');
  });
  it('never uses an /api/rb… path — the vite /api/rb proxy would swallow it', () => {
    assert.ok(!/^\/api\/rb($|[^a-z])/.test(pricePath('riftbound', 'OGN-27a')));
  });
  it('lookupPath still points at the full card RECORD (inventory images, collectr name guard)', () => {
    assert.match(lookupPath('riftbound', 'OGN-27a'), /^\/api\/rb\/cards\//);
  });
  it('every other game is unchanged', () => {
    for (const [game, key] of [['pokemon', 'sv4-25'], ['mtg', 'neo-1'], ['swu', 'sor/010'], ['lorcana', '1/1']]) {
      assert.equal(pricePath(game, key), lookupPath(game, key), game + ' must not change');
    }
  });
});
