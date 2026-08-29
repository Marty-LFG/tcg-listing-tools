// test/unit/shopify-map.test.mjs — the Shopify mapping layer (lib/channels/shopify-map.mjs).
// Offline and deterministic: no network, no DB, no config. The eBay twin is test/unit/ebay-map.test.mjs.
//
// The properties under test are the four the module's header claims responsibility for — the identity
// is derived rather than invented, no eBay postage copy reaches the storefront, the v1 scope refusal
// lands before the scope does, and the search tags carry what predictive search needs — plus the
// golden shapes for a representative spread of rows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toShopifyProduct, validateProduct, buildShopifyTitle, buildShopifyDescription,
  identityKeyFor, identityHandleFor, productHandleFor, buildTags, buildMetafields, slug,
  PRODUCT_TYPES, TAXONOMY,
} from '../../lib/channels/shopify-map.mjs';

// A base row shaped like an inventory_items record after a DB round-trip — i.e. WITHOUT the lookup
// facts a freshly-scanned row still carries. That is the shape that has broken derivations before, so
// it is the shape the fixtures use.
const base = {
  id: 7, sku: 'AAC-085', game: 'pokemon', identity_key: 'sv8a-102',
  name: 'Iono', number: '186/159', set_name: 'White Flare', set_code: 'SV8a',
  rarity: 'Special Illustration Rare', language: 'JP', variant: 'Holo',
  condition: 'Near Mint', quantity: 1, target_price_cents: 12999,
  image_url: 'https://cdn.example/iono.png',
};
const row = (over = {}) => ({ ...base, ...over });
const mf = (p, key) => (p.metafields.find((m) => m.key === key) || {}).value;

describe('the identity is derived, not invented', () => {
  it('is stockKey minus its condition segment', () => {
    assert.equal(identityKeyFor(row()), 'pokemon|sv8a-102|HOLO|JP');
    assert.equal(identityHandleFor(row()), 'pokemon-sv8a-102-holo-jp');
  });

  it('every condition of one card lands on ONE identity and DIFFERENT handles', () => {
    const conds = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played'];
    const products = conds.map((condition) => toShopifyProduct(row({ condition, sku: 'AAC-' + condition.length })));
    const identities = new Set(products.map((p) => p.identityHandle));
    assert.equal(identities.size, 1, 'the siblings disagreed about what card they are');
    assert.deepEqual(products.map((p) => p.handle), [
      'pokemon-sv8a-102-holo-jp-nm',
      'pokemon-sv8a-102-holo-jp-lp',
      'pokemon-sv8a-102-holo-jp-mp',
      'pokemon-sv8a-102-holo-jp-hp',
    ]);
  });

  it('separates the printings — a reverse holo is a different card, not a different condition', () => {
    const holo = identityHandleFor(row({ variant: 'Holo' }));
    const reverse = identityHandleFor(row({ variant: 'Reverse Holo' }));
    const nonHolo = identityHandleFor(row({ variant: 'Non-holo' }));
    assert.notEqual(holo, reverse);
    assert.notEqual(holo, nonHolo);
    // "Non-holo" contains "holo" — the negation must be tested first (GR5). If this ever returns
    // the holo identity, a base card is being grouped with the holo one.
    assert.match(nonHolo, /-base-/);
  });

  it('separates the languages — a JP printing is its own product, not a translation', () => {
    assert.notEqual(identityHandleFor(row({ language: 'JP' })), identityHandleFor(row({ language: 'EN' })));
  });

  it('keys a graded slab on its cert, because a slab is one of one with no ladder', () => {
    const slab = row({ graded: 1, grading_company: 'PSA', grade: 9, cert_number: '84512203', condition: '' });
    assert.equal(productHandleFor(slab, {}), 'pokemon-sv8a-102-holo-jp-84512203');
  });

  it('slug is handle-safe and strips accents rather than dropping the letter', () => {
    assert.equal(slug('Pokémon — White Flare!'), 'pokemon-white-flare');
    assert.equal(slug('  --a--  '), 'a');
    assert.equal(slug(null), '');
  });
});

