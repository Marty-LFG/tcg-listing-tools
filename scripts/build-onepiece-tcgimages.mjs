// scripts/build-onepiece-tcgimages.mjs — map One Piece cards to CLEAN TCGplayer product images.
//
// WHY: Bandai's English card images carry a big white SAMPLE watermark, and every keyless mirror
// (optcgapi, Limitless) redistributes those same press files — verified across OP-01→OP-12
// (2026-08-15). The one clean keyless source is TCGplayer's own product scans, addressable as
//   https://tcgplayer-cdn.tcgplayer.com/product/<productId>_in_1000x1000.jpg
// so this bake maps card code (OP01-120) → productId per printing, via the same public search API
// build-pokemon-mep.mjs already uses.
//
// VARIANTS ARE IDENTITY (GR5): an alt-art and its base share one card code but are different
// products at wildly different prices, so each product's parenthetical tag ("Alternate Art",
// "Manga", …) is kept and the reader only serves an image whose tag MATCHES the row's variant —
// base art on an alt-art listing would misrepresent the item.
//
// SCOPE: the sets the store touches (data/onepiece-cards/ keys), matched to TCGplayer set slugs
// through the search API's own setName aggregation — never a constructed slug (GR4).
//
//   node scripts/build-onepiece-tcgimages.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normName } from './build-pokemon-set-symbols.mjs';
import { productImageUrl, canonPrintingTag } from '../lib/onepiece-clean-art.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const OUT_PATH = path.join(ROOT, 'data', 'onepiece-tcg-images.json');
const CARDS_DIR = path.join(ROOT, 'data', 'onepiece-cards');

const TCGP_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false';
const TCGP_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Origin: 'https://www.tcgplayer.com',
  Referer: 'https://www.tcgplayer.com/',
};
const PAGE = 50;                                   // API rejects size > 50
const MAX_PAGES_PER_SET = 40;                      // hard stop if the API ever re-serves page 1 forever

export const INDEX_FORMAT = 1;

// "Shanks (Parallel)" -> 'Parallel'; no parenthetical -> '' (the base printing).
// Pure-digit parentheticals are DISAMBIGUATORS, not variants — TCGplayer writes
// "Roronoa Zoro (001)" vs "Roronoa Zoro (025)" when one name spans several cards, and keeping
// the number would make every such base card look like a variant printing. Character-alias
// parentheticals ("Mr. 3 (Galdino)") are deliberately KEPT as tags: unknown decoration must stay
// strict (no clean-art swap) rather than be mistaken for the base printing (GR5).
export function variantTagOf(productName) {
  const tags = [...String(productName || '').matchAll(/\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .filter((t) => !/^\d{2,4}$/.test(t));
  return tags.join(' ').trim();
}

async function search(body, fetchImpl) {
  const r = await fetchImpl(TCGP_URL, { method: 'POST', headers: TCGP_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('TCGplayer search HTTP ' + r.status);
  const j = await r.json();
  return (j.results || [])[0] || {};
}

// The store's sets, joined to TCGplayer's own set list via the aggregation — value matched by
// normalised NAME ('Romance Dawn' ↔ 'Romance Dawn'), never by constructing a slug.
export async function resolveSetSlugs(fetchImpl = fetch) {
  const res = await search({
    algorithm: 'sales_dismax', from: 0, size: 1,
    filters: { term: { productLineName: ['one piece card game'] }, range: {}, match: {} },
    context: { shippingCountry: 'US' }, sort: {},
  }, fetchImpl);
  const buckets = (res.aggregations && res.aggregations.setName) || [];
  const byName = new Map(buckets.map((b) => [normName(b.value), b.urlValue]));

  const wanted = [];
  let files = [];
  try { files = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, f), 'utf8'));
      const name = doc.cards && doc.cards[0] && doc.cards[0].set_name;
      const slug = name && byName.get(normName(name));
      if (slug) wanted.push({ name, slug });
    } catch { /* one bad cache file must not stop the bake */ }
  }
  return wanted;
}

export async function fetchSetProducts(slug, fetchImpl = fetch) {
  const out = [];
  let from = 0, total = Infinity, pages = 0;
  while (from < total && pages < MAX_PAGES_PER_SET) {
    const res = await search({
      algorithm: 'sales_dismax', from, size: PAGE,
      filters: { term: { productLineName: ['one piece card game'], setName: [slug] }, range: {}, match: {} },
      context: { shippingCountry: 'US' }, sort: {},
    }, fetchImpl);
    const items = res.results || [];
    // The FIRST page's totalResults is the authority; a later page missing the field must not
    // collapse the loop into silently baking a partial set (the merge would keep it forever).
    if (pages === 0) total = res.totalResults || 0;
    for (const p of items) {
      const num = p.customAttributes && p.customAttributes.number;
      if (p.sealed || !num || !p.productId) continue;
      out.push({ code: String(num).toUpperCase(), id: p.productId, tag: variantTagOf(p.productName) });
    }
    if (!items.length) break;
    from += PAGE;
    pages++;
  }
  return out;
}

