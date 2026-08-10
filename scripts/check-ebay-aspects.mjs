// scripts/check-ebay-aspects.mjs — dump the LIVE item-aspect enums for eBay AU category 183454.
//
// READ-ONLY. It performs exactly one GET (Taxonomy getItemAspectsForCategory) with the
// CLIENT-CREDENTIALS app token — the same token lib/ebay-taxonomy.mjs already uses for condition
// policies. It needs only EBAY_APP_ID + EBAY_CERT_ID, never the user token in data/ebay-oauth.json,
// so it cannot see, create, revise or end a listing. It writes nothing.
//
// WHY THIS EXISTS. eBay treats a value that misses its enum two very different ways: a FREE_TEXT
// aspect silently DROPS it (the listing goes live, it just earns no buyer-facing facet), while a
// SELECTION_ONLY aspect REJECTS it — a failed publish. Nothing in this repo records which mode
// 'Attribute/MTG:Colour' is, which is why lib/channels/ebay-map.mjs ships it behind
// MTG_COLOUR_ASPECT_VERIFIED = false. Run this, read the mode, then flip the flag.
//
// Run: node --disable-warning=ExperimentalWarning scripts/check-ebay-aspects.mjs
//      node --disable-warning=ExperimentalWarning scripts/check-ebay-aspects.mjs --game "Magic: The Gathering"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { ebayToken } from '../lib/ebay-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREE_ID = '15';                 // eBay AU
const CATEGORY = '183454';            // Trading Card Singles

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const GAME = argOf('--game', 'Magic: The Gathering');
const CAT = argOf('--category', CATEGORY);
const showAll = argv.includes('--all');

// Does this aspect value apply to the game we asked about? eBay expresses that as
// valueConstraints[].applicableForLocalizedAspectValues — a value with NO constraints applies to
// every game.
function appliesToGame(v, game) {
  const cons = v.valueConstraints || [];
  if (!cons.length) return true;
  return cons.some((c) => (c.applicableForLocalizedAspectValues || []).some((x) => String(x) === game));
}

const env = loadEnv('development', ROOT, '');
if (!String(env.EBAY_APP_ID || '').trim() || !String(env.EBAY_CERT_ID || '').trim()) {
  console.error('EBAY_APP_ID / EBAY_CERT_ID missing from .env — nothing to call. (This script never needs the user token.)');
  process.exit(2);
}

const token = await ebayToken(env);
const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${TREE_ID}/get_item_aspects_for_category?category_id=${encodeURIComponent(CAT)}`;
const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Accept-Language': 'en-AU' } });
if (!r.ok) { console.error('HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 400)); process.exit(1); }
const json = await r.json();
const aspects = json.aspects || [];

console.log(`\neBay AU · tree ${TREE_ID} · category ${CAT} · ${aspects.length} aspects · filtered for "${GAME}"\n`);
console.log('  MODE            = FREE_TEXT (unmatched value silently DROPPED) | SELECTION_ONLY (unmatched value REJECTED → failed publish)');
console.log('  CARD            = SINGLE | MULTI\n');

// The aspects this repo actually emits, so drift in one of these is the thing worth spotting.
const OURS = new Set(['Game', 'Card Name', 'Set', 'Card Number', 'Rarity', 'Card Type', 'Character',
  'Attribute/MTG:Colour', 'Stage', 'Speciality', 'HP', 'Finish', 'Features', 'Illustrator',
  'Manufacturer', 'Card Size', 'Material', 'Language', 'Year Manufactured', 'Autographed']);

let required = [];
for (const a of aspects) {
  const name = a.localizedAspectName;
  if (!showAll && !OURS.has(name)) continue;
  const c = a.aspectConstraint || {};
  if (c.aspectRequired) required.push(name);
  const values = (a.aspectValues || []).filter((v) => appliesToGame(v, GAME));
  const total = (a.aspectValues || []).length;
  const tag = OURS.has(name) ? '*' : ' ';
  console.log(`${tag} ${name}`);
  console.log(`    MODE=${c.aspectMode || '?'}  CARD=${c.itemToAspectCardinality || '?'}  REQUIRED=${!!c.aspectRequired}  values: ${values.length}/${total} apply to ${GAME}`);
  if (values.length) {
    const names = values.map((v) => v.localizedValue);
    const head = names.slice(0, 40).join(' · ');
    console.log('    ' + head + (names.length > 40 ? ` … (+${names.length - 40} more)` : ''));
  } else if (total) {
    console.log('    (no value is constrained to this game — the enum is for other games, so ours pass verbatim)');
  }
  console.log('');
}

console.log('Required aspects: ' + (required.join(', ') || '(none)'));
console.log('\nWhat to do with this:');
console.log('  · Attribute/MTG:Colour — if MODE=FREE_TEXT, flip MTG_COLOUR_ASPECT_VERIFIED to true in');
console.log('    lib/channels/ebay-map.mjs. If SELECTION_ONLY, match our values to the list above');
console.log('    EXACTLY (note the AU spellings, Colourless/Multicolour) or leave the flag false.');
console.log('  · Rarity — check whether the member is "Mythic" or "Mythic Rare". Verbatim is safe');
console.log('    either way on FREE_TEXT; it just loses the facet if it misses.');
console.log('  · Nothing was written. Paste this output back to record it.\n');