describe('titles carry the card data in the text', () => {
  it('raw single: name, number, set, language, condition', () => {
    assert.equal(toShopifyProduct(row()).title, 'Iono 186/159 White Flare [Japanese] — Near Mint');
  });
  it('graded slab: the grade replaces the condition', () => {
    const slab = row({ graded: 1, grading_company: 'psa', grade: 9, cert_number: '84512203', language: 'EN', condition: '' });
    assert.equal(toShopifyProduct(slab).title, 'Iono 186/159 White Flare [English] — PSA 9');
  });
  it('an explicit title_override wins', () => {
    assert.equal(toShopifyProduct(row({ title_override: '  Hand written  ' })).title, 'Hand written');
  });
  it('survives a row with almost nothing on it rather than emitting punctuation soup', () => {
    const t = buildShopifyTitle({ condition: 'Near Mint' }, { name: 'Iono', num: '', set: '', lang: '' });
    assert.equal(t, 'Iono — Near Mint');
  });
});

describe('no eBay postage copy reaches the storefront', () => {
  // The eBay description pairs the protection sentence with postagePhrase(band) — a dollar amount that
  // belongs to an eBay fulfilment policy. Shopify's shipping is different and settled, and the THEME
  // renders it from schema settings. A figure here would be a false statement to a buyer.
  const html = buildShopifyDescription(row(), {
    name: 'Iono', num: '186/159', set: 'White Flare', rarity: 'Special Illustration Rare',
    finish: 'Holo', lang: 'Japanese', cond: 'Near Mint',
  });

  it('quotes no postage amount at all', () => {
    assert.doesNotMatch(html, /\$\s*\d/, 'a dollar figure in the product description');
    assert.doesNotMatch(html, /postage|shipping|tracked|satchel|letter/i, 'shipping copy belongs to the theme');
  });
  it('carries the parcel sentence, from the shared constant', () => {
    assert.match(html, /penny sleeve and toploader inside a rigid mailer/);
  });
  it('drops the eBay-marketplace idiom entirely (A7)', () => {
    // "Thanks for looking" belongs to a listing among many; "item specifics" names an eBay UI element
    // that does not exist on Shopify. Neither survives the move.
    assert.doesNotMatch(html, /Thanks for looking/i);
    assert.doesNotMatch(html, /item specifics/i);
    assert.doesNotMatch(html, /smoke-free/i);
  });
  it('escapes what it interpolates', () => {
    const evil = buildShopifyDescription(row({ set_name: '<script>x</script>' }), { set: '<script>x</script>', cond: 'NM' });
    assert.doesNotMatch(evil, /<script>x/);
    assert.match(evil, /&lt;script&gt;/);
  });
  it('emits no table — every consuming surface flattens markup to text', () => {
    // Flattened, a table reads "Set White Flare Card number 186/159 Rarity ..." — worse for an agent
    // than the same facts in grammar, and a duplicate of the bk-product-facts panel the PDP renders.
    assert.doesNotMatch(html, /<table|<tr|<th|<td/);
  });
  it('a slab leads on grader and grade, and carries the cert', () => {
    const slab = row({ graded: 1, grading_company: 'PSA', grade: 9, cert_number: '84512203' });
    const h = buildShopifyDescription(slab, { name: 'Iono', num: '186/159', set: 'White Flare', lang: 'English' });
    assert.match(h, /^<p>PSA 9 /);
    assert.match(h, /cert 84512203/);
    assert.match(h, /Ships securely inside a rigid mailer/);
  });
  it('leads with the identity, and closes it inside the snippet budget', () => {
    // The audience is a Google snippet, a Shop card and a product feed — the PDP renders no
    // description block at all. A snippet cuts near 160 characters, so the whole card has to land
    // before that or the one thing the surface exists to say is the thing it truncates.
    const flat = toShopifyProduct(row()).descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const identity = flat.split('.')[0];
    assert.ok(identity.length < 160, `identity is ${identity.length} chars, past the snippet cut`);
    assert.match(flat, /^Near Mint Special Illustration Rare Pokémon single —/);
  });

  it('carries what the TITLE cannot, which is the whole reason it exists (D-020)', () => {
    // buildShopifyTitle already ships name, number, set, language and condition. Agents cannot filter
    // on trading-card attributes, so game / rarity / set code / printing reach them only through here.
    const p = toShopifyProduct(row());
    assert.doesNotMatch(p.title, /Pokémon|Special Illustration Rare|SV8a|Holo/);
    for (const token of ['Pokémon', 'Special Illustration Rare', 'SV8a', 'Holo']) {
      assert.ok(p.descriptionHtml.includes(token), `description is missing ${token}`);
    }
  });

  it('siblings differ in the FIRST words, not the last', () => {
    // D-012 gives every condition its own product, so four URLs share a description bar one token.
    // Buried at the end it differentiates nothing in a search result.
    const nm = toShopifyProduct(row({ condition: 'Near Mint' })).descriptionHtml;
    const lp = toShopifyProduct(row({ condition: 'Lightly Played' })).descriptionHtml;
    assert.match(nm, /^<p>Near Mint /);
    assert.match(lp, /^<p>Lightly Played /);
  });

  it('never promises a photo it does not have', () => {
    // Not keepable for every product: a pre-order has no card to photograph, and validateProduct only
    // WARNS on a row with no image rather than refusing it.
    const ok = buildShopifyDescription(row(), { img: 'https://x/y.png', cond: 'NM' });
    assert.match(ok, /we photograph the actual card/);
    for (const over of [{ release_status: 'pre-order' }, { image_url: null, image: null }]) {
      const h = toShopifyProduct(row(over)).descriptionHtml;
      assert.doesNotMatch(h, /we photograph the actual card/, JSON.stringify(over));
      // …but the provenance line is unconditional, because it is true of everything we sell.
      assert.match(h, /Run by collectors in Newcastle, not a warehouse\./);
    }
  });

  it("suppresses 'Normal', the one finish that says nothing", () => {
    assert.doesNotMatch(toShopifyProduct(row({ variant: 'Normal' })).descriptionHtml, /Normal/);
    assert.match(toShopifyProduct(row({ variant: 'Holofoil' })).descriptionHtml, /Holofoil/);
  });

  it('degrades to English with rarity, printing and set code all missing', () => {
    const h = toShopifyProduct(row({ rarity: '', variant: '', set_code: '' })).descriptionHtml;
    assert.match(h, /^<p>Near Mint Pokémon single — Iono 186\/159, White Flare, Japanese\.<\/p>/);
    assert.doesNotMatch(h, /\(\)|,\s*,|—\s*,|\s\./, 'punctuation left stranded by a missing field');
  });

  it('a desc_override wins outright', () => {
    assert.equal(buildShopifyDescription(row({ desc_override: '  <p>mine</p>  ' }), {}), '<p>mine</p>');
  });
});

