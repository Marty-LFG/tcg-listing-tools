// lib/channels/shopify-map.mjs — the ONE mapping layer for the Shopify channel: an inventory row →
// a canonical Shopify product object. lib/channels/shopify-product-api.mjs serialises THIS shape into
// a ProductSetInput; it must never re-derive a title, a handle or a metafield of its own.
//
// The eBay twin is lib/channels/ebay-map.mjs and the division of labour is identical, including the
// rule that cost the Lorcana Character aspect once already: **anything derived here reads off `rowIn`
// (buildRowIn) or off `f` (rowToFields), never off the raw `item`.** A value read off `item` works
// perfectly for a row that still has its lookup facts attached and silently vanishes the moment the
// row has been round-tripped through the database.
//
// FOUR THINGS THIS FILE IS RESPONSIBLE FOR GETTING RIGHT
//
//   1. THE IDENTITY. The PDP's condition selector is spec §5.3's signature pattern, and it renders
//      from a bk_card_identity metaobject whose `listings` array lists the per-condition siblings —
//      Liquid cannot query products by metafield, so nothing else can join them. The identity is
//      stockKey() minus its condition segment, which means it is DERIVED, not invented: two rows that
//      are the same card in different conditions produce the same identity by construction.
//   2. NO eBAY POSTAGE COPY. buildDescription's postage sentence quotes a banded dollar amount that
//      comes off an eBay fulfilment policy. Shopify's shipping is different and settled (tracked-only,
//      AU-only, free over $300) and the THEME renders it from schema settings. A Shopify PDP quoting
//      an eBay band amount is a false statement to a buyer. So this file composes its own description
//      from the shared product sentences and carries no shipping copy at all —
//      test/invariants/shopify-no-ebay-postage.test.mjs holds the line.
//   3. THE v1 SCOPE REFUSAL. Pokémon raw singles only. The refusal lands with the mapper, before the
//      scope does, because a mapper that silently half-handles a slab is worse than one that says no.
//   4. SEARCH TAGS. Shopify's predictive search ANDs its tokens, so the rarity abbreviation and the
//      set code have to be in tags or "SIR 186/159" finds nothing.
//
// Money is integer cents throughout (GR3); the decimal string is produced at the API edge only.
import { buildRowIn } from './ebay-map.mjs';
import {
  rowToFields, pkmRarityAbbrev,
  CARD_CONDITION_SUFFIX, CARD_PROTECTION, CARD_FOOTER,
  SLAB_CONDITION_SUFFIX, SLAB_PROTECTION,
} from '../listing-copy.mjs';
import { stockKey, conditionKey } from '../inventory.mjs';

// The theme keys its 63:88 product-card aspect ratio off product.type, matching SHOPIFY_TARGET_FOR in
// lib/listing-image-targets.mjs. A value outside this set renders a letterboxed card on every tile, so
// it is a closed vocabulary rather than a free string.
export const PRODUCT_TYPES = Object.freeze({
  single: 'Single',
  slab: 'Graded Slab',
  sealed: 'Sealed',
  bundle: 'Mystery Bundle',
  accessory: 'Accessory',
});

// Shopify's standard taxonomy, assigned alongside the bkc metafields rather than instead of them: the
// taxonomy has no set / number / language for a trading card, and the bkc namespace has no standing
// with the agentic channels. The two layers do not substitute (bk-shopify D-018/D-020).
export const TAXONOMY = Object.freeze({ single: 'ae-2-2-3-2', sealed: 'tg-2-7', accessory: 'tg-2-6' });

// v1 scope. Widening this is a deliberate act with its own tests, not a config edit.
export const V1_GAMES = Object.freeze(['pokemon']);

// The condition ladder, in the order the PDP renders its tiles. conditionKey() already normalises the
// free-text condition to these codes; this is the display word and the handle suffix for each.
const CONDITION_WORD = Object.freeze({
  NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played',
});

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A Shopify handle: lowercase, alphanumeric and hyphens, no runs, no edges, ≤255.
export function slug(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents rather than dropping the letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255)
    .replace(/-+$/g, '');
}

