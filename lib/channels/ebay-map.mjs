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
import { resolveRiftboundCard } from '../riftbound-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CATEGORIES_PATH = path.join(ROOT, 'data', 'ebay-categories.json');

// The DB stores language as a 2-letter code (EN/JP/…, see lib/normalize + lib/enumerate); eBay AU
// category 183454's Language aspect is a recommended enum of FULL names, so 'EN' won't match the
// buyer-facing "English" filter. Map code → name here (the inverse of extras.js langCode). An
// already-full value (or an unknown code) falls through verbatim rather than being dropped.
export const LANG_NAME = {
  EN: 'English', JP: 'Japanese', JA: 'Japanese', ZH: 'Chinese', CN: 'Chinese', KO: 'Korean',
  FR: 'French', DE: 'German', IT: 'Italian', ES: 'Spanish', PT: 'Portuguese', RU: 'Russian', TH: 'Thai', ID: 'Indonesian',
};
export const ebayLanguageName = (lang) => LANG_NAME[String(lang || '').toUpperCase()] || lang || 'English';

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
  const rowIn = {
    game, name: item.name, number: item.number, set_name: item.set_name, rarity: item.rarity,
    finish: item.finish || item.variant, variant: item.variant, language: item.language, condition: item.condition,
    edition: item.edition, graded, grading_company: item.grading_company, grade: item.grade,
    grade_label: item.grade_label, cert_number: item.cert_number, subgrades: item.subgrades,
  };
  // Riftbound: type/domain/tags/stats aren't persisted (identity is) — re-resolve them from
  // the baked catalog so the description carries the full card details after the DB round-trip.
  if (game === 'riftbound') {
    const idk = item.identity_key || '';
    const dash = idk.indexOf('-');
    const card = dash > 0 ? resolveRiftboundCard(idk.slice(0, dash), idk.slice(dash + 1)) : null;
    if (card) { rowIn.rb_type = card.type; rowIn.rb_domain = card.domain; rowIn.rb_tags = card.tags; rowIn.rb_e = card.e; rowIn.rb_p = card.p; rowIn.rb_m = card.m; }
  }
  const f = rowToFields(rowIn);
  const title = (item.title_override && item.title_override.trim()) || buildTitle(game, f);
  const descriptionHtml = (item.desc_override && item.desc_override.trim()) || buildDescription(game, f, graded ? { slab: true } : undefined);

  // ---- item specifics (aspects) — eBay AU category 183454. GRADING IS NOT AN ASPECT here (verified
  // live 2026-07-24): Graded/Professional Grader/Grade/Certification Number/Card Condition are
  // CONDITION DESCRIPTORS on the item condition, not aspects, so they live in conditionDescriptors
  // below. Only 'Game' is hard-required. Aspect name ≤40 / value ≤50 chars (Inventory API caps).
  const capName = (s) => { s = s == null ? '' : String(s); return s.length > 40 ? s.slice(0, 40) : s; };
  const capVal = (s) => { s = s == null ? '' : String(s); return s.length > 50 ? s.slice(0, 50) : s; };
  const aspects = {};
  const put = (name, val) => { if (val != null && String(val).trim() !== '') aspects[capName(name)] = capVal(val); };
  if (gcfg) put('Game', gcfg.gameAspect);                         // the ONE required aspect (verified live)
  put('Card Name', item.name);
  put('Set', item.set_name);                                      // Collectr set name verbatim when unresolved
  put('Card Number', item.number != null ? String(item.number) : null);
  put('Rarity', item.rarity);
  const fin = item.finish || item.variant;
  if (fin && fin !== 'Base') put('Finish', fin);
  put('Language', ebayLanguageName(item.language));               // stored code (EN) → eBay enum name (English)
  if (item.edition && /1st/i.test(item.edition)) put('Features', '1st Edition');   // no Edition aspect in 183454
  // Recommended aspects — populated only when the builder's looked-up card data is passed through
  // (a thin inventory row won't carry these; they're recommended, not required, so absence is fine).
  put('Character', item.character);
  put('Card Type', item.card_type);
  put('Speciality', item.speciality);
  put('Illustrator', item.illustrator);
  put('Card Size', item.card_size);
  put('Stage', item.stage);
  if (item.year_manufactured) put('Year Manufactured', String(item.year_manufactured));

  // ---- condition + structured condition descriptors (the eBay-correct home for grading) ----
  // Semantic form: { name, value } where name is eBay's descriptor name. The numeric name/value IDs
  // (27501/27502/27503/40001 and their value IDs) are resolved at publish time from the live
  // Metadata getItemConditionPolicies (lib/ebay-taxonomy.mjs), with a baked fallback — never guessed
  // here (a wrong grade ID is a wrong listing, Golden Rule 4).
  const conditionDescriptors = [];
  let graderName = null, cardCondition = null, gradeStr = null;
  if (graded) {
    graderName = (cats.professionalGrader || {})[String(item.grading_company || '').toUpperCase()] || null;
    conditionDescriptors.push({ name: 'Professional Grader', value: String(item.grading_company || '').toUpperCase() });
    if (item.grade != null) { gradeStr = String(+item.grade).replace(/\.0$/, ''); conditionDescriptors.push({ name: 'Grade', value: gradeStr }); }
    if (item.cert_number) conditionDescriptors.push({ name: 'Certification Number', value: String(item.cert_number) });
  } else {
    cardCondition = cardConditionAspect(item.condition);
    conditionDescriptors.push({ name: 'Card Condition', value: cardCondition });
  }

  // ---- images: source URLs (CDN card art first, then any pass-through photo URLs). The media
  // pipeline (lib/ebay-media.mjs) downloads + re-hosts these on eBay EPS and appends the generic
  // trailing image before publish; here we just carry the sources. ----
  const primary = item.image_url || item.image || null;
  const imageUrls = [];
  if (primary) imageUrls.push(primary);
  if (Array.isArray(item.photo_urls)) for (const u of item.photo_urls) if (u && !imageUrls.includes(u)) imageUrls.push(u);

  return {
    sku: item.sku || null,
    game,
    title,
    categoryId: gcfg ? gcfg.categoryId : null,
    conditionId: graded ? (cats.conditionIds.graded || 2750) : (cats.conditionIds.raw || 4000),
    price_cents: item.target_price_cents != null ? item.target_price_cents : (item.price_cents != null ? item.price_cents : null),
    quantity: item.quantity != null ? item.quantity : 1,
    aspects,
    conditionDescriptors,
    graded,
    graderName,                       // Professional Grader enum display string (CSV + description)
    grade: gradeStr,
    cert: item.cert_number || null,
    cardCondition,
    imageUrl: primary,
    imageUrls,
    descriptionHtml,
    value_source: item.value_source || null,
    variantKey: [item.identity_key || item.name, item.variant].filter(Boolean).join('|'),
  };
}

