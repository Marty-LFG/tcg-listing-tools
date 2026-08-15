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
import { productImageUrl } from '../scripts/build-onepiece-tcgimages.mjs';

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
  } catch { _cache = null; return null; }
}

const normTag = (s) => {
  const t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  // ONE checked synonym, not fuzzy matching: Bandai's official term for the alt-art printing is
  // "Parallel", the community's (and optcgapi's, on some sets) is "Alternate Art" — the same
  // printing. Whole-string only, so 'Parallel Manga Alternate Art' stays its own distinct tag.
  return t === 'alternateart' ? 'parallel' : t;
};

/**
 * cleanOnepieceArt({ number: 'OP01-120', variant: '' | 'Alternate Art' | … }) -> url | null
 * Null whenever the index is absent, the code is unknown, or no printing matches the variant.
 */
export function cleanOnepieceArt(item = {}) {
  const cards = loadIndex();
  if (!cards) return null;
  const code = String(item.number || '').trim().toUpperCase();
  const entry = code && cards[code];
  if (!entry || !Array.isArray(entry.printings)) return null;
  const want = normTag(item.variant);
  const hit = entry.printings.find((p) => normTag(p.tag) === want);
  return hit ? productImageUrl(hit.id) : null;
}

export function clearOnepieceArtCache() { _cache = null; }