// --- identity ------------------------------------------------------------------------------------

// The card, independent of which condition copy is in hand. stockKey() is
//   game | identity_key | variantKey | LANGUAGE | (R:cond | G:company:grade)
// and dropping that last segment is exactly "the same card, any condition". Deriving it rather than
// inventing a second scheme is what guarantees the siblings agree: two rows can only disagree about
// their identity if they already disagree about what card they are.
export function identityKeyFor(item) {
  const parts = stockKey(item).split('|');
  return parts.slice(0, 4).join('|');
}

export function identityHandleFor(item) {
  return slug(identityKeyFor(item).replace(/\|/g, '-'));
}

// One product per condition (D-012), so the sibling handle is the identity plus the condition code.
// A graded slab is one of one and has no ladder, so it is keyed by its cert instead — that is also
// its SKU.
export function productHandleFor(item, f) {
  const base = identityHandleFor(item);
  const graded = !!(item.graded || item.grading_company);
  if (graded) {
    const cert = String(item.cert_number || '').trim();
    const tail = cert ? slug(cert) : slug([item.grading_company, item.grade].filter(Boolean).join('-'));
    return tail ? `${base}-${tail}` : base;
  }
  const code = conditionKey(item.condition);
  return code ? `${base}-${code.toLowerCase()}` : base;
}

// --- title ---------------------------------------------------------------------------------------

// Deterministic, and carrying set / number / language / condition in the text itself. That is not
// decoration: agentic surfaces cannot filter on TCG attributes (their aspect allowlist is
// Colour/Size/Gender, and condition is new/secondhand only), so the title IS how card data reaches
// them (bk-shopify D-020). It also matches the shape bk-shopify's seed catalog used, which is what
// the storefront was built and reviewed against.
//
//   raw   Iono 186/159 White Flare [Japanese] — Near Mint
//   slab  Charizard 4/102 Base Set [English] — PSA 9
//
// Shopify has no 80-character title cap, so unlike fitTitle() nothing is abbreviated or dropped here.
export function buildShopifyTitle(item, f) {
  const graded = !!(item.graded || item.grading_company);
  const head = [f.name, f.num, f.set].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  const lang = String(f.lang || '').trim();
  const langPart = lang ? ` [${lang}]` : '';
  const tail = graded
    ? [String(item.grading_company || '').toUpperCase(), item.grade != null ? String(+item.grade) : '']
      .filter(Boolean).join(' ')
    : (CONDITION_WORD[conditionKey(item.condition)] || String(item.condition || '').trim());
  return (head + langPart + (tail ? ` — ${tail}` : '')).trim();
}

// --- description ---------------------------------------------------------------------------------

// Composed HERE rather than through buildDescription(), and the reason is the postage sentence: that
// function pairs the protection wording with postagePhrase(f.postageBand), a banded dollar amount that
// belongs to an eBay fulfilment policy. What carries over is the PRODUCT wording — condition,
// protection, footer, and the slab variants — imported from lib/listing-copy.mjs so there is one copy
// of each sentence and no mirror to keep in step.
//
// The frame is deliberately plain: the storefront theme owns the trust rows, the shipping facts, the
// payment chips and the condition guide, all schema-driven so Marty edits them in the theme editor
// (invariant 8). Restating any of them in descriptionHtml would be a second place for them to be wrong.
export function buildShopifyDescription(item, f) {
  if (item.desc_override && String(item.desc_override).trim()) return String(item.desc_override).trim();
  const graded = !!(item.graded || item.grading_company);
  const cond = esc(f.cond) + esc(graded ? SLAB_CONDITION_SUFFIX : CARD_CONDITION_SUFFIX);
  const protection = esc(graded ? SLAB_PROTECTION : CARD_PROTECTION);

  const rows = [
    ['Set', f.set], ['Card number', f.num], ['Rarity', f.rarity],
    ['Finish', f.finish], ['Language', f.lang],
  ];
  if (graded) {
    rows.push(['Graded by', item.grading_company || '']);
    rows.push(['Grade', item.grade != null ? String(item.grade) : (f.grade_label || '')]);
    rows.push(['Cert number', item.cert_number || '']);
  } else {
    rows.push(['Condition', CONDITION_WORD[conditionKey(item.condition)] || item.condition || '']);
  }
  const table = rows
    .filter((r) => r[1] !== '' && r[1] != null)
    .map((r) => `<tr><th scope="row">${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`)
    .join('');

  return [
    `<p>${cond}</p>`,
    `<p>${protection}</p>`,
    table ? `<table><tbody>${table}</tbody></table>` : '',
    `<p>${esc(CARD_FOOTER)}</p>`,
  ].filter(Boolean).join('\n');
}