// The CDN answers 200 for ids it has no scan for — the images.scrydex.com placeholder trap over
// again (AGENTS.md 19), except here the URL becomes the listing's HERO image. Probe each NEW
// printing's image once at bake time and refuse anything that is not a real image. The sentinel
// (a product id that cannot exist) teaches us what "missing" looks like on this CDN: a 404 means
// missing products fail loudly and any 200 is trustworthy; a 200 gives us placeholder bytes to
// compare by digest. Network errors keep the printing (GR7-optimistic, like the MEP image probe).
export async function probeCleanImages(fresh, { fetchImpl = fetch, concurrency = 6, log = () => {} } = {}) {
  if (!fresh.length) return { kept: 0, dropped: 0 };
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': TCGP_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, status: r.status };
    const ct = String(r.headers.get('content-type') || '');
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, image: /^image\//i.test(ct), sha: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  };
  let placeholderSha = null, missingIs404 = false;
  try {
    const sentinel = await get(productImageUrl(999999901));
    if (!sentinel.ok) missingIs404 = true;
    else if (sentinel.image) placeholderSha = sentinel.sha;
  } catch { /* sentinel unreachable — stay optimistic below */ }

  let kept = 0, dropped = 0;
  const queue = [...fresh];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const probe = await get(productImageUrl(job.printing.id));
        const bad = (probe.ok && !probe.image)
          || (probe.ok && placeholderSha && probe.sha === placeholderSha)
          || (!probe.ok && missingIs404);
        if (bad) { job.remove(); dropped++; log(`  dropped ${job.code} [${job.printing.tag || 'base'}] — no real scan (id ${job.printing.id})`); }
        else kept++;
      } catch { kept++; }                          // network blip: keep, next bake re-probes nothing (accretive) — better a rare miss than a mass drop
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { kept, dropped };
}

export async function buildOnepieceTcgImages({ dryRun = false, log = () => {}, fetchImpl = fetch } = {}) {
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).cards || {}; } catch { return {}; }
  })();
  const cards = { ...existing };
  const sets = await resolveSetSlugs(fetchImpl);
  if (!sets.length) throw new Error('no One Piece sets matched TCGplayer’s set list (is data/onepiece-cards/ empty?)');
  let mapped = 0;
  const fresh = [];                                // new printings, queued for the placeholder probe
  for (const s of sets) {
    const products = await fetchSetProducts(s.slug, fetchImpl);
    for (const p of products) {
      const entry = cards[p.code] || (cards[p.code] = { printings: [] });
      // Printings are SET-SCOPED and matched by the reader's own canonical tag, not the raw
      // spelling. Two guards live here: a reprint group re-listing an OP01 code must never
      // overwrite the original set's printing (first set wins — codes name their home set), and
      // a TCGplayer respelling ("Alternate Art" → "Parallel") must update the one canonical
      // printing rather than append a shadow twin the reader would race.
      const canon = canonPrintingTag(p.tag);
      const prev = entry.printings.find((x) => canonPrintingTag(x.tag) === canon);
      if (prev) {
        if ((prev.set || s.slug) === s.slug) { prev.id = p.id; prev.tag = p.tag; prev.set = s.slug; }
      } else {
        const printing = { tag: p.tag, id: p.id, set: s.slug };
        entry.printings.push(printing);
        mapped++;
        fresh.push({ code: p.code, printing, remove: () => { entry.printings.splice(entry.printings.indexOf(printing), 1); } });
      }
    }
    log(`  ${s.name}: ${products.length} products`);
  }
  const probe = await probeCleanImages(fresh, { fetchImpl, log });
  for (const code of Object.keys(cards)) if (!cards[code].printings.length) delete cards[code];
  const doc = { format: INDEX_FORMAT, builtAt: new Date().toISOString(), source: 'mp-search-api.tcgplayer.com', count: Object.keys(cards).length, cards };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${Object.keys(cards).length} cards, ${mapped} new printings (${probe.dropped} scan-less dropped) across ${sets.length} sets`, count: Object.keys(cards).length, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildOnepieceTcgImages({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
