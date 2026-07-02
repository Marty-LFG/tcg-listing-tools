// lib/channels/ebay-map.mjs — the ONE mapping layer: inventory item (+batch) →
// canonical eBay listing object. CSV (Phase 1) and the Sell Inventory API (Phase 2)
// serialize THIS shape — they must never re-derive titles/aspects themselves.
//
// Titles + descriptions come from lib/listing-copy.mjs (Golden Rules 6/8/9 single
// source). Category/aspect/condition values were resolved LIVE against the eBay AU
// Taxonomy API on 2026-07-02 (tree 15 v125) and are pinned in data/ebay-categories.json
// (gitignored live cache) with the same values baked here as defaults — a fresh
// clone works without the cache file (Golden Rule 7).
//
// LIVE FINDING (multi-variation): in category 183454 only "Card Condition" and
// "Customised" are variation-enabled aspects, so a card-per-variation listing is
// NOT properly supported on EBAY_AU. Per-card is the primary shape; the variation
// CSV uses a custom 'Card' specific and stays EXPERIMENTAL until a real 3-row
// sample upload passes on the owner's account.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTitle, buildDescription, rowToFields, variationTitle, variationAttrs } from '../listing-copy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CATEGORIES_PATH = path.join(ROOT, 'data', 'ebay-categories.json');

// Baked defaults = the 2026-07-02 live resolution (mirror of data/ebay-categories.json).
const DEFAULTS = {
  marketplace: 'EBAY_AU',
  categoryTreeId: '15',
  games: {
    pokemon: { categoryId: '183454', gameAspect: 'Pokémon TCG' },
    lorcana: { categoryId: '183454', gameAspect: 'Disney Lorcana' },
    mtg: { categoryId: '183454', gameAspect: 'Magic: The Gathering' },
    swu: { categoryId: '183454', gameAspect: 'Star Wars: Unlimited' },
    riftbound: { categoryId: '183454', gameAspect: 'Riftbound' },
  },
  requiredAspects: ['Game'],
  conditionIds: { raw: 4000, graded: 2750 },
  cardConditionAspectValues: ['Near Mint or Better', 'Lightly Played (Excellent)', 'Moderately Played (Very Good)', 'Heavily Played (Poor)'],
  professionalGrader: {
    PSA: 'Professional Sports Authenticator (PSA)', BGS: 'Beckett Grading Services (BGS)',
    CGC: 'Certified Guaranty Company (CGC)', SGC: 'Sportscard Guaranty Corporation (SGC)',
    TAG: 'Technical Authentication & Grading (TAG)', ARK: 'ARK Grading (ARK)',
    CGA: 'Card Grading Australia (CGA)', PCG: 'Premier Card Grading (PCG)', TCG: 'Trading Card Grading (TCG)',
  },
};

export function loadEbayCategories() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')) }; }
  catch { return DEFAULTS; }
}

// Collectr/tool condition string → the eBay AU "Card Condition" aspect enum.
export function cardConditionAspect(condition) {
  const c = (condition || '').toLowerCase();
  if (/damag|\bdmg\b|poor|heav/.test(c)) return 'Heavily Played (Poor)';
  if (/moderat|\bmp\b/.test(c)) return 'Moderately Played (Very Good)';
  if (/light|\blp\b|excellent/.test(c)) return 'Lightly Played (Excellent)';
  return 'Near Mint or Better';    // NM default — matches the under-promising default cond
}