describe('metafields', () => {
  const p = toShopifyProduct(row());

  it('writes the bkc vocabulary the storefront filters and PDP read', () => {
    assert.equal(mf(p, 'game'), 'pokemon');
    assert.equal(mf(p, 'set_code'), 'SV8a');
    assert.equal(mf(p, 'set_name'), 'White Flare');
    assert.equal(mf(p, 'card_number'), '186/159');
    assert.equal(mf(p, 'rarity'), 'Special Illustration Rare');
    assert.equal(mf(p, 'language'), 'Japanese');
    assert.equal(mf(p, 'printing'), 'Holo');
    assert.equal(mf(p, 'condition'), 'Near Mint');
    assert.equal(mf(p, 'release_status'), 'in-stock');
    assert.ok(p.metafields.every((m) => m.namespace === 'bkc' || m.namespace === 'custom'));
  });

  it('omits an empty value rather than writing a blank one', () => {
    // productSet REPLACES the metafield list, and a blank string renders as an empty PDP row rather
    // than as an absent one.
    const bare = toShopifyProduct(row({ rarity: '', set_code: '', variant: '' }));
    assert.equal(bare.metafields.find((m) => m.key === 'rarity'), undefined);
    assert.equal(bare.metafields.find((m) => m.key === 'printing'), undefined);
  });

  it('is_japanese_import is a boolean STRING, and means Japanese specifically', () => {
    const jp = buildMetafields(row({ language: 'JP' }), { lang: 'Japanese' });
    const en = buildMetafields(row({ language: 'EN' }), { lang: 'English' });
    const zh = buildMetafields(row({ language: 'ZH-TW' }), { lang: 'Chinese' });
    const get = (a) => a.find((m) => m.key === 'is_japanese_import');
    assert.equal(get(jp).value, 'true');
    assert.equal(get(jp).type, 'boolean');
    assert.equal(get(en).value, 'false');
    assert.equal(get(zh).value, 'false', 'a Chinese printing is an import, but it is not THIS field');
  });

  // This test previously asserted type:'id' and was WRONG — it encoded the assumption that produced
  // METAFIELD_MISMATCH on the very first real publish. When custom.id is also identifier.customId,
  // Shopify requires it in the metafields array (so the identifier cannot be deleted by omission) but
  // refuses the mutation if it carries its type. Measured against the real dev store 2026-08-25:
  // identical payloads, type present vs absent — the first is refused, the second creates the product.
  // The definition on the store already fixes the type, so uniqueness is enforced either way.
  it('carries the custom.id upsert key with NO type — productSet refuses it otherwise', () => {
    const k = p.metafields.find((m) => m.namespace === 'custom' && m.key === 'id');
    assert.equal(k.value, 'AAC-085');
    assert.ok(!('type' in k), 'sending `type` on the identifying metafield causes METAFIELD_MISMATCH');
    assert.deepEqual(p.customId, { namespace: 'custom', key: 'id', value: 'AAC-085' });
  });

  it('still types every metafield that is NOT the identifier', () => {
    for (const m of p.metafields.filter((x) => !(x.namespace === 'custom' && x.key === 'id'))) {
      assert.ok(m.type, `${m.namespace}.${m.key} must keep its type — only the identifier is special`);
    }
  });

  it('writes bkc.card only once the identity metaobject exists', () => {
    assert.equal(p.metafields.find((m) => m.key === 'card'), undefined);
    const withId = toShopifyProduct(row(), { identityGid: 'gid://shopify/Metaobject/998877' });
    const card = withId.metafields.find((m) => m.key === 'card');
    assert.equal(card.value, 'gid://shopify/Metaobject/998877');
    assert.equal(card.type, 'metaobject_reference');
  });
});

