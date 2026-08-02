// test/data/riftbound-variants.test.mjs — the derived variant labels, checked against the market.
//
// The catalog bake decides a card's treatment from its printed number and freezes the answer into
// the card name. TCGplayer independently states the same fact in its product name and rarity. This
// file joins the two baked files on the identity_key and asserts they agree, ~1100 rows at a time.
//
// It exists because the original rule was wrong in a way no unit test could notice: `*` was labelled
// "Overnumbered" when the market calls it "Signature" (OGN 299* is US$2,739; plain 299 is US$296),
// and Riot's own rarity field calls the US$175 Overnumbered "Pouty Poro" a common. A fixture can
// only confirm the rule we believe; this confirms the rule against the party that sells the cards.
//
// Both files are gitignored and server-owned, so the suite SKIPS when either is absent rather than
// failing a fresh checkout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };
const catalog = readJson('data/riftbound.json');
const prices = readJson('data/riftbound-prices.json');
const have = !!(catalog && prices && prices.cards);

describe('baked variant labels vs TCGplayer', { skip: have ? false : 'bake data/riftbound.json + data/riftbound-prices.json first' }, () => {
  // catalog key -> { catalog card, set, TCGplayer row }
  const joined = [];
  if (have) {
    for (const [sid, set] of Object.entries(catalog)) {
      for (const c of set.cards) {
        const row = prices.cards[set.code + '-' + c.k];
        if (row) joined.push({ sid, set, c, row });
      }
    }
  }
  const tag = (name) => (String(name || '').match(/\((Signature|Overnumbered|Alternate Art)\)/) || [, ''])[1];

  // Known, deliberate exceptions: cards where TCGplayer uses a name the printed number cannot imply.
  // UNL-238 Baron Nashor is the only "(Ultimate)" in the game — a single US$1,600 chase card. Riot's
  // gallery gives it no distinguishing field at all (epic / unit / portrait, same as its neighbours),
  // so there is nothing to derive it from; inventing a rule off one row would be a guess that rots.
  // It is still correctly resolved as an over-total Showcase foil; only the word differs.
  const KNOWN_DIFFERENT = new Set(['UNL-238']);

  it('joins most of the catalog onto the price index (the keys are meant to line up)', () => {
    const total = Object.values(catalog).reduce((n, s) => n + s.cards.length, 0);
    assert.ok(joined.length / total > 0.85, `only ${joined.length}/${total} catalog cards found a price`);
  });

  it('agrees with TCGplayer on Signature vs Overnumbered vs Alternate Art', () => {
    const bad = joined.filter(({ set, c, row }) => tag(c.name) !== tag(row.name) && !KNOWN_DIFFERENT.has(set.code + '-' + c.k))
      .map(({ set, c, row }) => `${set.code}-${c.k}: baked "${tag(c.name) || 'base'}" vs TCGplayer "${tag(row.name) || 'base'}" (${row.name})`);
    assert.deepEqual(bad, [], `${bad.length} card(s) labelled differently from the market`);
  });

  it('every card TCGplayer calls Showcase resolves to a Showcase foil here', () => {
    const bad = joined.filter(({ row }) => row.rarity === 'Showcase')
      .filter(({ c, set }) => {
        const numPart = c.num.split('/')[0];
        const premium = /^SP/i.test(numPart) || numPart.endsWith('*') || /[a-z]$/i.test(numPart)
          || (parseInt(numPart, 10) || 0) > set.total;
        return !premium;
      })
      .map(({ set, c }) => `${set.code}-${c.k} ${c.num}`);
    assert.deepEqual(bad, [], 'TCGplayer calls these Showcase but the printed number says base print');
  });

  it("Vendetta's SP promos are priced and carry no false variant", () => {
    const sp = joined.filter(({ c }) => /^sp\d/.test(c.k));
    assert.ok(sp.length >= 4, `only ${sp.length} SP cards joined — they used to be dropped entirely`);
    for (const { c, row } of sp) {
      assert.equal(tag(c.name), '', `${c.num}: SP promos carry no parenthetical`);
      assert.equal(c.rarity, 'Showcase', `${c.num}`);
      assert.ok(row.market > 0, `${c.num}: no market price`);
    }
  });

  it('a Signature is priced well above the plain print of the same number', () => {
    // The single most expensive thing to get wrong: these two were one label until this change.
    const pairs = joined.filter(({ c }) => c.k.endsWith('*'))
      .map(({ set, c, row }) => ({ set: set.code, k: c.k, sig: row.market, base: (prices.cards[set.code + '-' + c.k.slice(0, -1)] || {}).market }))
      .filter((p) => p.base != null);
    assert.ok(pairs.length >= 5, `only ${pairs.length} Signature/base pairs to compare`);
    for (const p of pairs) assert.ok(p.sig > p.base, `${p.set}-${p.k}: Signature US$${p.sig} <= base US$${p.base}`);
  });
});
