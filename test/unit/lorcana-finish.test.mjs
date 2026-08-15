// Lorcana's finish/rarity model — the one axis where getting it wrong costs four figures.
//
// Counted across all 22 Lorcast sets (3,192 cards, docs/DATA_SOURCES.md): Enchanted, Epic and
// Iconic are FOIL-ONLY — of all 324 of them, not one carries a `usd` price. They are also the chase
// cards: Buzz Lightyear 12/241 (Iconic) is US$3,632 beside US$1 base cards. Before this landed,
// only Enchanted was known to the code, so an Epic or an Iconic fell through to the generic 'Foil'
// branch and became indistinguishable from the ordinary foil printing of the same card.
//
// The same ladder is spelled out in four places by design (each has a different consumer), so every
// one of them is pinned here — drift between them is silent and expensive:
//
//   variantToken  lib/listing-copy.mjs        IS the `variant` column in UNIQUE(game, identity_key, variant)
//   finishClass   lib/pricing.mjs             picks the tier floor
//   ebayFinish    lib/channels/ebay-map.mjs   the eBay Finish aspect
//   lorcanaSpecialFinish / lorcanaPrintingsFor  lib/runner-core.mjs   the printing matrix
import test from 'node:test';
import assert from 'node:assert/strict';
import { variantToken, buildTitle } from '../../lib/listing-copy.mjs';
import { finishClass, tierFloor } from '../../lib/pricing.mjs';
import { ebayFinish } from '../../lib/channels/ebay-map.mjs';
import { lorcanaSpecialFinish, lorcanaPrintingsFor, LORCANA_PRINTING_TOKENS, pickPrinting } from '../../lib/runner-core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('lorcanaSpecialFinish names the three foil-only chase rarities', () => {
  assert.equal(lorcanaSpecialFinish('Enchanted'), 'Enchanted');
  assert.equal(lorcanaSpecialFinish('Iconic'), 'Iconic');
  assert.equal(lorcanaSpecialFinish('Epic'), 'Epic');
  // Case and the raw underscore spelling both reach it.
  assert.equal(lorcanaSpecialFinish('iconic'), 'Iconic');
});

test('Promo is NOT a special finish — it is the one genuinely mixed rarity', () => {
  // Counted: of 193 promos, 12 are non-foil, 6 carry both prices and 66 carry no price at all.
  // Treating it as foil-only would title and price a plain promo as a foil.
  assert.equal(lorcanaSpecialFinish('Promo'), null);
  for (const r of ['Common', 'Uncommon', 'Rare', 'Super_rare', 'Super Rare', 'Legendary', '', null]) {
    assert.equal(lorcanaSpecialFinish(r), null, `${r} must not be a special finish`);
  }
});

test('variantToken keeps each chase finish on its own identity row', () => {
  // Not cosmetic: this IS the `variant` column in UNIQUE(game, identity_key, variant), so two
  // finishes that collapse to one token become one indistinguishable row (GR5).
  assert.equal(variantToken(null, 'Enchanted'), 'Enchanted');
  assert.equal(variantToken(null, 'Iconic'), 'Iconic');
  assert.equal(variantToken(null, 'Epic'), 'Epic');
  assert.equal(variantToken(null, 'Foil'), 'Foil');
  assert.equal(variantToken(null, 'Normal'), 'Base');
  // "Cold Foil" CONTAINS "foil", so it has to be tested above the generic branch — the same trap
  // "Surge Foil" and "Nonfoil" carry.
  assert.equal(variantToken(null, 'Cold Foil'), 'Cold Foil');
  assert.equal(variantToken(null, 'cold foil'), 'Cold Foil');
  // All five are distinct, which is the whole point.
  const tokens = ['Normal', 'Foil', 'Cold Foil', 'Enchanted', 'Epic', 'Iconic'].map((f) => variantToken(null, f));
  assert.equal(new Set(tokens).size, tokens.length, 'every Lorcana finish needs its own variant token');
});

