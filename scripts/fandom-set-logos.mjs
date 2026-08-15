// scripts/fandom-set-logos.mjs — shared plumbing for the Fandom-wiki set-LOGO bakes (MTG, Lorcana).
//
// Both wikis follow the same convention Bulbapedia doesn't: each SET has its own page, and the
// page's file list carries a `<Something>_logo.png|jpg` wordmark. Because we ask for a specific
// set's PAGE, the association is page→set, not filename→set — more reliable than Bulbapedia's
// filename parsing, but it still needs the containment check below to stop an unrelated logo
// mentioned on the page (a sibling set, a product line) being claimed as this set's wordmark.
import { normName } from './build-pokemon-set-symbols.mjs';

const UA = { 'User-Agent': 'TCGListingTools/1.0 (Binders Keepers listing images; set logo index)' };

async function api(base, params) {
  const url = base + '/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${base} HTTP ${r.status}`);
  return r.json();
}

const LOGO_FILE_RE = /logo\.(png|jpe?g)$/i;

// The guard that keeps this GR4-clean: the file's name (minus the trailing 'logo') must appear
// INSIDE the set's own normalised name. 'The_First_Chapter_logo.jpg' ⊂ 'The First Chapter';
// 'Neon_Dynasty_logo.png' ⊂ 'Kamigawa: Neon Dynasty'. An unrelated logo on the page fails it,
// and a page with no passing file yields NOTHING — a wrong wordmark is worse than none.
export function logoMatchesSet(fileName, setName) {
  const stem = normName(String(fileName).replace(/\.[a-z]+$/i, '')).replace(/logo$/, '');
  return !!stem && normName(setName).includes(stem);
}

/**
 * Resolve one set's wordmark URL off its wiki page. Returns { url, file } or null.
 * A missing page, a page with no logo file, or a failing containment check are all null —
 * the caller records nothing and the rail falls back to the game logo.
 */
export async function fetchSetLogo(wikiBase, setName) {
  const page = String(setName).trim().replace(/ /g, '_');
  let j;
  try {
    j = await api(wikiBase, { action: 'parse', page, prop: 'images' });
  } catch { return null; }
  const files = (j.parse && j.parse.images) || [];
  const hit = files.find((f) => LOGO_FILE_RE.test(f) && logoMatchesSet(f, setName));
  if (!hit) return null;
  try {
    const q = await api(wikiBase, { action: 'query', prop: 'imageinfo', iiprop: 'url', titles: 'File:' + hit });
    const p = (q.query && q.query.pages && q.query.pages[0]) || null;
    const url = p && p.imageinfo && p.imageinfo[0] && p.imageinfo[0].url;
    return url ? { url, file: hit } : null;
  } catch { return null; }
}

export const politePause = (ms = 400) => new Promise((r) => setTimeout(r, ms));
