// scripts/build-riftbound-prices.mjs — keyless Riftbound market prices from TCGplayer.
//
// WHY THIS EXISTS: Scrydex was the ONLY Riftbound price source, and this account's subscription
// lapsed — api.scrydex.com answers `402 SUBSCRIPTION_INACTIVE` for every product (the key itself
// still authenticates; keyless requests get 401, keyed ones 402, so it is a billing state, not a
// bad key). Settings already surfaces it as sources.rb state 'billing'. Because 100% of the
// tracker watchlist is Riftbound, `price_snapshots` had never accrued a single row for ANY game.
// Coverage/images/stats were already keyless (offline bake -> riftscribe -> dotgg); only the
// PRICES needed replacing, and Scrydex has no free tier.
//
// TCGplayer's public search API is the same endpoint the price-guide page uses, and the same one
// this repo already relies on server-side for the Pokémon MEP roster (build-pokemon-mep.mjs). It
// carries the whole Riftbound line, and its `customAttributes.number` happens to use EXACTLY this
// repo's normNum() shape:
//     027/298  -> 27        (base print)
//     027a/298 -> 27a       (Alternate Art)
//     236*/221 -> 236*      (Signature)
// so a watchlist identity_key like `OGN-27a` maps straight onto a product with no name matching —
// which matters, because the offline bake writes "Darius, Trifarian" where TCGplayer writes
// "Darius - Trifarian".
//
// ⚠ CAVEAT: this is an undocumented private endpoint reached with browser headers. It can change
// or start blocking without notice. That is why this is a scheduled bake with an atomic
// temp+rename write that THROWS before writing (GR7): a bad day keeps the last good price index
// instead of emptying it.
import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { normNum } from '../lib/riftbound-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'riftbound-prices.json');

const TCGP_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false';
// The EXACT productLineName. A bare 'riftbound' is silently IGNORED by the API — it answers 200
// with the whole unfiltered catalogue (~490k Pokémon products), so a typo here looks like success.
const TCGP_LINE = 'Riftbound: League of Legends Trading Card Game';
const PAGE = 50;   // API rejects size > 50 with HTTP 400

// TCGplayer setName -> the set code the tracker's identity_key uses. Deliberately NOT derived from
// data/riftbound.json: the bake calls Proving Grounds "Proving Grounds" while TCGplayer calls it
// "Origins: Proving Grounds", so the join has to be explicit.
//
// The four promo sets TCGplayer also carries (Riftbound Organized Play Promotional Cards, Riftbound
// Promotional Cards, Riftbound Judge Promotional Cards) are INTENTIONALLY absent: they are not in
// the offline bake, so no identity_key can address them, and their numbering collides with the main
// sets (two different "253/298" products live in the OP promo set alone).
const CODE_BY_TCGP_SET = {
  'Origins': 'OGN',
  'Origins: Proving Grounds': 'OGS',
  'Spiritforged': 'SFD',
  'Unleashed': 'UNL',
  'Vendetta': 'VEN',
};

