// test/unit/stock-games-riftbound.test.mjs — the Riftbound entry in the stock-tool adapter table.
//
// Split out of stock-games.test.mjs the way the Lorcana suite is: the shared contract (every
// adapter carries every key, of the right kind) lives there and already covers this one. What
// lives here is what is PARTICULAR to Riftbound, and one thing is particular enough to be the
// reason this file exists:
//
//   For every other game the `variant` column holds a PRINTING ('Holo', 'Etched Foil'). For
//   Riftbound it holds the printing TREATMENT — Alternate Art / Overnumbered / Signature /
//   Ultimate — which titleParts renders at priority 82, above the rarity token and the condition
//   code, because it is a 10-100x price differentiator. baseRow and stock-uploader.html both
//   compute a finish token instead, so the adapter has to OVERRIDE them. Get it wrong and a
//   US$3,000 Signature lists with 'M/NM' in the title where '(Signature)' should be, and its
//   stockKey stops matching the row the bulk enumerator writes for the same physical card.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_GAME_ADAPTERS, STOCK_GAME_IDS, adapterFor, isStockGame, compsQueryFor, compsNumberMatch,
} from '../../lib/stock-games.mjs';
import { stockKey } from '../../lib/inventory.mjs';
import { RIFTBOUND_PRINTING_TOKENS } from '../../lib/runner-core.mjs';

const R = STOCK_GAME_ADAPTERS.riftbound;

// The shape /api/riftbound/set/:id/cards serves: cardToCanonical's output plus `k`, `setCode` and
// the price join. Real cards, real numbers.
const SIG = {                                  // OGN 299*/298 — Signature, the dearest print there is
  k: '299*', setCode: 'OGN', number: '299*/298', name: 'Daughter of the Void',
  rarity: 'Showcase', variant: 'Signature', finish: 'Foil', type: 'Legend', domain: 'Fury / Mind',
  tags: '', e: '', p: '', m: '', illustrator: 'Kudos Productions',
  image: 'https://static.dotgg.gg/riftbound/cards/OGN-299.webp', image_fallback: 'https://cms/x.png',
  marketUsd: 3085.16, marketCurrency: 'USD',
};
const ALT = {                                  // OGN 027a/298 — Alternate Art, and a champion Unit
  k: '27a', setCode: 'OGN', number: '027a/298', name: 'Darius, Trifarian',
  rarity: 'Showcase', variant: 'Alternate Art', finish: 'Foil', type: 'Unit', domain: 'Fury',
  tags: '', e: '5', p: '1', m: '5', illustrator: 'Envar Studio',
  image: 'https://static.dotgg.gg/riftbound/cards/OGN-027a.webp', image_fallback: '',
  marketUsd: 6.79, marketCurrency: 'USD',
};
const BASE = {                                 // OGN 001/298 — a plain Common, the ordinary case
  k: '1', setCode: 'OGN', number: '001/298', name: 'Blazing Scorcher',
  rarity: 'Common', variant: '', finish: 'Non-foil', type: 'Unit', domain: 'Fury',
  tags: '', e: '5', p: '', m: '5', illustrator: 'League Splash Team',
  image: 'https://static.dotgg.gg/riftbound/cards/OGN-001.webp', image_fallback: '',
  marketUsd: 0.08, marketCurrency: 'USD',
};
const OGN = { value: 'ogn', label: 'Origins', code: 'OGN' };

describe('the Riftbound adapter is wired into the registry', () => {
  it('is listed, and reachable through adapterFor / isStockGame', () => {
    assert.ok(STOCK_GAME_IDS.includes('riftbound'));
    assert.equal(adapterFor('riftbound').id, 'riftbound');
    assert.equal(adapterFor('RIFTBOUND').id, 'riftbound');
    assert.ok(isStockGame('riftbound'));
  });
  it('its SKU code matches GAMECODE in lib/inventory.mjs', () => {
    assert.equal(R.code, 'RB');
  });
  it('brings its own sets-cache key, so it cannot collide with another game\'s', () => {
    assert.equal(R.setsCacheKey, 'tcg_uploader_riftbound_sets');
    for (const id of STOCK_GAME_IDS) {
      if (id !== 'riftbound') assert.notEqual(STOCK_GAME_ADAPTERS[id].setsCacheKey, R.setsCacheKey);
    }
  });
  it('builds the routes lib/riftbound-cards.mjs actually serves', () => {
    assert.equal(R.setsUrl(), '/api/riftbound/sets');
    assert.equal(R.setCardsUrl('ogn'), '/api/riftbound/set/ogn/cards');
    assert.equal(R.setCardsUrl('ogn', true), '/api/riftbound/set/ogn/cards?refresh=1');
    // The catch line accepts '299*' and 'SP1', so the URL builder has to encode them.
    assert.equal(R.cardUrl('ogn', '299*'), '/api/riftbound/cards/ogn/299*');
    assert.equal(R.cardUrl('ven', 'SP1'), '/api/riftbound/cards/ven/SP1');
  });
});

