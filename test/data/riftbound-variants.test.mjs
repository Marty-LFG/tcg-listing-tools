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
import { TREATMENT_OVERRIDE } from '../../scripts/build-riftbound-data.mjs';

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
  const tag = (name) => (String(name || '').match(/\((Signature|Overnumbered|Alternate Art|Ultimate)\)/) || [, ''])[1];

  it('joins most of the catalog onto the price index (the keys are meant to line up)', () => {
    const total = Object.values(catalog).reduce((n, s) => n + s.cards.length, 0);
    assert.ok(joined.length / total > 0.85, `only ${joined.length}/${total} catalog cards found a price`);
  });

  it('agrees with TCGplayer on Signature vs Overnumbered vs Alternate Art', () => {
    const bad = joined.filter(({ c, row }) => tag(c.name) !== tag(row.name))
      .map(({ set, c, row }) => `${set.code}-${c.k}: baked "${tag(c.name) || 'base'}" vs TCGplayer "${tag(row.name) || 'base'}" (${row.name})`);
    assert.deepEqual(bad, [], `${bad.length} card(s) labelled differently from the market`);
  });

  // The fence around the one hardcoded row in the bake. A hardcode is normally how data rots; this
  // asserts every override is still exactly what TCGplayer calls the card, and that none has been
  // left behind after the printed number learned to imply it.
  it('every TREATMENT_OVERRIDE entry is still backed by TCGplayer, and none is dead', () => {
    for (const [key, treatment] of Object.entries(TREATMENT_OVERRIDE)) {
      const row = prices.cards[key];
      assert.ok(row, `${key}: override points at a card the price index does not carry`);
      assert.equal(tag(row.name), treatment, `${key}: TCGplayer calls it "${row.name}", not (${treatment})`);
      const hit = joined.find(({ set, c }) => set.code + '-' + c.k === key);
      assert.ok(hit, `${key}: override points at a card the catalog does not carry`);
      assert.equal(tag(hit.c.name), treatment, `${key}: the bake did not apply the override`);
    }
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