// validate(listing) — errors HARD-BLOCK publish/export (a broken row must never reach eBay);
// warnings surface in the pre-flight report but don't block.
export function validateListing(l, cats) {
  cats = cats || loadEbayCategories();
  const errors = [], warnings = [];
  if (!l.categoryId) errors.push('no eBay category for game "' + (l.game || '?') + '" — unsupported game');
  for (const req of cats.requiredAspects || []) {
    if (!l.aspects || !l.aspects[req]) errors.push('missing required aspect "' + req + '"');
  }
  // Structured trading-card condition descriptors are mandatory (both APIs enforce them).
  const dNames = new Set((l.conditionDescriptors || []).map((d) => d.name));
  if (l.graded) {
    if (!dNames.has('Professional Grader')) errors.push('graded card missing the Professional Grader condition descriptor');
    if (!dNames.has('Grade')) errors.push('graded card missing the Grade condition descriptor');
  } else if (!dNames.has('Card Condition')) {
    errors.push('ungraded card missing the Card Condition condition descriptor');
  }
  if (l.price_cents == null || !(l.price_cents > 0)) errors.push('no price (needs_price) — set a price or override before publish');
  if (!l.title || !l.title.trim()) errors.push('empty title');
  else if (l.title.length > 80) errors.push('title over 80 chars (' + l.title.length + ')');
  if (!(l.quantity > 0)) errors.push('quantity must be ≥ 1');
  if (!(l.imageUrls && l.imageUrls.length) && !l.imageUrl) warnings.push('no image — the Inventory API requires ≥1 image to publish; add card art or a photo');
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