describe('the set list — and why EVERY Riftbound set keeps its catch-line code', () => {
  const SETS = {
    sets: [
      { id: 'ogn', code: 'OGN', name: 'Origins', total: 298 },
      { id: 'ogs', code: 'OGS', name: 'Proving Grounds', total: 24 },
      { id: 'ven', code: 'VEN', name: 'Vendetta', total: 166 },
    ],
  };
  it('maps the roster into the picker shape', () => {
    const out = R.setsFrom(SETS);
    assert.equal(out.length, 3);
    const ogn = out.find((s) => s.value === 'ogn');
    assert.deepEqual(
      { value: ogn.value, label: ogn.label, code: ogn.code, icon: ogn.icon, total: ogn.total },
      { value: 'ogn', label: 'Origins', code: 'OGN', icon: '', total: 298 },
    );
  });
  // The exact OPPOSITE of the Lorcana adapter, and worth asserting rather than assuming. Lorcana's
  // sets are called '1'…'13', which are also ordinary collector numbers, so its numbered sets must
  // contribute NO token or typing `13` for card 13 silently switches sets. Riftbound's codes are
  // three letters and no printed number is letters-only, so all of them are safe.
  it('keeps a code on every set, because none of them is number-shaped', () => {
    for (const s of R.setsFrom(SETS)) {
      assert.ok(s.code, s.value + ' lost its catch-line token');
      assert.ok(!/^\d+$/.test(s.code), s.code + ' is number-shaped and would collide with a card number');
    }
  });
  it('lists newest first, from the bake\'s own release order', () => {
    // The gallery roster carries no release date (probed 2026-08-25), so the order IS the bake's,
    // reversed — not a sort on an empty field.
    assert.deepEqual(R.setsFrom(SETS).map((s) => s.value), ['ven', 'ogs', 'ogn']);
    assert.ok(R.setsFrom(SETS).every((s) => s.releaseDate === ''));
  });
  it('survives an empty or malformed answer rather than throwing (GR7)', () => {
    assert.deepEqual(R.setsFrom(null), []);
    assert.deepEqual(R.setsFrom({}), []);
    assert.deepEqual(R.setsFrom({ sets: [] }), []);
  });
});

describe('identity and the printed number', () => {
  it('keys on the normNum `k` the server computed, not on the printed number', () => {
    // 'OGN-27a' is what ENUMERATORS.riftbound writes, what data/riftbound-prices.json is keyed on,
    // and what the price tracker re-fetches by. 'OGN-027a/298' is a key nothing has ever seen.
    assert.equal(R.identityKey(ALT), 'OGN-27a');
    assert.equal(R.identityKey(SIG), 'OGN-299*');
    assert.equal(R.identityKey(BASE), 'OGN-1');
  });
  it('ships the printed number VERBATIM, denominator and all (GR10)', () => {
    assert.equal(R.cardNumber(ALT), '027a/298');
    assert.equal(R.cardNumber(SIG), '299*/298');
    assert.equal(R.rawNumber(ALT), '027a/298');
    // Never through the Pokémon formatter: printedCardNumber early-returns for every other game,
    // and there is nothing to rebuild here anyway — Riftbound prints its own denominator.
    assert.equal(R.cardNumber({ number: null }), '');
  });
  it('prefers dotgg art with Riot\'s CDN behind it', () => {
    assert.equal(R.thumbUrl(SIG), SIG.image);
    assert.equal(R.thumbUrl({ image: '', image_fallback: 'https://cms/y.png' }), 'https://cms/y.png');
    assert.equal(R.thumbUrl({}), '');
  });
});