// --- metafields ----------------------------------------------------------------------------------

// bkc.* is the storefront's whole vocabulary: the PDP details table, the nine Search & Discovery
// filters (D-027) and the per-set automated collections all read these. An empty value is OMITTED
// rather than written blank — productSet REPLACES the metafield list wholesale, and a blank string is
// a value that renders as an empty row rather than as an absent one.
export function buildMetafields(item, f, { identityGid } = {}) {
  const graded = !!(item.graded || item.grading_company);
  const out = [];
  const put = (key, value, type = 'single_line_text_field') => {
    if (value == null || String(value).trim() === '') return;
    out.push({ namespace: 'bkc', key, value: String(value), type });
  };
  put('game', item.game);
  put('set_code', item.set_code || f.setSymbol);
  put('set_name', f.set);
  put('card_number', f.num);
  put('rarity', f.rarity);
  put('language', f.lang);
  put('printing', f.finish);
  if (graded) {
    put('grading_company', item.grading_company);
    put('grade', item.grade != null ? String(item.grade) : '');
    put('cert_number', item.cert_number);
  } else {
    put('condition', CONDITION_WORD[conditionKey(item.condition)] || item.condition);
  }
  // Boolean metafields take the STRING 'true'/'false'. Japanese specifically, not "non-English": the
  // field drives the Japanese Imports collection and its visual treatment, and D-027 verified it
  // one-for-one against the Japanese-language rows. A Chinese or Korean printing is an import too, but
  // it is not this one, and widening the meaning would quietly wrong-file it.
  out.push({ namespace: 'bkc', key: 'is_japanese_import', value: String(/^ja|^jp/i.test(String(item.language || '')) || /japanese/i.test(String(f.lang || ''))), type: 'boolean' });
  put('release_status', item.release_status || 'in-stock');
  // The stable upsert key. Backed by a metafield definition of type `id`, which Shopify configures as
  // unique automatically — that is what lets productSet key on identifier.customId instead of on
  // `handle`, which a merchant can edit out from under us and turn every later upsert into a duplicate
  // create.
  out.push({ namespace: 'custom', key: 'id', value: String(item.sku), type: 'id' });
  // Written only once the metaobject exists — on a first publish it does not yet, so the product-api
  // layer writes it back after metaobjectUpsert (the publish sequence's step 5).
  if (identityGid) out.push({ namespace: 'bkc', key: 'card', value: identityGid, type: 'metaobject_reference' });
  return out;
}

// --- tags ----------------------------------------------------------------------------------------

// Tags exist for SEARCH, not for merchandising — collections do merchandising. Predictive search ANDs
// its tokens, so every token a buyer might reasonably type has to appear in the indexed text
// somewhere, and a bkc metafield is not indexed. Set code and rarity abbreviation are the two that
// bite: "SIR 186/159" matches nothing without them.
export function buildTags(item, f) {
  const graded = !!(item.graded || item.grading_company);
  const tags = new Set();
  const add = (v) => { const s = String(v == null ? '' : v).trim(); if (s) tags.add(s); };
  add(item.game);
  add(item.set_code || f.setSymbol);
  add(f.set);
  add(f.rarity);
  if (item.game === 'pokemon') add(pkmRarityAbbrev(f.rarity));
  add(f.lang);
  add(f.finish);
  add(graded ? 'graded' : 'raw');
  if (!graded) add(CONDITION_WORD[conditionKey(item.condition)]);
  if (graded) { add(item.grading_company); add(item.grade != null ? `${String(item.grading_company || '').toUpperCase()} ${+item.grade}` : ''); }
  return [...tags];
}