describe('tags carry what predictive search needs', () => {
  it('includes the set code and the rarity abbreviation', () => {
    // Shopify's predictive search ANDs its tokens, so "SIR 186/159" finds nothing unless SIR is in the
    // indexed text. A bkc metafield is not indexed; a tag is.
    const tags = toShopifyProduct(row()).tags;
    assert.ok(tags.includes('SV8a'), tags.join(','));
    assert.ok(tags.includes('SIR'), tags.join(','));
    assert.ok(tags.includes('Special Illustration Rare'));
    assert.ok(tags.includes('Japanese'));
    assert.ok(tags.includes('raw'));
  });
  it('does not invent an abbreviation for a rarity that has none', () => {
    assert.ok(!buildTags(row({ rarity: 'Common' }), { rarity: 'Common' }).includes('COMMON'));
  });
  it('a slab is tagged graded, with its grader and grade', () => {
    const tags = toShopifyProduct(row({ graded: 1, grading_company: 'PSA', grade: 9, cert_number: '1' })).tags;
    assert.ok(tags.includes('graded'));
    assert.ok(tags.includes('PSA 9'));
  });
});

describe('the product shape', () => {
  it('is a single-variant Single with tracked inventory and DENY', () => {
    const p = toShopifyProduct(row());
    assert.equal(p.productType, PRODUCT_TYPES.single);
    assert.equal(p.taxonomyCategory, TAXONOMY.single);
    assert.equal(p.status, 'ACTIVE');
    assert.equal(p.tracked, true);
    // CONTINUE on a one-of-one card is a guaranteed oversell.
    assert.equal(p.inventoryPolicy, 'DENY');
    assert.equal(p.price_cents, 12999);
    assert.equal(p.quantity, 1);
  });

  it('a pre-order stays buyable at zero on hand', () => {
    // It has not arrived; it is not sold out. DENY would render it sold out on the storefront.
    assert.equal(toShopifyProduct(row({ release_status: 'pre-order', quantity: 0 })).inventoryPolicy, 'CONTINUE');
  });

  it('prefers the authored ask over the last-priced figure, exactly as the eBay mapper does', () => {
    assert.equal(toShopifyProduct(row({ target_price_cents: 500, price_cents: 900 })).price_cents, 500);
    assert.equal(toShopifyProduct(row({ target_price_cents: null, price_cents: 900 })).price_cents, 900);
    assert.equal(toShopifyProduct(row({ target_price_cents: null, price_cents: null })).price_cents, null);
  });

  it('a graded row maps to the Graded Slab type the theme keys its aspect ratio off', () => {
    const p = toShopifyProduct(row({ graded: 1, grading_company: 'PSA', grade: 9, cert_number: '1' }));
    assert.equal(p.productType, PRODUCT_TYPES.slab);
  });

  it('describes the identity metaobject but never its listings array', () => {
    // listings is recomputed from the DB by identity.rebuild — appending to it from a publish is a
    // read-modify-write race that silently drops a condition from the PDP.
    const p = toShopifyProduct(row());
    assert.equal(p.identity.type, 'bk_card_identity');
    assert.equal(p.identity.handle, 'pokemon-sv8a-102-holo-jp');
    assert.equal(p.identity.fields.display_name, 'Iono SIR 186/159 (JP)');
    assert.equal(p.identity.fields.set_code, 'SV8a');
    assert.equal(p.identity.fields.language, 'Japanese');
    assert.ok(!('listings' in p.identity.fields), 'listings must never be written from a publish');
  });

  it('dedupes image sources and keeps the card art first', () => {
    const p = toShopifyProduct(row({ photo_urls: ['https://cdn.example/iono.png', 'https://own/back.jpg'] }));
    assert.deepEqual(p.imageSources, ['https://cdn.example/iono.png', 'https://own/back.jpg']);
  });

  it('assigns only the manual collections it was given a map for', () => {
    assert.deepEqual(toShopifyProduct(row()).collections, []);
    const p = toShopifyProduct(row(), {
      collections: { byGame: { pokemon: 'gid://c/1' }, bySet: { SV8a: 'gid://c/2' }, japaneseImports: 'gid://c/3' },
    });
    assert.deepEqual(p.collections, ['gid://c/1', 'gid://c/2', 'gid://c/3']);
  });
});