const TCGP_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Origin': 'https://www.tcgplayer.com',
  'Referer': 'https://www.tcgplayer.com/',
};

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } };
const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
// A parenthetical tag marks a non-base printing: "(Alternate Art)", "(Signature)", "(Metal) (Best Of)".
const isTagged = (name) => /\(/.test(String(name || ''));

/**
 * Every Riftbound single TCGplayer carries, paginated over the whole product line.
 * THROWS on a hard failure so the caller keeps the existing file (GR7). `fetchImpl` is injectable
 * for tests, matching fetchTcgplayerRows() in build-pokemon-mep.mjs.
 */
export async function fetchRiftboundRows(fetchImpl = fetch) {
  const rows = [];
  let from = 0, total = Infinity, pages = 0;
  while (from < total) {
    const body = JSON.stringify({
      algorithm: 'sales_dismax', from, size: PAGE,
      filters: { term: { productLineName: [TCGP_LINE] }, range: {}, match: {} },
      context: { shippingCountry: 'US' }, sort: {},
    });
    const r = await fetchImpl(TCGP_URL, { method: 'POST', headers: TCGP_HEADERS, body });
    if (!r.ok) throw new Error('TCGplayer search HTTP ' + r.status);
    const j = await r.json();
    const res = (j.results || [])[0];
    const items = (res && res.results) || [];
    total = (res && res.totalResults) || 0;
    if (!items.length) break;
    for (const p of items) {
      if (p.sealed) continue;
      const ca = p.customAttributes || {};
      rows.push({
        productName: String(p.productName || ''),
        setName: String(p.setName || ''),
        number: String(ca.number || ''),
        rarity: String(ca.rarityDbName || ''),
        market: num(p.marketPrice),
        low: num(p.lowestPrice),
        listings: num(p.totalListings),
      });
    }
    from += PAGE;
    if (++pages > 200) throw new Error('TCGplayer pagination runaway');   // never loop forever
  }
  if (!rows.length) throw new Error('TCGplayer returned no Riftbound products');
  return rows;
}

/**
 * Rows -> { 'OGN-27a': { market, low, currency, name, rarity, set, number } }.
 * Pure; exported for the unit harness. Returns the index plus a CATEGORISED account of everything
 * it dropped — a single "unnumbered" bucket hid sealed boxes, rune reprints and tokens together,
 * which made a correct 1118 look like a broken 1240.
 */
export function indexRows(rows) {
  const cards = {};
  const dropped = {
    promoSet: {},   // setName -> n. Not in the offline bake, so no identity_key addresses them.
    sealed: 0,      // no collector number at all: Booster Display, Showdown Decks, Promo Pack.
    token: 0,       // T## / "T## // T##" — tokens are not in the identity space.
    rune: 0,        // R##/R##a.. — per-set rune REPRINTS. riftbound-data.mjs catalogues the 12
                    // runes once under OGN and resolves R01..R06 back to it, so the reprints have
                    // no identity_key of their own. Dropping them matches the rest of the repo.
    special: 0,     // SP#/### — special/showcase promo numbering.
    unpriced: 0,    // real card, but TCGplayer has no marketPrice yet (newest set, no sales).
  };
  let collisions = 0;
  for (const r of rows) {
    const code = CODE_BY_TCGP_SET[r.setName];
    if (!code) { dropped.promoSet[r.setName] = (dropped.promoSet[r.setName] || 0) + 1; continue; }
    const raw = String(r.number || '').trim();
    if (!raw) { dropped.sealed++; continue; }
    if (/^T\d/i.test(raw)) { dropped.token++; continue; }
    if (/^R\d/i.test(raw)) { dropped.rune++; continue; }
    if (/^SP\d/i.test(raw)) { dropped.special++; continue; }
    const n = normNum(raw);
    if (!n || !/^\d/.test(n)) { dropped.special++; continue; }   // any other prefixed shape
    if (r.market == null) { dropped.unpriced++; continue; }
    const key = code + '-' + n;
    const prior = cards[key];
    if (prior) {
      collisions++;
      // Same set + same normNum from two products: keep the BASE print (untagged name). Guessing
      // wrong here would attach a Signature's $509 to an ordinary card, so bias to the plain one.
      if (isTagged(r.productName) || !isTagged(prior.name)) continue;
    }
    cards[key] = {
      market: r.market, low: r.low, currency: 'USD',
      name: r.productName, rarity: r.rarity, set: r.setName, number: r.number,
    };
  }
  return { cards, dropped, collisions };
}

export async function buildRiftboundPrices({ out = OUT, fetchImpl = fetch } = {}) {
  const rows = await fetchRiftboundRows(fetchImpl);          // throws on outage -> keeps existing file
  const { cards, dropped, collisions } = indexRows(rows);
  if (!Object.keys(cards).length) throw new Error('no Riftbound prices indexed');

  const prior = readJson(out, { cards: {} });
  const priorKeys = new Set(Object.keys(prior.cards || {}));
  const added = Object.keys(cards).filter((k) => !priorKeys.has(k));

  const bySet = {};
  for (const k of Object.keys(cards)) { const c = k.split('-')[0]; bySet[c] = (bySet[c] || 0) + 1; }

  const body = {
    note: 'Keyless Riftbound market prices (USD) from TCGplayer\'s public search API. Replaces the '
      + 'Scrydex price lane, whose subscription lapsed (402 SUBSCRIPTION_INACTIVE) and which was the '
      + 'only Riftbound source carrying prices. Keys are the tracker identity_key (SETCODE-normNum), '
      + 'so OGN-27a is Origins #27 Alternate Art. Promo sets are excluded — no identity_key addresses '
      + 'them and their numbering collides. Regenerated by scripts/build-riftbound-prices.mjs, wired '
      + 'into the refresh (lib/refresh.mjs) and served at /api/rbp/cards/:key. Server-owned + '
      + 'gitignored; a missing file simply means "no price yet", never a crash.',
    generatedAt: new Date().toISOString(),
    source: { prices: 'tcgplayer:' + TCGP_LINE, currency: 'USD', measure: 'marketPrice' },
    stats: { products: rows.length, indexed: Object.keys(cards).length, bySet, collisions, dropped },
    cards,
  };
  mkdirSync(dirname(out), { recursive: true });
  const tmp = out + '.tmp';
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, out);

  const setBits = Object.keys(bySet).sort().map((c) => c + ' ' + bySet[c]).join(', ');
  // Name what was dropped. A silent count reads as "we covered the line" when we did not.
  const dropBits = [
    dropped.unpriced ? dropped.unpriced + ' unpriced' : '',
    dropped.sealed ? dropped.sealed + ' sealed' : '',
    dropped.rune ? dropped.rune + ' rune reprints' : '',
    dropped.token ? dropped.token + ' tokens' : '',
    dropped.special ? dropped.special + ' special-numbered' : '',
    Object.keys(dropped.promoSet).length ? Object.values(dropped.promoSet).reduce((a, b) => a + b, 0) + ' promo-set' : '',
  ].filter(Boolean).join(', ');
  const summary = `${Object.keys(cards).length} priced cards (${setBits}) from ${rows.length} products`
    + (added.length && priorKeys.size ? ` · ${added.length} new` : '')
    + (collisions ? ` · ${collisions} number collisions resolved to the base print` : '')
    + (dropBits ? ` · skipped ${dropBits}` : '');
  return { summary, cards, added, out, stats: body.stats };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildRiftboundPrices();
  console.log('riftbound-prices baked [' + r.summary + '] -> ' + r.out);
}
