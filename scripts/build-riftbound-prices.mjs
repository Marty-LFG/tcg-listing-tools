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
import { normNum, loadRiftboundSets } from '../lib/riftbound-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'riftbound-prices.json');

const TCGP_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false';
// The EXACT productLineName. A bare 'riftbound' is silently IGNORED by the API — it answers 200
// with the whole unfiltered catalogue (~490k Pokémon products), so a typo here looks like success.
const TCGP_LINE = 'Riftbound: League of Legends Trading Card Game';
const PAGE = 50;   // API rejects size > 50 with HTTP 400

// TCGplayer setName -> the set code the tracker's identity_key uses. This used to be a
// hand-maintained map, which is why Vendetta needed a code edit before its prices showed up. Derive
// it from data/riftbound.json instead: TCGplayer's setName already matches the baked set name for
// every set but one, so only the exception is written down and a new set joins itself.
const TCGP_SET_ALIAS = { 'origins: proving grounds': 'proving grounds' };

// THE PROMO SETS. Riot's gallery carries none of them, and they hold some of the most valuable
// singles in the game — Metal "Prize Wall" cards at US$1,450-4,400, the T1 Worlds Champion signature
// cards at ~US$1,300-1,500, judge promos at US$185-434. They used to be DROPPED here, which left them
// unlistable at the right identity: the US$4,400 metal Teemo prints 263/298, the same number as the
// Origins common, so a lookup by number could only ever find the common.
//
// They are now their own sets, baked into data/riftbound-promos.json by promoCatalog() below from
// the same TCGplayer pull, and merged into the catalog by lib/riftbound-data.mjs. A promo number does
// NOT identify a card — up to three products share one within a set (plain, Metal Best Of, Metal
// Prize Wall), and the OP set mixes numbers from different main sets (109/166 and 109/298) — so a
// promo card is keyed by its TCGplayer PRODUCT ID (promoKey), which is unique and never changes.
//
// The known names are listed explicitly so a real set can never be swallowed by a regex; the
// catch-all only keeps a future promo drop out of the "unknown set" bucket below. Secret Garden is a
// three-card promo box (Lillia 001/003, Ivern 002/003, Ultrasoft Poro 003/003).
const PROMO_SET_NAMES = new Set([
  'riftbound organized play promotional cards',
  'riftbound promotional cards',
  'riftbound judge promotional cards',
  'secret garden',
]);
const DENY_RE = /\bpromo(tional)?\b/i;