describe('printings and finishes', () => {
  it('offers exactly one printing per card, with the finish the treatment implies', () => {
    assert.deepEqual(R.printingsFor(SIG), [{
      key: 'foil', finish: 'Foil', edition: '', variant: 'Signature', marketUsd: 3085.16,
    }]);
    assert.deepEqual(R.printingsFor(BASE), [{
      key: 'normal', finish: 'Non-foil', edition: '', variant: 'Base', marketUsd: 0.08,
    }]);
  });
  it('has NO printing tokens, deliberately', () => {
    // One printing per card means a printing letter is a control with exactly one answer. The
    // runner's grammar strip drops the chip when this is empty rather than advertising it (GR4).
    assert.deepEqual(RIFTBOUND_PRINTING_TOKENS, {});
    assert.equal(R.printingTokens, RIFTBOUND_PRINTING_TOKENS);
  });
  it('offers only the two finishes the data can produce', () => {
    assert.deepEqual(R.finishOptions, ['Non-foil', 'Foil']);
    assert.equal(R.defaultFinish(SIG), 'Foil');
    assert.equal(R.defaultFinish(BASE), 'Non-foil');
    assert.equal(R.defaultFinish(null), 'Non-foil');
  });
  it('falls back to a DECLARED Non-foil, never to the rarity regex', () => {
    // finishFromRarity matches a bare "rare", and the catalog holds 335 Rares — each of which
    // would come back Holofoil, feed finishHint('foil') into the comps search and return a
    // confident price for a card you do not own.
    assert.deepEqual(R.finishFallback(), { finish: 'Non-foil', variant: 'Base', fromRarity: false });
    assert.equal(R.finishFallback().fromRarity, false, 'a declared default is not a guess');
  });
});

describe('rarity buckets', () => {
  it('is five-way, one per baked rarity, because each is already its own price tier', () => {
    assert.deepEqual(R.rarityOptions.map((o) => o.value),
      ['common', 'uncommon', 'rare', 'epic', 'showcase']);
  });
  it('tests uncommon before common, since one contains the other', () => {
    assert.equal(R.rarityClass('Uncommon'), 'uncommon');
    assert.equal(R.rarityClass('Common'), 'common');
    assert.equal(R.rarityClass('Rare'), 'rare');
    assert.equal(R.rarityClass('Epic'), 'epic');
    assert.equal(R.rarityClass('Showcase'), 'showcase');
    assert.equal(R.rarityClass(''), 'rare', 'anything unrecognised lands in the middle bucket');
  });
});

describe('normalizeCard', () => {
  const nc = R.normalizeCard(ALT, OGN);
  it('carries the "(CODE)" suffix on the set name, which is load-bearing three times', () => {
    // titleParts reads the code out of these parens for the abbreviated title; composeMetaFor's
    // splitSetIdent uses them for the rail's boxed code badge; compsQueryFor strips them back off.
    assert.equal(nc.setName, 'Origins (OGN)');
    assert.equal(nc.setCode, 'OGN');
  });
  it('keeps the treatment in `variant` and the MAPPED rarity in `rarity`', () => {
    assert.equal(nc.variant, 'Alternate Art');
    assert.equal(nc.rarity, 'Showcase');
    assert.equal(nc.finish, 'Foil');
  });
  it('is English, with no language axis at all', () => {
    // The bake is English-only, so there is no `langs` key and the pages hide the control.
    assert.equal(nc.language, 'EN');
    assert.equal(R.langs, undefined);
  });
  // These names are read by rowToFields in lib/listing-copy.mjs to build the CARD DETAILS table,
  // and card_facts is what carries them across the DB round trip. Renaming one silently drops a row.
  it('persists card_facts under the exact names rowToFields reads', () => {
    assert.deepEqual(Object.keys(nc.facts).sort(), [
      'character', 'finish', 'illustrator', 'rarity', 'rb_domain', 'rb_e', 'rb_m', 'rb_p',
      'rb_tags', 'rb_type', 'set_code', 'variant',
    ]);
    assert.equal(nc.facts.rb_type, 'Unit');
    assert.equal(nc.facts.rb_domain, 'Fury');
    assert.equal(nc.facts.rb_e, '5');
  });
  it('derives the champion from the comma name, and only on a Unit', () => {
    assert.equal(nc.facts.character, 'Darius');
    assert.equal(R.normalizeCard(SIG, OGN).facts.character, '', 'a Legend names a title, not a champion');
    assert.equal(R.normalizeCard(BASE, OGN).facts.character, '', 'a Unit with no comma has no champion');
  });
  // 'finish' is not an inventory_items column, and itemToListing back-fills a missing one FROM the
  // variant — which here is the treatment. Persisting it is what stops a foil Showcase arriving at
  // ebayFinish as 'Alternate Art' and losing the Finish facet on the dearest cards in the game.
  it('persists the finish in card_facts, which is the only thing that survives the DB', () => {
    assert.equal(nc.facts.finish, 'Foil');
    assert.equal(R.normalizeCard(BASE, OGN).facts.finish, 'Non-foil');
  });
});

