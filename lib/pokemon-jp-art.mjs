// lib/pokemon-jp-art.mjs — serve a real card scan for a Japanese Pokémon row when PriceCharting's
// is not one, or nothing.
//
// PriceCharting sometimes carries the ILLUSTRATION CROP for a card instead of the card scan —
// measured 2026-08-23: M6 Storm Emeralda 12 of 113, M5 Abyss Eye 3 of 118, S6A Eevee Heroes 3 of
// 101, M4 Ninja Spinner 0 of 120. It concentrates on the newest set, so they do appear to backfill,
// but the residue persists for years. Shipping an artwork crop as the product photo is the same
// defect class as the One Piece SAMPLE watermark this sits beside, and the same rule applies: the
// wrong product picture is worse than an ugly one.
//
// THE DETECTION IS A COMPARISON, NEVER A THRESHOLD, and that distinction is load-bearing.
// "Not portrait therefore broken" is wrong twice over on real data:
//   · Storm Emeralda introduced PAIRED STADIUM cards (#71-#76 — Legendary Marine Trench, Legendary
//     Summit, Legendary Lava Tube), where two cards form one wide artwork.
//   · For those, Serebii serves the JOINED PAIR — #73 measures 1736x1212, exactly two 868x1212 cards
//     side by side — while PriceCharting has the correct SINGLE card. Substituting there would put a
//     two-card picture on a one-card listing, which is worse than the crop we set out to fix.
// So a swap happens only when PriceCharting's image is not a single card AND Serebii's is. If both
// are odd shapes, or Serebii has nothing, PriceCharting stands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normSetKey } from './pkm-sets-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_PATH = path.join(ROOT, 'data', 'pokemon-jp-art.json');

// A Pokémon card is 63x88mm — 0.716. The window is wide enough for the padding PriceCharting adds
// (measured up to 0.809 on a legitimate single card) and nowhere near a landscape crop (1.3+).
// Upper bound measured, not guessed: PriceCharting pads some legitimate single cards out to 0.809
// (M6 #72), and its WRONG images start at 0.887 (M6 #105 Nitro Fire Energy, against Serebii's 0.717).
// 0.85 sits in that gap. Erring tight is the safe direction — a false flag only costs one extra
// request, because the substitution still has to pass the name and shape checks below.
export const CARD_ASPECT_MIN = 0.55;
export const CARD_ASPECT_MAX = 0.85;
export const isSingleCardAspect = (ar) => typeof ar === 'number' && ar >= CARD_ASPECT_MIN && ar <= CARD_ASPECT_MAX;