// --- the mapper ----------------------------------------------------------------------------------

/**
 * toShopifyProduct(item, opts) -> the canonical product object.
 *
 * opts: { cats, identityGid, collections }
 *  - cats:        the eBay category cache, threaded only because buildRowIn takes it. Unused otherwise.
 *  - identityGid: the bk_card_identity metaobject GID, when it is already known.
 *  - collections: { byGame?, bySet?, japaneseImports? } handle map from data/shopify.config.json.
 *                 Per-set collections should be AUTOMATED collections keyed on bkc.set_code, which
 *                 need no assignment at all — this map is for the manual ones only.
 */
export function toShopifyProduct(item, opts = {}) {
  const rowIn = buildRowIn(item, opts.cats);
  // No `shipping` is threaded, deliberately: resolveRowBand would put an eBay postage band on `f`,
  // and nothing on the Shopify side may read one.
  const f = rowToFields(rowIn);
  const graded = !!(item.graded || item.grading_company);

  const identityKey = identityKeyFor(item);
  const identityHandle = identityHandleFor(item);
  const handle = productHandleFor(item, f);

  // Same precedence as toEbayListing: the authored ask wins over whatever the row was last priced at,
  // so the two channels start from one number.
  const price_cents = item.target_price_cents != null ? item.target_price_cents
    : (item.price_cents != null ? item.price_cents : null);

  const collections = [];
  const cmap = opts.collections || {};
  if (cmap.byGame && cmap.byGame[item.game]) collections.push(cmap.byGame[item.game]);
  if (cmap.bySet && cmap.bySet[item.set_code || f.setSymbol]) collections.push(cmap.bySet[item.set_code || f.setSymbol]);
  if (cmap.japaneseImports && /japanese/i.test(String(f.lang || ''))) collections.push(cmap.japaneseImports);

  // Pre-orders must stay buyable at zero on hand — they have not arrived, they are not sold out. DENY
  // everywhere else, because CONTINUE on a one-of-one card is a guaranteed oversell.
  const preorder = String(item.release_status || '').toLowerCase() === 'pre-order';

  return {
    sku: item.sku || null,
    customId: item.sku ? { namespace: 'custom', key: 'id', value: String(item.sku) } : null,
    kind: 'inventory',
    itemId: item.id != null ? item.id : null,
    game: item.game,

    identityKey,
    identityHandle,
    handle,
    title: (item.title_override && String(item.title_override).trim()) || buildShopifyTitle(item, f),
    descriptionHtml: buildShopifyDescription(item, f),
    productType: graded ? PRODUCT_TYPES.slab : PRODUCT_TYPES.single,
    taxonomyCategory: TAXONOMY.single,
    vendor: 'Binders Keepers',
    status: 'ACTIVE',
    tags: buildTags(item, f),

    price_cents,
    quantity: item.quantity != null ? item.quantity : 1,
    inventoryPolicy: preorder ? 'CONTINUE' : 'DENY',
    tracked: true,

    metafields: buildMetafields(item, f, { identityGid: opts.identityGid }),
    collections,

    // What the identity metaobject should say. `listings` is NOT here on purpose: it is recomputed
    // from the database by the identity.rebuild job, because appending to it from a publish is a
    // read-modify-write race that silently drops a condition from the PDP.
    identity: {
      handle: identityHandle,
      type: 'bk_card_identity',
      fields: {
        // The short form the spec specifies — "Iono SIR 186/159 (JP)". It is an admin-facing label on
        // the metaobject, so the abbreviation and the language CODE read better than the long words
        // the product title carries.
        display_name: [
          f.name,
          (item.game === 'pokemon' ? pkmRarityAbbrev(f.rarity) : '') || f.rarity,
          f.num,
          `(${String(item.language || 'EN').toUpperCase()})`,
        ].filter(Boolean).join(' '),
        game: item.game || '',
        set_code: String(item.set_code || f.setSymbol || ''),
        set_name: f.set || '',
        card_number: f.num || '',
        language: f.lang || '',
        printing: f.finish || '',
      },
    },

    // Source URLs only. The compositor renders the Shopify frames and the media layer stages them;
    // this is the same division buildRowIn already makes for eBay.
    imageSources: [f.img || item.image_url || item.image || null, ...(Array.isArray(item.photo_urls) ? item.photo_urls : [])]
      .filter(Boolean).filter((u, i, a) => a.indexOf(u) === i),
  };
}