test('finishClass gives each chase finish its own tier column', () => {
  assert.equal(finishClass('Enchanted'), 'Enchanted');
  assert.equal(finishClass('Iconic'), 'Iconic');
  assert.equal(finishClass('Epic'), 'Epic');
  assert.equal(finishClass('Cold Foil'), 'Cold Foil');
  assert.equal(finishClass('Foil'), 'Foil');
  assert.equal(finishClass('Normal'), 'Base');
});

test('ebayFinish maps the chase finishes to Foil rather than leaving the facet unset', () => {
  // eBay 183454 has no Enchanted/Epic/Iconic member on Finish, and these ARE foil printings — the
  // specialness rides on the Rarity aspect. They contain neither "holo" nor "foil", so without a
  // branch of their own they returned null and the facet went unset on the best cards in the game.
  assert.equal(ebayFinish('Enchanted'), 'Foil');
  assert.equal(ebayFinish('Iconic'), 'Foil');
  assert.equal(ebayFinish('Epic'), 'Foil');
  assert.equal(ebayFinish('Cold Foil'), 'Foil');
  // The Pokémon negation still wins — this ladder is shared.
  assert.equal(ebayFinish('Non-holo'), 'Regular');
  assert.equal(ebayFinish('Normal'), 'Regular');
});

test('an Iconic is priced off its own tier, not the A$1.99 catch-all', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bulk-pricing.config.json'), 'utf8'));
  // rarityClass collapses Legendary/Enchanted/Epic/Iconic/Promo all into 'default', so without a
  // per-finish floor there an Iconic inherits the same A$1.99 as a Legendary.
  const iconic = tierFloor(cfg, 'lorcana', 'Iconic', 'Iconic');
  const enchanted = tierFloor(cfg, 'lorcana', 'Enchanted', 'Enchanted');
  const legendary = tierFloor(cfg, 'lorcana', 'Legendary', 'Foil');
  assert.ok(iconic > legendary, `Iconic floor ${iconic} must beat the Legendary floor ${legendary}`);
  assert.ok(enchanted > legendary, `Enchanted floor ${enchanted} must beat the Legendary floor ${legendary}`);
  assert.ok(iconic > enchanted, `Iconic floor ${iconic} must beat the Enchanted floor ${enchanted}`);
  // Floors are anchored BELOW each rarity's observed minimum (Iconic min US$966 ~ A$1464,
  // Enchanted min US$21.15 ~ A$32), so they stay conservative owner floors, never market claims.
  assert.ok(iconic < 1464, 'the Iconic floor must stay under the cheapest observed Iconic');
  assert.ok(enchanted < 32, 'the Enchanted floor must stay under the cheapest observed Enchanted');
});

test('the title carries the chase rarity ONCE, not twice', () => {
  // On a chase print the finish and the rarity are the same word, so the title read "ICONIC ICON"
  // and "ENCHANTED ENH" — ten characters of an 80-char budget spent repeating itself.
  const base = { num: '241/242', set: 'Whispers in the Well (WitW)', lang: 'English', cond: 'Near Mint' };
  const iconic = buildTitle('lorcana', { ...base, name: 'Ariel - Ethereal Voice', rarity: 'Iconic', variant: 'Iconic' });
  assert.match(iconic, /ICONIC/);
  assert.doesNotMatch(iconic, /ICONIC ICON\b/, 'the rarity abbreviation duplicates the finish');
  const epic = buildTitle('lorcana', { ...base, name: 'Aladdin - Barreling Through', rarity: 'Epic', variant: 'Epic' });
  assert.doesNotMatch(epic, /EPIC EPIC/);
  // But when they genuinely differ they BOTH belong: an Enchanted card listed as a plain Foil is a
  // real combination, and dropping the ENH there would lose the rarity from the title entirely.
  const mixed = buildTitle('lorcana', { ...base, name: 'Elsa - Spirit of Winter', rarity: 'Enchanted', variant: 'Foil' });
  assert.match(mixed, /FOIL ENH/);
});

// ---------------------------------------------------------------------------
// lorcanaPrintingsFor — the printing matrix
// ---------------------------------------------------------------------------

const card = (rarity, prices) => ({ rarity, prices, collector_number: '1' });

