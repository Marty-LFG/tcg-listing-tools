// Unit tests for the baked Mega Evolution Promo (`mep`) roster builder. Pure — no network (image
// probing lives in buildPokemonMep, not computeMep). Covers grouping by number, variant/typo
// parsing, and clean-name derivation from TCGplayer's quirky product names.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMep, fetchTcgplayerRows } from '../../scripts/build-pokemon-mep.mjs';

// Rows mirror fetchTcgplayerRows() output: price is a NUMBER (marketPrice), plus stage/type/hp.
const rows = [
  { name: 'Meganium - 001', number: '001', price: 28.98, stage: 'Stage 2', type: 'Grass', hp: '150' },
  { name: 'Meganium - 001 [Staff]', number: '001', price: 99.92, stage: 'Stage 2', type: 'Grass', hp: '150' },
  { name: 'Alakazam - 009', number: '009', price: 9.23 },
  { name: 'Alakazam - 009 (Pokemon Center Exclusive)', number: '009', price: 74.84 },
  { name: 'Drifloon - (Cosmos Holo) 005', number: '005', price: 3.87 },   // scrambled order
  { name: 'Slowpoke - 086 (Comos Holo)', number: '086', price: 3.39 },    // typo: Comos
  { name: 'Dhelmise - 084 (Patch Black Stamp)', number: '084', price: 13.69 }, // typo: Patch/Stamp
  { name: 'Celebratory Fanfare (Ace Trainer)', number: '028', price: 682.62 }, // Stadium — no stage/type/hp
  { name: "N's Zekrom - 031", number: '031', price: 10.63 },              // apostrophe kept
  { name: 'Mega Charizard X ex - 23', number: '23', price: '$37.39' },    // unpadded number, string price still ok
  { name: 'Haunter  - 027', number: '027', price: 48.70 },                // double space
  { name: 'Toxtricity (Prerelease)', number: '017', price: 12.21 },
];

describe('computeMep — grouping + normalisation', () => {
  const { cards, total, printedTotal } = computeMep(rows);
  const byNum = Object.fromEntries(cards.map((c) => [c.number, c]));

  it('groups variant rows under one padded card number', () => {
    assert.equal(total, 10);                       // 12 rows, 10 distinct numbers (001 & 009 each have 2 variants)
    assert.equal(printedTotal, 86);
    assert.equal(byNum['001'].variants.length, 2);
    assert.equal(byNum['023'].number, '023');      // unpadded "23" -> "023"
  });

  it('parses variant labels, tolerating TCGplayer typos', () => {
    assert.deepEqual(byNum['001'].variants.map((v) => v.label), ['Standard', 'Staff']);
    assert.equal(byNum['009'].variants.find((v) => v.market === 74.84).label, 'Pokémon Center Exclusive');
    assert.equal(byNum['005'].variants[0].label, 'Cosmos Holo');
    assert.equal(byNum['086'].variants[0].label, 'Cosmos Holo');   // "Comos" typo
    assert.equal(byNum['084'].variants[0].label, 'Pitch Black Stamped'); // "Patch ... Stamp" typo
    assert.equal(byNum['028'].variants[0].label, 'Ace Trainer');
    assert.equal(byNum['017'].variants[0].label, 'Prerelease');
  });

  it('derives a clean card name (strips number, brackets, parens, stray order)', () => {
    assert.equal(byNum['001'].name, 'Meganium');
    assert.equal(byNum['005'].name, 'Drifloon');
    assert.equal(byNum['028'].name, 'Celebratory Fanfare');
    assert.equal(byNum['031'].name, "N's Zekrom");     // apostrophe preserved, no hyphen damage
    assert.equal(byNum['023'].name, 'Mega Charizard X ex');
    assert.equal(byNum['027'].name, 'Haunter');        // double space collapsed
  });

  it('parses prices (number or "$" string) and marks every card Promo', () => {
    assert.equal(byNum['028'].variants[0].market, 682.62);   // numeric marketPrice
    assert.equal(byNum['023'].variants[0].market, 37.39);    // "$37.39" string still parsed
    assert.ok(cards.every((c) => c.rarity === 'Promo'));
  });

  it('carries stage/type/hp when present, omits them for Trainers/Stadiums', () => {
    assert.equal(byNum['001'].stage, 'Stage 2');
    assert.equal(byNum['001'].type, 'Grass');
    assert.equal(byNum['001'].hp, '150');
    assert.equal(byNum['028'].stage, undefined);   // Celebratory Fanfare (Stadium) — no card stats
    assert.equal(byNum['028'].type, undefined);
  });

  it('orders variants Standard-first, then by price desc', () => {
    assert.equal(byNum['009'].variants[0].label, 'Standard');
    assert.ok(byNum['009'].variants[0].market < byNum['009'].variants[1].market); // Standard cheaper here
  });

  it('sorts the roster by numeric card number', () => {
    const nums = cards.map((c) => Number(c.number));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  });
});

describe('fetchTcgplayerRows — pagination + field mapping (mocked, no network)', () => {
  const mkResp = (results, totalResults) => ({ ok: true, json: async () => ({ results: [{ totalResults, results }] }) });

  it('paginates until totalResults, maps customAttributes, drops sealed', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      productName: `Card ${i}`, marketPrice: i,
      customAttributes: { number: String(i).padStart(3, '0'), stage: 'Basic', energyType: ['Fire'], hp: '60' },
    }));
    const page2 = [
      { productName: 'Zarude - 088', marketPrice: 11, sealed: false, customAttributes: { number: '088' } },
      { productName: 'Sealed Box', sealed: true, customAttributes: { number: '999' } },   // dropped
    ];
    let calls = 0;
    const fetchImpl = async () => { calls++; return calls === 1 ? mkResp(page1, 52) : mkResp(page2, 52); };
    const rows = await fetchTcgplayerRows(fetchImpl);
    assert.equal(calls, 2);
    assert.equal(rows.length, 51);   // 50 + 1 (sealed dropped)
    assert.equal(rows.find((r) => r.number === '088').name, 'Zarude - 088');
    assert.deepEqual(rows[0], { name: 'Card 0', number: '000', price: 0, stage: 'Basic', type: 'Fire', hp: '60', rarity: 'Promo', releaseDate: '' });
  });

  it('throws on a non-ok response (GR7: refresh then keeps the existing file)', async () => {
    await assert.rejects(fetchTcgplayerRows(async () => ({ ok: false, status: 403 })), /HTTP 403/);
  });

  it('throws when the set returns zero products', async () => {
    await assert.rejects(fetchTcgplayerRows(async () => mkResp([], 0)), /no products/);
  });
});
