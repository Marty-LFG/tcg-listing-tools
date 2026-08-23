// test/unit/collectr.test.mjs — the Collectr CSV importer's pure field parsers. Offline.
//
// Weighted towards the LANGUAGE tag, because that is the field with no column behind it: Collectr's
// export has no language, only a '(JP)' suffix on the Product Name, and getting it wrong prices a
// Japanese card off the English market with nothing on the row saying so.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  langFromProductName, cleanProductName, normalizeNumber, toImportRow, parseCollectr, parseGrade,
} from '../../lib/collectr.mjs';

describe('langFromProductName — the tag Collectr hides in the name', () => {
  const TAGGED = [
    ['Marill (JP)', 'JP', 'Marill'],
    ['Mewtwo & Mew GX (JP)', 'JP', 'Mewtwo & Mew GX'],
    ['Pikachu (ja)', 'JP', 'Pikachu'],            // ISO alias, lowercase
    ['Charizard (CN)', 'CN', 'Charizard'],
    ['Lugia (TW)', 'TW', 'Lugia'],
    ['Snorlax (KO)', 'KO', 'Snorlax'],
    ['Gardevoir ex  (JP)  ', 'JP', 'Gardevoir ex'],
  ];
  for (const [input, code, name] of TAGGED) {
    it(`"${input}" -> ${code} + "${name}"`, () => {
      const out = langFromProductName(input);
      assert.equal(out.language, code);
      assert.equal(out.name, name);
      assert.equal(out.tagged, true);
    });
  }

  // GR5: a value-bearing parenthetical is part of the card's identity and must survive untouched.
  const UNTOUCHED = [
    'Gardevoir EX (Full Art)',
    'Metagross (Delta Species)',
    'Deoxys (Team Plasma)',
    'Feraligatr (Prime)',
    'Unown (A)',
    'Charizard EX (11)',
    'Pikachu (JP) V',            // not trailing — not a language tag
    'Mew (EX)',
    'Zoroark (GX)',
  ];
  for (const input of UNTOUCHED) {
    it(`leaves "${input}" alone`, () => {
      const out = langFromProductName(input);
      assert.equal(out.language, 'EN');
      assert.equal(out.name, input);
      assert.equal(out.tagged, false);
    });
  }

  it('survives null/empty', () => {
    assert.deepEqual(langFromProductName(null), { language: 'EN', name: '', tagged: false });
    assert.deepEqual(langFromProductName(''), { language: 'EN', name: '', tagged: false });
  });
});

describe('toImportRow — language reaches the row, and the tag does not', () => {
  const base = { category: 'Pokemon', set: 'Snow Hazard', card_number: '073/071', quantity: '1', card_condition: 'Near Mint' };

  it('a (JP) row imports as JP with a clean name', () => {
    const { row } = toImportRow({ ...base, product_name: 'Marill (JP)' });
    assert.equal(row.language, 'JP');
    assert.equal(row.name, 'Marill');
    assert.equal(row.number, '073/071');      // display stays verbatim (GR5)
    assert.equal(row.lookup_num, '73');       // and the resolver input is the bare number
  });

  it('an untagged row is still EN, byte-identical to before', () => {
    const { row } = toImportRow({ ...base, product_name: 'Gardevoir EX (Full Art)', set: 'Steam Siege', card_number: '111' });
    assert.equal(row.language, 'EN');
    assert.equal(row.name, 'Gardevoir EX (Full Art)');
  });

  // Order matters: the tag has to come off before cleanProductName can see the "(18)" it is
  // looking for. Both strips in one name is the case that catches a wrong order.
  it('strips the tag BEFORE the repeated card number', () => {
    const { row } = toImportRow({ ...base, product_name: 'Misty (18) (JP)', card_number: '18' });
    assert.equal(row.language, 'JP');
    assert.equal(row.name, 'Misty');
  });

  it('a repeated number that is NOT the card number stays put', () => {
    const { row } = toImportRow({ ...base, product_name: 'Charizard EX (11)', card_number: '12' });
    assert.equal(row.name, 'Charizard EX (11)');
  });
});

describe('normalizeNumber — display verbatim, lookup bare', () => {
  const CASES = [
    ['143/236', '143/236', '143'],
    ['052/173', '052/173', '52'],
    ['GG20/GG70', 'GG20/GG70', 'GG20'],
    ['RC15', 'RC15', 'RC15'],
    ['111', '111', '111'],
    ['', '', ''],
  ];
  for (const [raw, display, lookupNum] of CASES) {
    it(`"${raw}" -> display "${display}", lookup "${lookupNum}"`, () => {
      assert.deepEqual(normalizeNumber(raw), { display, lookupNum });
    });
  }
});

describe('cleanProductName', () => {
  it('drops a trailing (n) only when it repeats the card number', () => {
    assert.equal(cleanProductName('Misty (18)', '18'), 'Misty');
    assert.equal(cleanProductName('Misty (18)', '19'), 'Misty (18)');
    assert.equal(cleanProductName('Misty (18)', null), 'Misty (18)');
  });
  it('keeps value-bearing parentheticals', () => {
    assert.equal(cleanProductName('N (Supporter) (Full Art)', '105'), 'N (Supporter) (Full Art)');
  });
});

describe('parseCollectr — the header gate', () => {
  it('rejects a file with no Category column', () => {
    const out = parseCollectr('Set,Product Name,Card Number\nSteam Siege,Gardevoir EX,111\n');
    assert.deepEqual(out.rows, []);
    assert.match(out.warnings[0], /not a Collectr export/);
  });
  it('accepts Category + Product Name and ignores unknown columns', () => {
    const out = parseCollectr('Category,Set,Product Name,Card Number,eBay Comps\nPokemon,Steam Siege,Gardevoir EX,111,https://example.test\n');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].product_name, 'Gardevoir EX');
  });
});

describe('parseGrade', () => {
  it('Ungraded and empty are raw', () => {
    assert.deepEqual(parseGrade('Ungraded'), { graded: false });
    assert.deepEqual(parseGrade(''), { graded: false });
  });
  it('company + grade + label', () => {
    const g = parseGrade('PSA 10.0 GEM - MT');
    assert.equal(g.graded, true);
    assert.equal(g.grading_company, 'PSA');
    assert.equal(g.grade, 10);
  });
  it('an unrecognised shape degrades to raw with a warning (GR7)', () => {
    const g = parseGrade('who knows');
    assert.equal(g.graded, false);
    assert.match(g.warning, /unrecognised Grade/);
  });
});