// --- validation ----------------------------------------------------------------------------------

/**
 * validateProduct(p, item) -> { errors, warnings }
 * Errors HARD-BLOCK a publish. A row that reaches Shopify wrong is worse than a row that does not
 * reach it at all — the storefront is customer-facing and a wrong card is a dispute (GR4/GR7).
 */
export function validateProduct(p, item = {}) {
  const errors = [], warnings = [];
  const graded = !!(item.graded || item.grading_company);

  // --- the v1 scope gate. It lands BEFORE the scope does, on purpose. ---
  if (!V1_GAMES.includes(String(p.game || ''))) {
    errors.push(`v1 publishes Pokémon only — "${p.game || '?'}" is out of scope until its Shopify mapping is verified`);
  }
  if (graded) {
    errors.push('v1 publishes RAW singles only — graded slabs land in the next slice (cert-as-SKU, no condition ladder)');
  }
  if (p.kind !== 'inventory') {
    errors.push(`v1 publishes singles only — "${p.kind}" stock has its own tables and its own listing unit`);
  }

  // --- identity, without which the PDP condition selector cannot render ---
  if (!p.sku) errors.push('no SKU — the SKU is the join key across local stock, Shopify and eBay');
  if (String(p.sku || '').startsWith('STG-')) {
    errors.push('provisional SKU — a real shelf label is committed at publish, never a staged one');
  }
  if (!item.identity_key) {
    errors.push('no identity_key — the card identity cannot be derived, and without it the PDP condition tiles have nothing to group on');
  }
  if (!p.identityHandle) errors.push('empty identity handle');
  if (!p.handle) errors.push('empty product handle');
  if (!graded && !conditionKey(item.condition)) {
    errors.push('unknown condition — it is part of the identity and of the handle, so it cannot be guessed');
  }

  // --- the things a storefront cannot render around ---
  if (!p.title || !p.title.trim()) errors.push('empty title');
  else if (p.title.length > 255) errors.push(`title over 255 chars (${p.title.length})`);
  if (p.price_cents == null || !(p.price_cents > 0)) {
    errors.push('no price — set a price before publish, never publish a card at zero');
  }
  if (!Object.values(PRODUCT_TYPES).includes(p.productType)) {
    errors.push(`productType "${p.productType}" is outside the theme's vocabulary — the product card would letterbox`);
  }
  if (p.quantity != null && p.quantity < 0) errors.push('negative quantity');

  // --- warnings: publishable, but somebody should look ---
  if (!p.imageSources || !p.imageSources.length) {
    warnings.push('no image — the storefront renders a placeholder, and position 1 must be the actual card');
  }
  if (!p.metafields.some((m) => m.key === 'set_code')) warnings.push('no set_code — the per-set automated collection cannot pick this up');
  if (!p.metafields.some((m) => m.key === 'rarity')) warnings.push('no rarity — one of the nine storefront filters will not see this product');
  if (p.quantity === 0) warnings.push('quantity 0 — publishes as sold out and sinks to the end of every grid');
  if (item.value_source === 'bulk_tier') warnings.push('tier-floor priced (no market data)');

  return { errors, warnings };
}