// One inventory row (an inventory_items record or an in-grid ImportRow) → canonical listing.
export function toEbayListing(item, batch, cats) {
  cats = cats || loadEbayCategories();
  const game = item.game;
  const gcfg = (cats.games && cats.games[game]) || null;
  const graded = !!(item.graded || item.grading_company);
  const f = rowToFields({
    game, name: item.name, number: item.number, set_name: item.set_name, rarity: item.rarity,
    finish: item.finish || item.variant, language: item.language, condition: item.condition,
    edition: item.edition, graded, grading_company: item.grading_company, grade: item.grade,
    grade_label: item.grade_label,
  });
  const title = (item.title_override && item.title_override.trim()) || buildTitle(game, f);
  const descriptionHtml = (item.desc_override && item.desc_override.trim()) || buildDescription(game, f, graded ? { slab: true } : undefined);

  const aspects = {};
  if (gcfg) aspects['Game'] = gcfg.gameAspect;                    // the ONE required aspect (verified live)
  if (item.name) aspects['Card Name'] = item.name;
  if (item.set_name) aspects['Set'] = item.set_name;              // Collectr set name verbatim when unresolved
  if (item.number) aspects['Card Number'] = String(item.number);
  if (item.rarity) aspects['Rarity'] = item.rarity;
  const fin = item.finish || item.variant;
  if (fin && fin !== 'Base') aspects['Finish'] = fin;
  aspects['Language'] = item.language || 'English';
  if (item.edition && /1st/i.test(item.edition)) aspects['Features'] = '1st Edition';   // no Edition aspect in 183454
  if (graded) {
    aspects['Graded'] = 'Yes';
    const grader = (cats.professionalGrader || {})[String(item.grading_company || '').toUpperCase()];
    if (grader) aspects['Professional Grader'] = grader;
    if (item.grade != null) aspects['Grade'] = String(+item.grade).replace(/\.0$/, '');
    if (item.cert_number) aspects['Certification Number'] = String(item.cert_number);
  } else {
    aspects['Graded'] = 'No';
    aspects['Card Condition'] = cardConditionAspect(item.condition);
  }

  return {
    sku: item.sku || null,
    game,
    title,
    categoryId: gcfg ? gcfg.categoryId : null,
    conditionId: graded ? (cats.conditionIds.graded || 2750) : (cats.conditionIds.raw || 4000),
    price_cents: item.target_price_cents != null ? item.target_price_cents : (item.price_cents != null ? item.price_cents : null),
    quantity: item.quantity != null ? item.quantity : 1,
    aspects,
    imageUrl: item.image_url || item.image || null,
    descriptionHtml,
    graded,
    value_source: item.value_source || null,
    variantKey: [item.identity_key || item.name, item.variant].filter(Boolean).join('|'),
  };
}

// validate(listing) — errors HARD-BLOCK export (a broken row must never reach eBay);
// warnings surface in the pre-flight report but don't block.
export function validateListing(l, cats) {
  cats = cats || loadEbayCategories();
  const errors = [], warnings = [];
  if (!l.categoryId) errors.push('no eBay category for game "' + (l.game || '?') + '" — unsupported game');
  for (const req of cats.requiredAspects || []) {
    if (!l.aspects || !l.aspects[req]) errors.push('missing required aspect "' + req + '"');
  }
  if (l.price_cents == null || !(l.price_cents > 0)) errors.push('no price (needs_price) — set a price or override before export');
  if (!l.title || !l.title.trim()) errors.push('empty title');
  else if (l.title.length > 80) errors.push('title over 80 chars (' + l.title.length + ')');
  if (!(l.quantity > 0)) errors.push('quantity must be ≥ 1');
  if (!l.imageUrl) warnings.push('no image — eBay may catalog-match, or add a photo in Seller Hub');
  if (l.value_source === 'bulk_tier') warnings.push('tier-floor priced (no market data)');
  return { errors, warnings };
}

// Group listings into multi-variation parents (EXPERIMENTAL — see LIVE FINDING above).
// Cap enforced on VARIATIONS (card×finish rows), auto-splitting into Part 1/2… parents.
export function groupVariations(listings, { game, setName, cap = 250 } = {}) {
  const groups = [];
  for (let i = 0; i < listings.length; i += cap) groups.push(listings.slice(i, i + cap));
  return groups.map((rows, gi) => ({
    parentTitle: variationTitle(game, setName + (groups.length > 1 ? ' Part ' + (gi + 1) : ''), {}),
    variations: rows.map((l) => ({ ...l, attrs: variationAttrs({ number: l.aspects['Card Number'], name: l.aspects['Card Name'], finish: l.aspects['Finish'] }) })),
  }));
}