test('an ordinary card yields Normal then Foil, in that order', () => {
  const p = lorcanaPrintingsFor(card('Rare', { usd: '0.56', usd_foil: '1.96' }));
  assert.deepEqual(p.map((x) => x.finish), ['Normal', 'Foil']);
  assert.deepEqual(p.map((x) => x.key), ['usd', 'usd_foil']);
  assert.deepEqual(p.map((x) => x.variant), ['Base', 'Foil']);
  assert.deepEqual(p.map((x) => x.marketUsd), [0.56, 1.96]);
});

test('a foil-only chase card yields ONE row, named by its rarity', () => {
  for (const [rarity, finish, price] of [['Enchanted', 'Enchanted', '109.71'], ['Epic', 'Epic', '4.74'], ['Iconic', 'Iconic', '1344.77']]) {
    const p = lorcanaPrintingsFor(card(rarity, { usd: null, usd_foil: price }));
    assert.equal(p.length, 1, `${rarity} has no plain printing to sell`);
    assert.equal(p[0].finish, finish);
    assert.equal(p[0].variant, finish);
    assert.equal(p[0].key, 'usd_foil');
    // Unlike Magic's surge foil, this figure is trustworthy: Lorcast has no second foil product to
    // confuse it with, so usd_foil on an Iconic IS the Iconic's price.
    assert.equal(p[0].marketUsd, Number(price));
    assert.ok(!p[0].marketUnreliable, 'the Lorcast figure is the real one here');
  }
});

test('a chase card never yields a plain row, even if usd somehow appears', () => {
  // Counted at zero occurrences across 324 cards. If upstream ever changes, the row must not
  // silently become a base card of a US$3,632 print.
  const p = lorcanaPrintingsFor(card('Iconic', { usd: '2.00', usd_foil: '1344.77' }));
  assert.equal(p.length, 1);
  assert.equal(p[0].finish, 'Iconic');
});

test('an unpriced card is still listable, at market null', () => {
  // 66 promos are in exactly this state — GR7: a row with no price beats no row.
  const promo = lorcanaPrintingsFor(card('Promo', {}));
  assert.equal(promo.length, 1);
  assert.equal(promo[0].finish, 'Normal');
  assert.equal(promo[0].marketUsd, null);
  // An unpriced chase card keeps its rarity's finish rather than falling back to Normal.
  const ench = lorcanaPrintingsFor(card('Enchanted', {}));
  assert.equal(ench[0].finish, 'Enchanted');
  assert.equal(ench[0].marketUsd, null);
});

test('a foil-only ORDINARY card is a plain foil, not a chase print', () => {
  // 3 Commons, 2 Uncommons, 3 Rares and 4 Legendaries have only a foil price. That makes them
  // foil-only, not Enchanted.
  const p = lorcanaPrintingsFor(card('Common', { usd_foil: '0.18' }));
  assert.equal(p.length, 1);
  assert.equal(p[0].finish, 'Foil');
  assert.equal(p[0].variant, 'Foil');
});

test('the catch-line tokens map onto Lorcast price fields and pick the right row', () => {
  assert.deepEqual(LORCANA_PRINTING_TOKENS, { n: 'usd', f: 'usd_foil', h: 'usd_foil' });
  const both = lorcanaPrintingsFor(card('Rare', { usd: '0.56', usd_foil: '1.96' }));
  assert.equal(pickPrinting(both, LORCANA_PRINTING_TOKENS.n).finish, 'Normal');
  assert.equal(pickPrinting(both, LORCANA_PRINTING_TOKENS.f).finish, 'Foil');
  assert.equal(pickPrinting(both, LORCANA_PRINTING_TOKENS.h).finish, 'Foil');
  // No token typed → the cheapest-risk default, which is the plain printing.
  assert.equal(pickPrinting(both, null).finish, 'Normal');
  // On a chase card there is only one row, so `n` cannot conjure a plain printing that does not
  // exist — it must not hand back a base card for a US$1,344 Iconic.
  const iconic = lorcanaPrintingsFor(card('Iconic', { usd_foil: '1344.77' }));
  assert.equal(pickPrinting(iconic, LORCANA_PRINTING_TOKENS.n).finish, 'Iconic');
});