describe('validateProduct — the refusals land before the scope does', () => {
  const check = (over, opts) => {
    const it2 = row(over);
    return validateProduct(toShopifyProduct(it2, opts), it2);
  };
  const errs = (over) => check(over).errors.join(' | ');

  it('passes a clean Pokémon raw single', () => {
    const v = check();
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.warnings, []);
  });

  it('refuses a game outside v1 rather than half-mapping it', () => {
    assert.match(errs({ game: 'mtg' }), /Pokémon only/);
  });

  it('refuses a graded slab — it is the next slice, not this one', () => {
    assert.match(errs({ graded: 1, grading_company: 'PSA', grade: 9, cert_number: '1' }), /RAW singles only/);
  });

  it('refuses a provisional SKU, so a preview can never burn a shelf label', () => {
    assert.match(errs({ sku: 'STG-000123' }), /provisional SKU/);
  });

  it('refuses a row with no identity_key rather than guessing one', () => {
    assert.match(errs({ identity_key: null }), /identity_key/);
  });

  it('refuses an unknown condition — it is part of the handle and cannot be guessed', () => {
    assert.match(errs({ condition: '' }), /unknown condition/);
    assert.match(errs({ condition: null }), /unknown condition/);
  });

  it('refuses a missing or zero price — never publish a card at zero', () => {
    assert.match(errs({ target_price_cents: null, price_cents: null }), /no price/);
    assert.match(errs({ target_price_cents: 0, price_cents: null }), /no price/);
  });

  it('refuses a missing SKU', () => {
    assert.match(errs({ sku: null }), /no SKU/);
  });

  it('warns rather than blocks on the things a storefront can render around', () => {
    const noImage = check({ image_url: null, image: null });
    assert.deepEqual(noImage.errors, []);
    assert.match(noImage.warnings.join(' | '), /no image/);

    const sold = check({ quantity: 0 });
    assert.deepEqual(sold.errors, []);
    assert.match(sold.warnings.join(' | '), /sold out/);

    const noRarity = check({ rarity: '', set_code: '' });
    assert.deepEqual(noRarity.errors, []);
    assert.match(noRarity.warnings.join(' | '), /set_code/);
    assert.match(noRarity.warnings.join(' | '), /rarity/);
  });
});