// data/riftbound.json is gitignored and a fresh deploy bakes it ~60s after boot. Without this
// fallback the derived join would be EMPTY on that first pass, every row would land in unknownSet,
// and buildRiftboundPrices would throw "no prices indexed" — wiping the only price lane the tracker
// has. This is the roster the join used to hardcode; it exists purely to survive that window.
const SEED_BY_NAME = { origins: 'OGN', 'proving grounds': 'OGS', spiritforged: 'SFD', unleashed: 'UNL', vendetta: 'VEN' };

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Baked set list -> { lowercased set name: CODE }. Exported for the unit harness.
export function codeBySetName(sets) {
  const list = sets || loadRiftboundSets();
  if (!list.length) return { ...SEED_BY_NAME };
  const out = {};
  for (const s of list) out[norm(s.name)] = String(s.code || s.id).toUpperCase();
  return out;
}
export const isPromoSet = (n) => PROMO_SET_NAMES.has(norm(n)) || DENY_RE.test(String(n == null ? '' : n));
// A promo card's catalog key: its TCGplayer product id. The `p` keeps it from ever being read as a
// collector number, and normNum passes it through untouched ('p662886'), so the identity key is
// 'OPP-p662886' in the catalog, the price index and the watchlist alike.
export const promoKey = (productId) => 'p' + String(productId);
// A promo set's code is TCGplayer's own (OPP, PR, JDG, SGN — none of them Riot's). PRM is only the
// floor for a future promo set that arrives without one.
export const promoCode = (r) => String((r && r.setCode) || 'PRM').trim().toUpperCase() || 'PRM';
export function resolveSetCode(setName, byName) {
  const n = norm(setName);
  if (!n) return null;
  return byName[TCGP_SET_ALIAS[n] || n] || null;
}

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
  const seen = new Set();
  let from = 0, total = Infinity, pages = 0;
  while (from < total) {
    // SORTED BY NAME, not the default sales ranking. The ranking moves while we page through it, so
    // an offset lands on different products from one request to the next: measured 2026-09-24, the
    // default order returned 1,577 rows holding only 1,574 distinct products — Ivern (Secret Garden)
    // twice and Leona VEN-184 (US$85) not at all. Name order is stable: 1,577 of 1,577.
    const body = JSON.stringify({
      algorithm: 'sales_dismax', from, size: PAGE,
      filters: { term: { productLineName: [TCGP_LINE] }, range: {}, match: {} },
      context: { shippingCountry: 'US' }, sort: { field: 'product-sorting-name', order: 'asc' },
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
      // A product seen on an earlier page is not a second product (the guard behind the sort above).
      if (p.productId != null) { if (seen.has(p.productId)) continue; seen.add(p.productId); }
      const ca = p.customAttributes || {};
      rows.push({
        productName: String(p.productName || ''),
        setName: String(p.setName || ''),
        number: String(ca.number || ''),
        rarity: String(ca.rarityDbName || ''),
        market: num(p.marketPrice),
        low: num(p.lowestPrice),
        listings: num(p.totalListings),
        // For the promo catalog and the upcoming-set report. TCGplayer does NOT set `sealed` on a
        // presale booster display, which is how Radiance's nine boxes reached the set check at all.
        productId: p.productId != null ? String(p.productId) : '',
        setCode: String(p.setCode || ''),
        releaseDate: String(ca.releaseDate || '').slice(0, 10),
        printings: [...new Set((p.listings || []).map((l) => l && l.printing).filter(Boolean))],
        cardType: Array.isArray(ca.cardType) ? ca.cardType.map(String) : (ca.cardType ? [String(ca.cardType)] : []),
        domain: String(ca.domain || ''),
        energy: ca.energyCost, power: ca.powerCost, might: ca.might,
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
export function indexRows(rows, byName = codeBySetName(), { now = Date.now() } = {}) {
  const cards = {};
  const promo = {};  // setName -> n promo singles indexed (priced) under their promo keys
  const unknownSeen = {};  // setName -> { code, numbered, releaseDate } for every set the bake lacks
  const dropped = {
    unknownSet: {}, // setName -> n NUMBERED singles in a set the bake has never heard of — i.e.
                    // TCGplayer got there before Riot's gallery did. Counted BY NAME and named in
                    // the summary rather than lumped in with anything else: a silent bucket here
                    // reads as "we covered the line" when a whole set is missing. Sealed product in
                    // such a set is NOT counted here (see upcoming below) — only cards.
    sealed: 0,      // no collector number at all: Booster Display, Showdown Decks, Promo Pack.
    token: 0,       // T## / "T## // T##" — tokens are not in the identity space.
    rune: 0,        // R##/R##a.. — per-set rune REPRINTS. riftbound-data.mjs catalogues the 12
                    // runes once under OGN and resolves R01..R06 back to it, so the reprints have
                    // no identity_key of their own. Dropping them matches the rest of the repo.
    special: 0,     // any other prefixed shape the catalog has no key for.
    unpriced: 0,    // real card, but TCGplayer has no marketPrice yet (newest set, no sales).
  };
  let collisions = 0;
  for (const r of rows) {
    const raw = String(r.number || '').trim();
    // A promo single is priced under its PRODUCT id (promoKey), never its number, which it shares
    // with the main-set card and often with other promos. A promo with no number is a box or a
    // bundle, and counts as sealed like any other.
    if (isPromoSet(r.setName)) {
      if (!raw || !r.productId) { dropped.sealed++; continue; }
      if (r.market == null) { dropped.unpriced++; continue; }
      cards[promoCode(r) + '-' + promoKey(r.productId)] = {
        market: r.market, low: r.low, currency: 'USD',
        name: r.productName, rarity: r.rarity, set: r.setName, number: r.number,
      };
      promo[r.setName] = (promo[r.setName] || 0) + 1;
      continue;
    }
    const code = resolveSetCode(r.setName, byName);
    if (!code) {
      // A set the bake has not heard of. Its sealed product is announced months before any single
      // (Radiance listed nine boxes on presale and not one card), so a set with only sealed product
      // is UPCOMING and reported as such; only a numbered card in it means coverage is missing.
      const u = (unknownSeen[r.setName] ||= { code: String(r.setCode || '').toUpperCase(), numbered: 0, releaseDate: '' });
      if (r.releaseDate && r.releaseDate > u.releaseDate) u.releaseDate = r.releaseDate;
      if (!raw) { dropped.sealed++; continue; }
      u.numbered++;
      dropped.unknownSet[r.setName] = (dropped.unknownSet[r.setName] || 0) + 1;
      continue;
    }
    if (!raw) { dropped.sealed++; continue; }
    if (/^T\d/i.test(raw)) { dropped.token++; continue; }
    if (/^R\d/i.test(raw)) { dropped.rune++; continue; }
    // SP#/### is Vendetta's six-card special showcase subset. normNum maps it to 'sp1', exactly
    // what the catalog bake keys those cards under, so it indexes like any other number.
    const n = normNum(raw);
    if (!n || !/^(\d|sp\d)/i.test(n)) { dropped.special++; continue; }   // any other prefixed shape
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
  // Upcoming: a set the bake lacks, with sealed product and no cards yet, releasing after `now`.
  // A past-dated one with only sealed product (TCGplayer's "Riftbound Bundles") is simply sealed.
  const today = new Date(now).toISOString().slice(0, 10);
  const upcoming = Object.entries(unknownSeen)
    .filter(([, u]) => !u.numbered && u.releaseDate && u.releaseDate > today)
    .map(([name, u]) => ({ name, code: u.code, releaseDate: u.releaseDate }))
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return { cards, dropped, collisions, promo, upcoming };
}

// ---------------------------------------------------------------------------
// The promo catalog (data/riftbound-promos.json)
// ---------------------------------------------------------------------------

const str = (v) => (v == null ? '' : String(v));
// TCGplayer's card types come as "Champion Unit" / "Signature Spell"; the catalog's `type` is the
// bare Riot type the eBay aspects key on (Unit, Spell, Legend, Gear, Rune, Battlefield).
export function promoType(cardType) {
  const first = String((Array.isArray(cardType) ? cardType[0] : cardType) || '').trim();
  return first.replace(/^(champion|signature)\s+/i, '');
}
// The finish, from what sellers list the product under. Unanimous or nothing: a card listed both
// ways (someone mislabelled one) is left blank, and the consumers fall back to Non-foil — the
// under-promising answer (GR4).
export function promoFinish(printings) {
  const p = [...new Set((printings || []).map((x) => String(x || '').toLowerCase()))];
  if (p.length !== 1) return '';
  return p[0] === 'foil' ? 'Foil' : p[0] === 'normal' ? 'Non-foil' : '';
}
// The promo NAME, from TCGplayer's product name with two edits and no others:
//   - a tag that only repeats the card's number goes ("Fury Rune (R01c)" is R01c already);
//   - the two T1 bundle tags are shortened, keeping what they say. "(T1 Worlds Champion Signature
//     Edition Bundle) (Serial Numbered)" makes Galio's name 91 characters on its own, and the title
//     keeps the name above everything else — so fitTitle cut it mid-word and dropped the number.
const PROMO_TAG_SHORT = {
  'T1 Worlds Champion Signature Edition Bundle': 'T1 Signature Edition',
  'T1 Worlds Champion Player Bundle': 'T1 Player Bundle',
};
export function promoName(productName, number) {
  const num = String(number || '').trim().toLowerCase();
  return String(productName || '')
    .replace(/\s*\(([^)]*)\)/g, (m, tag) => {
      const t = tag.trim();
      if (num && t.toLowerCase() === num) return '';
      return ' (' + (PROMO_TAG_SHORT[t] || t) + ')';
    })
    .replace(/\s+/g, ' ').trim();
}
// The listing image TCGplayer hosts for a product, when it hosts one. About a third of the promo
// products have one, and a product either has every size or none (403 at all of them).
export const promoImageUrl = (productId) => 'https://tcgplayer-cdn.tcgplayer.com/product/' + productId + '_in_1000x1000.jpg';

/**
 * TCGplayer rows -> { opp: { name, code, total: 0, promo: true, cards: [...] }, ... }.
 * Pure; exported for the unit harness. Same card shape as data/riftbound.json, plus `pid` (the
 * TCGplayer product id) and `f` (the finish, when the listings agree on one).
 *
 * The NAME is TCGplayer's product name (promoName: two small edits) — "Teemo, Swift Scout (Metal) (Prize Wall)". The
 * tags are what makes a promo worth US$4,400 instead of US$58, and the name is the one part of a
 * Riftbound title that fitTitle never drops (the treatment token only knows Alternate Art /
 * Signature / Ultimate / Overnumbered, and it is mirrored in the builder). No champion (`ch`): a
 * promo Legend already leads with it ("Teemo, Swift Scout"), where Riot's Legend name does not.
 */
export function promoCatalog(rows, images = {}) {
  const sets = {};
  const seen = new Set();
  for (const r of rows || []) {
    if (!isPromoSet(r.setName)) continue;
    const num = String(r.number || '').trim();
    if (!num || !r.productId || seen.has(r.productId)) continue;   // one product, one card
    seen.add(r.productId);
    const code = promoCode(r);
    const set = (sets[code.toLowerCase()] ||= { name: r.setName, code, total: 0, promo: true, cards: [] });
    set.cards.push({
      k: promoKey(r.productId),
      num,
      name: promoName(r.productName, num),
      rarity: /^none$/i.test(r.rarity || '') ? '' : (r.rarity || ''),
      type: promoType(r.cardType),
      domain: r.domain || '',
      e: str(r.energy), p: str(r.power), m: str(r.might),
      img: images[r.productId] || '',
      a: '',
      ch: '',
      f: promoFinish(r.printings),
      pid: r.productId,
    });
  }
  for (const s of Object.values(sets)) {
    s.cards.sort((a, b) => a.num.localeCompare(b.num, 'en', { numeric: true }) || a.name.localeCompare(b.name));
  }
  const ordered = {};
  for (const k of Object.keys(sets).sort()) ordered[k] = sets[k];
  return ordered;
}

// Which promo products TCGplayer hosts an image for. A known image is kept without asking again;
// everything else is asked, 8 at a time (~15s for the whole promo line), so an image TCGplayer adds
// later is picked up by the next bake. A request that fails reads as no image for this bake only.
export async function probePromoImages(rows, prior = {}, fetchImpl = fetch, { concurrency = 8, timeoutMs = 15000 } = {}) {
  const ids = [...new Set((rows || []).filter((r) => isPromoSet(r.setName) && r.productId && String(r.number || '').trim())
    .map((r) => r.productId))];
  const out = {};
  const todo = [];
  for (const id of ids) { if (prior[id]) out[id] = prior[id]; else todo.push(id); }
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (i < todo.length) {
      const id = todo[i++];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetchImpl('https://tcgplayer-cdn.tcgplayer.com/product/' + id + '_200w.jpg', { signal: ac.signal });
        out[id] = r && r.ok ? promoImageUrl(id) : '';
        try { if (r && r.body && r.body.cancel) await r.body.cancel(); } catch { /* nothing to release */ }
      } catch { out[id] = prior[id] || ''; }
      finally { clearTimeout(timer); }
    }
  }));
  return out;
}

export async function buildRiftboundPrices({ out = OUT, promosOut = join(dirname(out), 'riftbound-promos.json'), fetchImpl = fetch, now = Date.now() } = {}) {
  const rows = await fetchRiftboundRows(fetchImpl);          // throws on outage -> keeps existing file
  const byName = codeBySetName();
  const { cards, dropped, collisions, promo, upcoming } = indexRows(rows, byName, { now });
  if (!Object.keys(cards).length) throw new Error('no Riftbound prices indexed');

  // The promo catalog, from the same pull — no extra requests beyond the image probe. Written BEFORE
  // the price index so a reader never sees promo prices for cards the catalog cannot resolve yet.
  // An EMPTY result never replaces a catalog that had sets: a bad day at TCGplayer must not make
  // every promo row in stock unresolvable (GR7).
  const priorPromos = readJson(promosOut, {});
  const priorImages = {};
  for (const s of Object.values(priorPromos)) for (const c of (s.cards || [])) if (c.pid && c.img) priorImages[c.pid] = c.img;
  const images = await probePromoImages(rows, priorImages, fetchImpl);
  const promoSets = promoCatalog(rows, images);
  const promoCards = Object.values(promoSets).reduce((n, s) => n + s.cards.length, 0);
  if (promoCards || !Object.keys(priorPromos).length) {
    mkdirSync(dirname(promosOut), { recursive: true });
    const ptmp = promosOut + '.tmp';
    writeFileSync(ptmp, JSON.stringify(promoSets));
    renameSync(ptmp, promosOut);
  }
  const promoCodes = new Set(Object.values(promoSets).map((s) => s.code));
  for (const s of Object.values(priorPromos)) if (s && s.code) promoCodes.add(String(s.code).toUpperCase());

  const prior = readJson(out, { cards: {} });
  const priorKeys = new Set(Object.keys(prior.cards || {}));
  const added = Object.keys(cards).filter((k) => !priorKeys.has(k));

  const bySet = {};
  for (const k of Object.keys(cards)) { const c = k.split('-')[0]; bySet[c] = (bySet[c] || 0) + 1; }

  const body = {
    note: 'Keyless Riftbound market prices (USD) from TCGplayer\'s public search API. Replaces the '
      + 'Scrydex price lane, whose subscription lapsed (402 SUBSCRIPTION_INACTIVE) and which was the '
      + 'only Riftbound source carrying prices. Keys are the tracker identity_key (SETCODE-normNum), '
      + 'so OGN-27a is Origins #27 Alternate Art. The setName -> code join is derived from '
      + 'data/riftbound.json, so a new set prices itself. Promo cards are keyed by TCGplayer product id '
      + '(OPP-p662886), because their printed numbers collide; their catalog is data/riftbound-promos.json. '
      + 'Regenerated by scripts/build-riftbound-prices.mjs, '
      + 'wired into the refresh (lib/refresh.mjs) and served at /api/riftbound/prices/:key. Server-owned '
      + '+ gitignored; a missing file simply means "no price yet", never a crash.',
    generatedAt: new Date().toISOString(),
    source: { prices: 'tcgplayer:' + TCGP_LINE, currency: 'USD', measure: 'marketPrice' },
    stats: { products: rows.length, indexed: Object.keys(cards).length, bySet, collisions, dropped, promo, upcoming },
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
  ].filter(Boolean).join(', ');
  // Two blind spots the counts above cannot show, both loud on purpose: a set TCGplayer carries that
  // the catalog has never heard of and that already has CARDS, and a baked set TCGplayer has not
  // listed a single product for. A set with only presale boxes is not a blind spot — it is on its way,
  // and saying so by name and date is more useful than "UNKNOWN".
  const unknown = Object.keys(dropped.unknownSet);
  const missing = [...new Set(Object.values(byName))].filter((c) => !bySet[c] && !promoCodes.has(c));
  const fmt = (d) => { const t = Date.parse(d + 'T00:00:00Z'); return Number.isNaN(t) ? d : new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  const promoBits = Object.values(promoSets).map((s) => s.code + ' ' + s.cards.length).join(', ');
  const withImage = Object.values(promoSets).reduce((n, s) => n + s.cards.filter((c) => c.img).length, 0);
  const summary = `${Object.keys(cards).length} priced cards (${setBits}) from ${rows.length} products`
    + (added.length && priorKeys.size ? ` · ${added.length} new` : '')
    + (collisions ? ` · ${collisions} number collisions resolved to the base print` : '')
    + (dropBits ? ` · skipped ${dropBits}` : '')
    + (promoCards ? ` · promos: ${promoCards} cards (${promoBits}), ${withImage} with an image` : '')
    + (upcoming.length ? ` · upcoming: ${upcoming.map((u) => u.name + (u.code ? ' (' + u.code + ')' : '') + ' ' + fmt(u.releaseDate)).join(', ')}` : '')
    + (unknown.length ? ` · UNKNOWN set(s) with cards: ${unknown.join(', ')}` : '')
    + (missing.length ? ` · no products for ${missing.join('/')}` : '');
  return { summary, cards, added, out, promosOut, promoSets, upcoming, stats: body.stats };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildRiftboundPrices();
  console.log('riftbound-prices baked [' + r.summary + '] -> ' + r.out);
}