// Serebii files Japanese sets under the English set name, lowercased with everything else stripped:
// "Storm Emeralda" -> stormemeralda, "Mega Dream ex" -> megadreamex. Verified against M6/M5/M4/S6A.
export const serebiiSlug = (nameEn) => String(nameEn || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
// The printed number, unpadded — /card/stormemeralda/68.jpg (068.jpg is a 404).
export const serebiiCardUrl = (slug, number) =>
  `https://www.serebii.net/card/${slug}/${String(number).replace(/^0+(?=\d)/, '')}.jpg`;

// Card names, compared the way two catalogues can be expected to agree: PriceCharting decorates with
// bracketed printing tags ("Heracross [Reverse Holo]") that Serebii does not carry.
export const artName = (s) => String(s || '').replace(/\[[^\]]*\]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Do the two catalogues NUMBER this set the same way? That is the question worth asking, and it is
// not the same as "do they name this card the same way".
//
// Per-card name matching was the first attempt and it over-rejects, because the two translate
// Japanese Trainer names differently: PriceCharting's "Delicious Onigiri" is Serebii's "Yummy
// Onigiri", "Adventuring Lantern" is "Adventure Lantern", "Fossil Excavation Site" is "Fossil
// Quarry". All the same cards. Measured set-wide, though, M6 agrees on 104/113 names and M5 on
// 105/118 — so the NUMBERING lines up and a translation difference is just noise.
//
// So: prove alignment across the whole set, then trust the number. Systematic drift (the real risk,
// where #68 means different cards) collapses the rate and refuses the set; translation noise does
// not. Pure; exported for the unit harness.
export const ALIGNMENT_MIN_RATE = 0.85;
export const ALIGNMENT_MIN_SAMPLE = 10;

export function serebiiAlignment(pcCards, serebiiNames) {
  let both = 0, match = 0;
  for (const c of pcCards || []) {
    const n = String((c && c.number) == null ? '' : c.number).replace(/^0+(?=\d)/, '');
    const s = serebiiNames && serebiiNames[n];
    if (!s) continue;
    both++;
    if (artName(c.name) === artName(s)) match++;
  }
  const rate = both ? match / both : 0;
  // A tiny overlap cannot establish anything — 1/1 is not evidence.
  return { both, match, rate, aligned: both >= ALIGNMENT_MIN_SAMPLE && rate >= ALIGNMENT_MIN_RATE };
}

/**
 * Should this card's art be replaced? Pure, so the bake and the unit suite share one rule.
 *
 * THREE conditions, and dropping any one of them ships a wrong picture:
 *   · PriceCharting's image is not a single card  — otherwise there is nothing to fix
 *   · Serebii's image IS a single card            — its scan for a paired Stadium is the JOINED PAIR
 *                                                   (M6 #73 measures 1736x1212), and a two-card
 *                                                   photo on a one-card listing is worse than the
 *                                                   crop being replaced
 *   · the set's NUMBERING is proven aligned       — the swap is by number, so this is the only thing
 *                                                   standing between us and another card's picture.
 *                                                   Unproven = no swap, for the whole set.
 * @returns 'keep' | 'substitute'
 */
export function decideArtOverride({ pcAspect, serebiiAspect, setAligned } = {}) {
  if (isSingleCardAspect(pcAspect)) return 'keep';          // PriceCharting already has a card scan
  if (!isSingleCardAspect(serebiiAspect)) return 'keep';    // nothing better, or a joined pair
  if (setAligned !== true) return 'keep';                   // cannot prove the numbers mean the same cards
  return 'substitute';
}

// Serebii's set index (/card/<slug>/) carries the whole roster in one page: the printed number and
// the card name, per row. One request per SET replaces one per card and is what makes the name check
// affordable. Pure over the HTML; exported for the unit harness.
export function parseSerebiiIndex(html, slug) {
  const out = {};
  // The NUMBER is in the href (068.shtml) and the NAME is the link text. Two shapes, both real:
  //   Trainer:  <a href="/card/<slug>/068.shtml">Aarune</a>
  //   Pokemon:  <a href="/card/<slug>/001.shtml"> <font size="2">Heracross</font> </a>
  // Matching only the first shape reads 26 of a 117-card set, which is how this was wrong at first.
  // The picture column links the same page around an <img>, and is skipped by having no text.
  const re = /<a href="\/card\/([^"\/]+)\/(\d+)\.shtml">([\s\S]{0,160}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (slug && m[1].toLowerCase() !== String(slug).toLowerCase()) continue;   // never another set's card
    if (/<img/i.test(m[3])) continue;                                          // the thumbnail link
    const name = m[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const num = String(m[2]).replace(/^0+(?=\d)/, '');
    if (!out[num]) out[num] = name;
  }
  return out;
}

let _cache = null;   // { mtime, index }
function loadIndex() {
  let mtime;
  try { mtime = fs.statSync(INDEX_PATH).mtimeMs; } catch { _cache = null; return null; }
  if (_cache && _cache.mtime === mtime) return _cache.index;
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    _cache = { mtime, index: (j && j.sets) || null };
  } catch { _cache = { mtime, index: null }; }
  return _cache.index;
}
export function clearJpArtCache() { _cache = null; }

// JAPANESE ONLY. A Korean or Chinese row must never be handed a Japanese scan — same reasoning as
// the Japanese-twin card source, which strips images for exactly this reason.
const JA = /^(ja|jp|japan|japanese)$/i;

export function jpPokemonArt(row = {}) {
  if (String(row.game || '') !== 'pokemon') return '';
  if (!JA.test(String(row.language || ''))) return '';
  const index = loadIndex();
  if (!index) return '';
  const set = index[normSetKey(row.set_name || '')];
  if (!set) return '';
  const num = String(row.number == null ? '' : row.number).trim().split('/')[0].replace(/^0+(?=\d)/, '');
  return (num && set[num]) || '';
}