describe('invRowFrom — the variant override, and the reason this file exists', () => {
  it('keeps the TREATMENT even when the page hands in a finish token', () => {
    // stock-uploader.html computes its own finish→variant ladder and passes it as ui.variant;
    // baseRow computes variantToken(edition, finish). Both would store 'Foil' here.
    const row = R.invRowFrom(R.normalizeCard(SIG, OGN), { finish: 'Foil', variant: 'Foil' });
    assert.equal(row.variant, 'Signature');
    const alt = R.invRowFrom(R.normalizeCard(ALT, OGN), { finish: 'Foil', variant: 'Foil' });
    assert.equal(alt.variant, 'Alternate Art');
  });
  it('normalises a base print to "Base", which is what the DB stores', () => {
    assert.equal(R.invRowFrom(R.normalizeCard(BASE, OGN), { finish: 'Non-foil' }).variant, 'Base');
  });
  // The failure this guards is not a wrong string, it is a MISSED DUPLICATE: two rows for one
  // physical card, two shelf labels, and eBay error [25002] on the second publish.
  it('produces the same stockKey as the row the bulk enumerator writes', () => {
    const key = (variant) => stockKey({
      game: 'riftbound', identity_key: 'OGN-299*', variant, language: 'EN', condition: 'Near Mint',
    });
    const row = R.invRowFrom(R.normalizeCard(SIG, OGN), { finish: 'Foil', variant: 'Foil' });
    // ENUMERATORS.riftbound writes variant: canonical.variant — the treatment, verbatim.
    assert.equal(key(row.variant), key('Signature'));
    assert.notEqual(key(row.variant), key('Foil'), 'the trap: a finish token forks the identity');
  });
  it('carries the row fields the publish path reads', () => {
    const row = R.invRowFrom(R.normalizeCard(ALT, OGN), { finish: 'Foil', condition: 'Near Mint' });
    assert.equal(row.game, 'riftbound');
    assert.equal(row.identity_key, 'OGN-27a');
    assert.equal(row.set_name, 'Origins (OGN)');
    assert.equal(row.number, '027a/298');
    assert.equal(row.language, 'EN');
    assert.equal(row.illustrator, 'Envar Studio');
    assert.equal(row.card_type, 'Unit');
    assert.ok(JSON.parse(row.card_facts).rb_domain, 'card_facts is a JSON string on the row');
  });
});

describe('the comps query', () => {
  const row = R.invRowFrom(R.normalizeCard(ALT, OGN), { finish: 'Foil' });
  it('names the game, and strips the "(OGN)" the set name carries', () => {
    assert.equal(compsQueryFor('riftbound', row, row.number),
      'Riftbound Darius, Trifarian 027a/298 Origins');
  });
  // Unlike Magic, whose titles rarely carry a collector number. Riftbound sellers do quote it, and
  // the lettered suffix is exactly what separates a US$6 alt art from an US$0.24 base print.
  it('keeps the number as a FILTER, because Riftbound titles carry it', () => {
    assert.equal(compsNumberMatch('riftbound', '027a/298'), '027a/298');
    assert.equal(compsNumberMatch('mtg', '027a/298'), null, 'Magic is the exception, not the rule');
  });
});
