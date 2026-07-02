// scripts/check-collectr-ebay.mjs — golden-file harness: Collectr rows → ebay-map →
// ebay-csv (AGENTS.md §8). Asserts the eBay-readiness specifics for the real data:
// 1st Edition reaches title + Features aspect; graded rows land in conditionId 2750
// with a PSA-style title + Grade/Grader aspects; numbers stay verbatim; needs_price
// and unsupported-game rows HARD-FAIL validation (export gate).
// Run: node --disable-warning=ExperimentalWarning scripts/check-collectr-ebay.mjs
import { toEbayListing, validateListing, loadEbayCategories, cardConditionAspect } from '../lib/channels/ebay-map.mjs';
import { toPerCardCsv, toVariationCsv } from '../lib/channels/ebay-csv.mjs';
import { groupVariations } from '../lib/channels/ebay-map.mjs';

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

const cats = loadEbayCategories();

console.log('\n[raw 1st Edition row]');
const firstEd = toEbayListing({
  sku: 'BK-RAW-PKM-000010', game: 'pokemon', name: 'Shining Celebi', set_name: 'Neo Destiny',
  number: '106', rarity: 'Secret Rare', variant: '1st Edition Holo', edition: '1st Edition',
  condition: 'Near Mint', language: 'EN', quantity: 1, target_price_cents: 89999,
  image_url: 'https://images.pokemontcg.io/neo4/106_hires.png', finish: 'Holofoil',
}, null, cats);
assert('title carries 1st Edition', firstEd.title.includes('1st Edition'), firstEd.title);
assert('title ≤ 80', firstEd.title.length <= 80, firstEd.title.length + ' chars');
assert('Features aspect = 1st Edition (no Edition aspect in 183454)', firstEd.aspects['Features'] === '1st Edition');
assert('raw conditionId 4000', firstEd.conditionId === 4000);
assert('category 183454 (live-pinned)', firstEd.categoryId === '183454');
assert('Game aspect present (the one required aspect)', firstEd.aspects['Game'] === 'Pokémon TCG');
assert('Card Condition aspect enum', firstEd.aspects['Card Condition'] === 'Near Mint or Better');
assert('validates clean', validateListing(firstEd, cats).errors.length === 0, JSON.stringify(validateListing(firstEd, cats).errors));

console.log('\n[graded row — PSA 10 GEM - MT]');
const slab = toEbayListing({
  sku: 'BK-PKM-000021', game: 'pokemon', name: 'Pikachu Gold Star', set_name: 'EX Holon Phantoms',
  number: '104', rarity: 'Ultra Rare', variant: 'Holo', grading_company: 'PSA', grade: 10,
  grade_label: 'PSA 10.0 GEM - MT', language: 'EN', quantity: 1, target_price_cents: 38449899,
  image_url: 'https://images.pokemontcg.io/ex13/104_hires.png', finish: 'Holofoil',
}, null, cats);
assert('graded conditionId 2750', slab.conditionId === 2750);
assert('PSA-style title (PSA 10 GEM MINT)', slab.title.includes('PSA 10 GEM MINT'), slab.title);
assert('verbatim number in title', slab.title.includes('104'), slab.title);
assert('Graded=Yes aspect', slab.aspects['Graded'] === 'Yes');
assert('Professional Grader enum value', slab.aspects['Professional Grader'] === 'Professional Sports Authenticator (PSA)');
assert('Grade aspect numeric', slab.aspects['Grade'] === '10');
assert('slab description swaps the toploader wording', /encapsulated/.test(slab.descriptionHtml) && !/penny sleeve/.test(slab.descriptionHtml));
assert('validates clean', validateListing(slab, cats).errors.length === 0, JSON.stringify(validateListing(slab, cats).errors));

console.log('\n[hard blocks]');
const needsPrice = toEbayListing({ sku: 'X', game: 'pokemon', name: 'Charizard', set_name: 'Base Set (Unlimited)', number: '4', variant: 'Holo', grading_company: 'TAG', grade: 10, grade_label: 'TAG 10.0 Pristine', quantity: 1, target_price_cents: null, finish: 'Holofoil' }, null, cats);
assert('needs_price row FAILS validation', validateListing(needsPrice, cats).errors.some((e) => /price/.test(e)));
const unsupported = toEbayListing({ sku: 'Y', game: null, name: 'Monkey D. Luffy', number: 'OP01-001', quantity: 1, target_price_cents: 500 }, null, cats);
assert('unsupported game FAILS validation (no category)', validateListing(unsupported, cats).errors.some((e) => /category|unsupported/.test(e)));

console.log('\n[verbatim numbers + Set aspect fallback]');
const secret = toEbayListing({ sku: 'Z', game: 'pokemon', name: 'Magikarp', set_name: 'Paldea Evolved', number: '203/193', rarity: 'Illustration Rare', variant: 'Holo', condition: 'Near Mint', quantity: 1, target_price_cents: 61799, finish: 'Holofoil' }, null, cats);
assert('203/193 verbatim in title', secret.title.includes('203/193'), secret.title);
assert('Collectr set name verbatim in Set aspect', secret.aspects['Set'] === 'Paldea Evolved');

console.log('\n[CSV serialisation]');
{
  const csv = toPerCardCsv([firstEd, slab]);
  assert('UTF-8 BOM present', csv.charCodeAt(0) === 0xFEFF);
  assert('header has AU smart action', csv.includes('Action(SiteID=Australia|Country=AU|Currency=AUD|Version=1193)'));
  assert('CustomLabel = SKU (idempotency key)', csv.includes('BK-RAW-PKM-000010') && csv.includes('BK-PKM-000021'));
  assert('cents → edge money format (899.99)', csv.includes('899.99'));
  assert('graded price present (384498.99)', csv.includes('384498.99'));
  assert('description quoted (embedded commas survive)', /"<div style=/.test(csv));
  const lines = csv.split('\r\n').filter(Boolean);
  assert('3 lines (header + 2 rows)', lines.length === 3, String(lines.length));

  // multi-variation (EXPERIMENTAL) — structure only
  const many = Array.from({ length: 300 }, (_, i) => ({ ...firstEd, sku: 'BK-RAW-PKM-' + String(i).padStart(6, '0'), aspects: { ...firstEd.aspects, 'Card Number': String(i + 1) } }));
  const groups = groupVariations(many, { game: 'pokemon', setName: 'Neo Destiny' });
  assert('300 variations auto-split at 250 cap', groups.length === 2 && groups[0].variations.length === 250 && groups[1].variations.length === 50);
  assert('split parents get Part 1/2 titles', groups[0].parentTitle.includes('Part 1') && groups[1].parentTitle.includes('Part 2'), groups[0].parentTitle);
  const vcsv = toVariationCsv(groups);
  assert('variation rows tagged Relationship=Variation', (vcsv.match(/Variation/g) || []).length >= 300);
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL EBAY-MAP/CSV CHECKS PASSED');
process.exit(failures ? 1 : 0);
