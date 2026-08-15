// lib/onepiece-clean-art.mjs — serve the CLEAN TCGplayer scan for a One Piece row, or nothing.
//
// Bandai's English card images are SAMPLE-watermarked at every keyless mirror, so listings built
// from optcgapi art ship a watermark to the gallery, the rails and Shopify alike. The bake
// (scripts/build-onepiece-tcgimages.mjs) maps card code → TCGplayer productId per PRINTING;
// this reader is the compose/publish-side lookup.
//
// THE VARIANT RULE IS STRICT (GR5): a row's variant must match the printing's tag, or nothing is
// served. An alt-art listing wearing base art misrepresents the item — the SAMPLE watermark is
// bad, the wrong product picture is worse. Matching is normalised ('Alternate Art' ↔
// 'alternate-art') but never fuzzy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normSetKey } from './pkm-sets-cache.mjs';

// The CDN shape and the tag vocabulary live HERE, with the bake importing from the lib — not the
// reverse. The publish path (ebay-map → this module) must not load scraper scripts, and writer +
// reader MUST share one canonicalisation or a spelling drift splits the index from its lookups.
export const productImageUrl = (id) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_1000x1000.jpg`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'data', 'onepiece-tcg-images.json');
const INDEX_FORMAT = 1;

let _cache = null;   // { mtime, cards }

function loadIndex() {
  let mtime;
  try { mtime = fs.statSync(INDEX_PATH).mtimeMs; } catch { _cache = null; return null; }
  if (_cache && _cache.mtime === mtime) return _cache.cards;
  try {
    const doc = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const cards = doc && doc.format === INDEX_FORMAT && doc.cards ? doc.cards : null;
    _cache = { mtime, cards };
    return cards;
  } catch {
    // Negative-cache the failure keyed on the SAME mtime: a corrupt file otherwise gets a full
    // read + parse-throw on every compose until someone rewrites it (the wrong-format branch above
    // already caches null — this makes the two failure shapes symmetric).
    _cache = { mtime, cards: null };
    return null;
  }
}

// normSetKey (the repo's one string normaliser) plus this game's synonym table. The tag can arrive
// from THREE vocabularies — TCGplayer's product parentheticals (the bake), optcgapi's card_name
// tags, and the builder's own variant labels ('Base Art', 'Alternate Art') — so both sides map into
// canonical printing identities before comparing. Checked table, never fuzzy (GR5).
const TAG_CANON = {
  '': '',                       // no decoration = the base printing
  baseart: '', base: '',        // the builder's explicit base labels
  // Bandai's official term for the alt-art printing is "Parallel"; the community's (and
  // optcgapi's, on some sets) is "Alternate Art"/"Alt Art"/"AA" — one printing, four spellings.
  alternateart: 'parallel', altart: 'parallel', aa: 'parallel', parallel: 'parallel',
};
export const canonPrintingTag = (s) => {
  const t = normSetKey(s);
  return Object.hasOwn(TAG_CANON, t) ? TAG_CANON[t] : t;
};
const normTag = canonPrintingTag;

// The variant can live in the NAME instead of the variant field — the aspects code in ebay-map.mjs
// recognises rows shaped 'Shanks (Alternate Art)' with an empty variant, and matching those against
// the BASE printing would put the wrong product's scan on the listing (the fail-open GR5 case).
//
// But a name parenthetical is a WEAK signal, and One Piece names carry two other kinds: the
// digit disambiguator optcgapi appends ("…(Bentham) (055)") and the alias that is PART of the
// printed card name ("Mr.3(Galdino)" — printed exactly so on the card, while TCGplayer's base
// product is plain "Mr. 3", tag ''). Both used to fail the match closed and keep the watermark.
// So a name-derived tag only counts when it contains a variant WORD; digits are dropped first,
// and anything else ('Bentham', 'Galdino') is printed-name content that falls through to base.
// The variant FIELD stays fully strict — it is the deliberate signal.
const NAME_VARIANT_RE = /parallel|manga|alternate|\balt\b|\baa\b|box|poster|pre.?release|winner|treasure|gold|special/i;
function effectiveTag(item) {
  const v = String(item.variant == null ? '' : item.variant).trim();
  if (v) return v;
  const name = String(item.name || '').replace(/\s*\(\d{2,4}\)\s*$/, '').trimEnd();
  const m = name.match(/\(([^)]+)\)\s*$/);
  return m && NAME_VARIANT_RE.test(m[1]) ? m[1] : '';
}

/**
 * cleanOnepieceArt({ number: 'OP01-120', variant: '' | 'Alternate Art' | …, name, language })
 *   -> url | null
 * Null whenever the index is absent, the code is unknown, the row is not English (TCGplayer scans
 * are the EN printings), or no printing matches the row's variant.
 */
export function cleanOnepieceArt(item = {}) {
  const lang = String(item.language || 'EN').trim().toUpperCase();
  if (lang && lang !== 'EN' && lang !== 'ENGLISH') return null;
  const cards = loadIndex();
  if (!cards) return null;
  const code = String(item.number || '').trim().toUpperCase();
  if (!code || !Object.hasOwn(cards, code)) return null;
  const entry = cards[code];
  if (!entry || !Array.isArray(entry.printings)) return null;
  const want = normTag(effectiveTag(item));
  const hit = entry.printings.find((p) => normTag(p.tag) === want);
  return hit ? productImageUrl(hit.id) : null;
}

export function clearOnepieceArtCache() { _cache = null; }
