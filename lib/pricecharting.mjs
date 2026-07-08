// lib/pricecharting.mjs — keyless PriceCharting scraper for Pokémon graded/raw/pop prices.
//
// PriceCharting fills gaps no other source covers: clean graded prices (Grade 9 / PSA 10 /
// BGS 10), an eBay-sold-based raw anchor, and PSA/CGC population counts. There is no free API,
// so this parses the PUBLIC card + population pages. All fetching is server-side (Golden Rule
// 1/2 — never from the browser). Prices are kept as INTEGER CENTS (Golden Rule 3). Everything is
// live market data, never an estimate (Golden Rule 4). Any failure returns {matched:false} and
// NEVER throws into the caller (Golden Rule 7) — a blocked/changed PriceCharting must not break a
// card lookup; the price rows just don't appear.
//
// DOM contract (verified 2026-06 against real pages — see parser comments):
//   - card page  /game/<console>/<product> : <div id="full-prices"> label→price table
//   - pop  page  /pop/item/<console>/<product> : <table id="population-table"> grade/psa/cgc/total
//   - search     /search-products?q=…&type=prices : <table id="games_table"> rows w/ data-product
//
// Future upgrade path: if a PRICECHARTING_TOKEN is configured, lookup() uses the official API
// instead of scraping — same return shape, so the paid path is a drop-in (see lookupViaApi).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ORIGIN = 'https://www.pricecharting.com'

// Persistent on-disk cache (data/pc-cache/) so a dev-server restart doesn't re-scrape from cold,
// and a stale entry can still be served when PriceCharting is blocking (rate-limit resilience).
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pc-cache')
const safeName = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_').slice(0, 150)
function diskRead(name) { try { return JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf8')) } catch { return null } }
function diskWrite(name, obj) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); const tmp = join(CACHE_DIR, name + '.tmp'); writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, join(CACHE_DIR, name)) } catch {}
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
}

// Cache the resolved card URL per pokemontcg.io id (slug is stable; prices are not) and the full
// result for a short TTL so repeated in-session lookups don't re-hit PriceCharting (polite + fast).
const slugCache = new Map() // cardId -> { url, productName, consoleName }
const resultCache = new Map() // cardId -> { at: <ms>, result }
const RESULT_TTL_MS = 12 * 60 * 60 * 1000 // 12h — PriceCharting updates once ~daily, so ≤2 hits/card/day

// ---- politeness throttle (this is a scraper behind Cloudflare) -------------
// One serialized gate spaces EVERY outbound request — within a lookup (search→card→pop) AND
// across concurrent/rapid lookups — by a jittered minimum gap, so the cadence never looks robotic.
// A 403/429 trips a circuit breaker that pauses all PriceCharting calls (so we never hammer a
// block). Interactive lookups stay snappy because results are cached (see RESULT_TTL_MS) and the
// enrichment is non-blocking; a cold card costs ~2 spaced requests.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN_GAP_MS = 1000 // global minimum spacing between any two requests
const JITTER_MS = 500 //   + random 0..JITTER so requests aren't perfectly periodic
const BLOCK_COOLDOWN_MS = 5 * 60 * 1000 // pause this long after a 403/429
let _gate = Promise.resolve() // promise chain that releases requests one at a time
let _lastReqAt = 0
let _blockedUntil = 0

function throttleGate() {
  const next = _gate.then(async () => {
    const wait = _lastReqAt + MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS) - Date.now()
    if (wait > 0) await sleep(wait)
    _lastReqAt = Date.now()
  })
  _gate = next.catch(() => {}) // a failure must not wedge the chain
  return next
}

// ---- small helpers ---------------------------------------------------------

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&#0*38;/g, '&')
    .replace(/&#0*43;/g, '+').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').trim()
}

// "$2,771.48" -> 277148 cents. "-" / "" / "$0.00"->0 ; non-numeric -> null.
export function parseMoneyCents(str) {
  if (str == null) return null
  const t = String(str).replace(/&[^;]+;/g, '').trim()
  if (!t || t === '-') return null
  const m = t.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/)
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function parseCount(str) {
  const t = String(str == null ? '' : str).replace(/&[^;]+;/g, '').replace(/,/g, '').trim()
  if (!t || t === '-') return null
  const n = parseInt(t, 10)
  return Number.isFinite(n) ? n : null
}

// Normalise a set/card label for fuzzy cross-taxonomy matching (pokemontcg.io ↔ PriceCharting).
function norm(s) {
  return decodeEntities(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(pokemon|lorcana|disney|the|set|tcg|trading|card|game|english)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---- parsers (exported for the unit harness) -------------------------------

// <div id="full-prices"> … <table> … <tr><td>LABEL</td><td class="price js-price">$X</td></tr>
// Returns a label→cents map: { 'Ungraded':38384, 'Grade 9':277148, 'PSA 10':3010000, 'BGS 10':… }
export function parseFullPrices(html) {
  if (!html) return {}
  const start = html.indexOf('id="full-prices"')
  if (start < 0) return {}
  const end = html.indexOf('</table>', start)
  const slice = end < 0 ? html.slice(start) : html.slice(start, end)
  const out = {}
  const re = /<td>\s*([^<]+?)\s*<\/td>\s*<td class="price js-price">\s*([^<]*?)\s*<\/td>/g
  let m
  while ((m = re.exec(slice))) {
    const label = decodeEntities(m[1])
    if (label) out[label] = parseMoneyCents(m[2])
  }
  return out
}

// Pull the prices we surface from a card page. Raw anchor + the graded points the owner wants.
export function parseCardPage(html) {
  const fp = parseFullPrices(html)
  const get = (k) => (fp[k] != null ? fp[k] : null)
  // product/console name from the Full Price Guide heading: "Full Price Guide: NAME (CONSOLE)"
  let productName = '', consoleName = ''
  const h = html && html.match(/Full Price Guide:\s*([^<(]+?)\s*\(([^)]+)\)/i)
  if (h) { productName = decodeEntities(h[1]); consoleName = decodeEntities(h[2]) }
  return {
    productName, consoleName,
    prices: {
      ungraded: get('Ungraded'),
      grade9: get('Grade 9'),
      psa10: get('PSA 10'),
      bgs10: get('BGS 10'),
    },
    allGrades: fp,
  }
}

// <table id="population-table"> grade/psa/cgc/total rows -> { '9':{psa,cgc,total}, '10':{…}, … }
export function parsePopPage(html) {
  if (!html) return {}
  const start = html.indexOf('id="population-table"')
  if (start < 0) return {}
  const end = html.indexOf('</table>', start)
  const slice = end < 0 ? html.slice(start) : html.slice(start, end)
  const out = {}
  const re = /<td class="grade-col">\s*([^<]+?)\s*<\/td>\s*<td class="psa-col">\s*([^<]*?)\s*<\/td>\s*<td class="cgc-col">\s*([^<]*?)\s*<\/td>\s*<td class="total-col">\s*([^<]*?)\s*<\/td>/g
  let m
  while ((m = re.exec(slice))) {
    const grade = decodeEntities(m[1])
    if (/^total$/i.test(grade)) continue
    out[grade] = { psa: parseCount(m[2]), cgc: parseCount(m[3]), total: parseCount(m[4]) }
  }
  return out
}

// <table id="games_table"> -> [{ productId, url, productName, consoleName }]
export function parseSearch(html) {
  if (!html) return []
  const tStart = html.indexOf('id="games_table"')
  if (tStart < 0) return []
  const body = html.slice(tStart)
  const rows = body.split(/<tr id="product-/).slice(1)
  const out = []
  for (const chunk of rows) {
    const idM = chunk.match(/^(\d+)/)
    const hrefM = chunk.match(/href="(https:\/\/www\.pricecharting\.com\/game\/[^"#]+)"/)
    if (!hrefM) continue
    const nameM = chunk.match(/<td class="title">\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/)
    const consM = chunk.match(/<td class="console[^"]*">\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/)
    out.push({
      productId: idM ? idM[1] : null,
      url: decodeEntities(hrefM[1]),
      productName: nameM ? decodeEntities(nameM[1]) : '',
      consoleName: consM ? decodeEntities(consM[1]) : '',
    })
  }
  return out
}

// ---- console enumeration (JP/CN/KO card catalog + images) ------------------
// PriceCharting groups every set into a "console" (e.g. pokemon-japanese-abyss-eye). One console
// page lists ALL its cards with English names, collector numbers and a per-card image hash — this
// is our keyless source for JP/CN/KO card data + full-res images (TCGdex lacks M5/CN/KO cards).
const consoleCache = new Map() // slug -> { at, cards }
const CONSOLE_TTL_MS = 12 * 60 * 60 * 1000
let dirCache = { at: 0, data: null }
const DIR_TTL_MS = 24 * 60 * 60 * 1000

// Parse a /console/<slug> page's games_table into [{ number, name, image, url }]. Image is the
// full-res 1600px URL (the row embeds a /60.jpg thumb — swap the size). Sealed rows (Booster
// Box/Pack — no "#<n>") are skipped.
export function parseConsole(html) {
  if (!html) return []
  const tStart = html.indexOf('id="games_table"')
  if (tStart < 0) return []
  const rows = html.slice(tStart).split(/<tr id="product-/).slice(1)
  const out = []
  for (const chunk of rows) {
    const nameM = chunk.match(/<td class="title"[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/)
    if (!nameM) continue
    const title = decodeEntities(nameM[1])                 // "Mega Darkrai ex #114"
    const numM = title.match(/#\s*([A-Za-z0-9]+)\s*$/)      // trailing collector number
    if (!numM) continue                                    // skip sealed products (no #)
    const number = numM[1]
    const name = title.replace(/\s*#\s*[A-Za-z0-9]+\s*$/, '').trim()
    const imgM = chunk.match(/src="(https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[a-z0-9]+)\/\d+\.jpg"/i)
    const hrefM = chunk.match(/href="(https:\/\/www\.pricecharting\.com\/game\/[^"#]+)"/)
    out.push({
      number, name,
      image: imgM ? imgM[1] : '',                          // base URL — append /320.jpg (display) or /1600.jpg (download)
      url: hrefM ? decodeEntities(hrefM[1]) : '',
    })
  }
  return out
}

// Enumerate one set's cards from its PriceCharting console. Cached 12h (memory + disk). A blocked
// or restarted server serves the stale disk copy rather than re-hammering PriceCharting (GR7).
// Returns { cards, stale, at }. `stale:true` means the live refresh failed and we fell back to a
// past-TTL cached copy (a good copy is NEVER overwritten with empty/failed data).
export async function enumerateConsole(slug) {
  slug = String(slug || '').trim()
  if (!slug) return { cards: [], stale: false, at: 0 }
  const file = 'console-' + safeName(slug) + '.json'
  let cached = consoleCache.get(slug)
  if (!cached) { cached = diskRead(file); if (cached) consoleCache.set(slug, cached) }   // warm from disk
  if (cached && Date.now() - cached.at < CONSOLE_TTL_MS) return { cards: cached.cards, stale: false, at: cached.at }
  const staleFallback = () => (cached ? { cards: cached.cards, stale: true, at: cached.at } : { cards: [], stale: false, at: 0 })
  try {
    const html = await httpGet(ORIGIN + '/console/' + encodeURIComponent(slug) + '?sort=model-number')
    const cards = parseConsole(html)
    if (cards.length) { const entry = { at: Date.now(), cards }; consoleCache.set(slug, entry); diskWrite(file, entry); return { cards, stale: false, at: entry.at } }
    return staleFallback()                                                               // parse empty → keep old, flag stale
  } catch { return staleFallback() }                                                     // blocked → keep old, flag stale
}

// Directory of all Pokémon JP/CN/KO console slugs from /category/pokemon-cards. Cached 24h.
// Slugs encode the set: pokemon-japanese-<english-name>, pokemon-chinese-<code>, pokemon-korean-<english-name>.
function parseConsoleDirectory(html) {
  const out = { japanese: [], chinese: [], korean: [] }
  if (!html) return out
  const re = /\/console\/(pokemon-(japanese|chinese|korean)-[a-z0-9.\-]+)/gi
  const seen = new Set()
  let m
  while ((m = re.exec(html))) {
    const slug = m[1].toLowerCase(), lang = m[2].toLowerCase()
    if (seen.has(slug)) continue
    seen.add(slug)
    out[lang].push(slug)
  }
  return out
}

export async function listPokemonConsoles() {
  if (!dirCache.data) { const d = diskRead('directory.json'); if (d) dirCache = d }   // warm from disk
  if (dirCache.data && Date.now() - dirCache.at < DIR_TTL_MS) return dirCache.data
  try {
    const html = await httpGet(ORIGIN + '/category/pokemon-cards')
    const data = parseConsoleDirectory(html)
    if (data.japanese.length || data.chinese.length) { dirCache = { at: Date.now(), data }; diskWrite('directory.json', dirCache) }
    return dirCache.data || data
  } catch { return dirCache.data || { japanese: [], chinese: [], korean: [] } }
}

// ---- matching (load-bearing — "correctness outranks cleverness") -----------

// productName carries the collector number as "#<n>" (e.g. "Charizard ex #199").
function numberMatch(productName, number) {
  const m = (productName || '').match(/#\s*([A-Za-z0-9]+)/)
  if (!m) return false
  const got = m[1].toLowerCase().replace(/^0+(?=\d)/, '')
  const want = String(number == null ? '' : number).toLowerCase().replace(/\/.*$/, '').replace(/^0+(?=\d)/, '')
  return !!want && got === want
}

function nameMatch(productName, cardName) {
  const pn = norm((productName || '').replace(/#\S+/g, ''))
  const cn = norm(cardName)
  if (!cn || !pn) return false
  return pn === cn || pn.includes(cn) || cn.includes(pn)
}

// Does a PriceCharting console-name resolve to the looked-up pokemontcg.io set name?
function setMatch(consoleName, setName) {
  const c = norm(consoleName), s = norm(setName)
  if (!s || !c) return false
  if (c.includes(s) || s.includes(c)) return true
  const st = s.split(' ').filter(Boolean)
  const ct = new Set(c.split(' ').filter(Boolean))
  const hit = st.filter((t) => ct.has(t)).length
  return st.length > 0 && hit >= Math.ceil(st.length * 0.6)
}

// Pick the best result. Require name+number match (the strong key). Prefer one whose console-name
// resolves to the set; if exactly one name+number candidate exists, accept it even without a
// textual set match (uniqueness ≈ confidence) — the verify link lets the seller confirm.
// Returns { match, confidence } or null. Exported for the unit harness.
export function pickBestMatch(results, { name, number, setName }) {
  const cands = (results || []).filter((r) => numberMatch(r.productName, number) && nameMatch(r.productName, name))
  if (!cands.length) return null
  const withSet = cands.filter((r) => setMatch(r.consoleName, setName))
  if (withSet.length) return { match: withSet[0], confidence: 'high' }
  if (cands.length === 1) return { match: cands[0], confidence: 'medium' }
  return null // multiple name+number matches, none resolves to the set → ambiguous, don't guess
}

// ---- network ---------------------------------------------------------------

async function httpGet(url) {
  const full = await httpGetFull(url)
  return full.html
}

async function httpGetFull(url) {
  if (Date.now() < _blockedUntil) {
    throw new Error('pricecharting cooling down (recent 403/429), ' + Math.ceil((_blockedUntil - Date.now()) / 1000) + 's left')
  }
  await throttleGate()
  const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' })
  if (r.status === 403 || r.status === 429) {
    // Bot-block / rate-limit — back all the way off so we never escalate against Cloudflare.
    _blockedUntil = Date.now() + BLOCK_COOLDOWN_MS
    throw new Error('HTTP ' + r.status + ' (blocked) for ' + url + ' — pausing PriceCharting ' + (BLOCK_COOLDOWN_MS / 60000) + 'm')
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url)
  return { url: r.url, redirected: r.redirected, html: await r.text() }
}

function popUrlFor(cardUrl) {
  return cardUrl.replace(ORIGIN + '/game/', ORIGIN + '/pop/item/')
}

// Returns { match:{url,productName,consoleName}, confidence, html? } or null.
// PriceCharting 302s straight to the card page on a strong single match (e.g. "charizard ex 199")
// and only serves a games_table results page when the match is ambiguous (e.g. "pikachu 58").
async function searchProduct({ name, number, setName, lang }) {
  // lang==='jp' biases the search to PriceCharting's "Pokemon Japanese" console products.
  const q = encodeURIComponent([name, number, lang === 'jp' ? 'japanese' : ''].filter(Boolean).join(' '))
  const res = await httpGetFull(ORIGIN + '/search-products?q=' + q + '&type=prices')
  const cardUrlM = res.url.match(/^https:\/\/www\.pricecharting\.com\/game\/[^?#]+/)
  if (cardUrlM && res.html.includes('id="full-prices"')) {
    // Redirected to a card page — confirm it's really ours before trusting the redirect.
    const card = parseCardPage(res.html)
    if (!numberMatch(card.productName, number) || !nameMatch(card.productName, name)) return null
    const confidence = setMatch(card.consoleName, setName) ? 'high' : 'medium'
    return { match: { url: cardUrlM[0], productName: card.productName, consoleName: card.consoleName }, confidence, html: res.html }
  }
  return pickBestMatch(parseSearch(res.html), { name, number, setName })
}

// ---- public entry ----------------------------------------------------------

// lookup({ name, number, setName, cardId?, token? }) ->
//   { matched, url, confidence, productName, consoleName, prices:{ungraded,grade9,psa10,bgs10}, pop }
// prices are INTEGER CENTS (caller divides by 100 for the dollar-valued price rows). Never throws.
export async function lookup(opts) {
  const { name, number, setName, cardId, token, lang, url, enabled = true } = opts || {}
  if (!enabled) return { matched: false }
  if (!url && (!name || number == null)) return { matched: false }   // url path needs no name/number
  let staleResult = null   // past-TTL cached result — served (flagged) if a live refresh fails. Hoisted so catch sees it.
  try {
    if (token && !url) return await lookupViaApi(opts)

    // Result cache keyed by cardId OR the direct card url (console path). Memory + disk. A past-TTL
    // copy is kept as `staleResult` so a failed refresh serves it (flagged) rather than losing prices.
    const cacheKey = cardId || (url ? 'u_' + safeName(url) : '')
    if (cacheKey) {
      let cached = resultCache.get(cacheKey)
      if (!cached) { cached = diskRead('result-' + safeName(cacheKey) + '.json'); if (cached) resultCache.set(cacheKey, cached) }
      if (cached) {
        if (Date.now() - cached.at < RESULT_TTL_MS) return cached.result       // fresh
        staleResult = cached.result                                            // past TTL — keep as fallback
      }
    }
    const staleOrNone = () => (staleResult ? { ...staleResult, stale: true } : { matched: false })

    // Resolve the card URL. A direct `url` (from console enumeration) skips the search entirely —
    // we already know the exact card + console, so no fuzzy matching/guard is needed.
    let resolved = url ? { url, confidence: 'medium' } : (cardId ? slugCache.get(cardId) : null)
    let confidence = resolved ? resolved.confidence || 'high' : null
    let cardHtml = null
    if (!resolved) {
      const best = await searchProduct({ name, number, setName, lang })
      if (!best) return staleOrNone()
      // Japanese-console coverage is sparse and the match is fuzzier — never claim 'high'.
      const conf = lang === 'jp' && best.confidence === 'high' ? 'medium' : best.confidence
      resolved = { url: best.match.url, productName: best.match.productName, consoleName: best.match.consoleName, confidence: conf }
      confidence = conf
      if (best.html) cardHtml = best.html // redirect path already fetched the card page
      if (cardId) slugCache.set(cardId, resolved)
    }

    if (!cardHtml) cardHtml = await httpGet(resolved.url)
    const card = parseCardPage(cardHtml)
    // JP mode must ONLY ever surface Japanese-console prices — never the English same-number card
    // (a JP set and its EN equivalent share collector numbers). Fall back to matched:false otherwise.
    if (lang === 'jp' && !/japanese/i.test(card.consoleName || resolved.consoleName || '')) return staleOrNone()
    const hasAny = card.prices && Object.values(card.prices).some((v) => v != null)
    if (!hasAny) return staleOrNone()

    // Population is best-effort — only popular cards have a pop page; failure is non-fatal.
    let pop = {}
    try { pop = parsePopPage(await httpGet(popUrlFor(resolved.url))) } catch { pop = {} }

    const result = {
      matched: true,
      url: resolved.url,
      confidence,
      productName: card.productName || resolved.productName,
      consoleName: card.consoleName || resolved.consoleName,
      prices: card.prices,
      ladder: card.allGrades || {}, // full label→cents map (Grade 7-9.5, PSA/BGS/CGC/SGC 10, …) for the UI
      pop,
    }
    if (cacheKey) { const entry = { at: Date.now(), result }; resultCache.set(cacheKey, entry); diskWrite('result-' + safeName(cacheKey) + '.json', entry) }
    return result
  } catch (e) {
    // Blocked / HTML changed / network down → serve the stale copy (flagged) if we have one,
    // else behave as "no match" (Golden Rule 7). NEVER overwrites the cached good copy.
    return staleResult ? { ...staleResult, stale: true } : { matched: false, error: String(e && e.message || e) }
  }
}

// Official-API path (only when PRICECHARTING_TOKEN is set). UNVERIFIED against a live token — the
// field names below follow PriceCharting's documented CSV/JSON keys and should be confirmed once a
// subscription exists. Kept as a drop-in so subscribing is a config change, not a rewrite.
async function lookupViaApi({ name, number, setName, token }) {
  try {
    const q = encodeURIComponent([name, number].filter(Boolean).join(' '))
    await throttleGate() // the official API is rate-limited ~1 req/s — reuse the same spacing
    const s = await fetch(ORIGIN + '/api/products?t=' + token + '&q=' + q).then((r) => r.json())
    const products = (s && s.products) || []
    const best = pickBestMatch(
      products.map((p) => ({ productId: p.id, url: ORIGIN + '/game/' + (p.id || ''), productName: p['product-name'], consoleName: p['console-name'] })),
      { name, number, setName },
    )
    if (!best) return { matched: false }
    await throttleGate()
    const d = await fetch(ORIGIN + '/api/product?t=' + token + '&id=' + best.match.productId).then((r) => r.json())
    const cents = (k) => (d && d[k] != null ? +d[k] : null)
    return {
      matched: true,
      url: 'https://www.pricecharting.com/game/' + best.match.productId,
      confidence: best.confidence,
      productName: d['product-name'] || best.match.productName,
      consoleName: d['console-name'] || best.match.consoleName,
      prices: { ungraded: cents('loose-price'), grade9: cents('graded-price'), psa10: cents('manual-only-price') || cents('psa-10'), bgs10: cents('bgs-10-price') },
      pop: {},
    }
  } catch (e) {
    return { matched: false, error: String(e && e.message || e) }
  }
}

// ============================ SEALED PRODUCTS ============================
// Sealed product (booster boxes, ETBs, bundles, tins…) live on PriceCharting's game consoles
// and product pages, but the CARD path (parseConsole above) deliberately drops them (no "#<n>").
// These sealed-specific helpers reuse the same throttle / circuit-breaker / disk cache. Prices are
// INTEGER CENTS (GR3); anything that fetches never throws into the caller (GR7).

// Sealed-product page -> { productName, consoleName, prices:{sealed,loose,cib}, allGrades }.
// Reuses parseFullPrices (the label->cents ladder) + the "Full Price Guide: NAME (CONSOLE)" heading.
// Sealed value = the 'New'/'Sealed' rung; opened = 'Loose'/'CIB'. Unpriced rungs stay null (GR4).
export function parseSealedProduct(html) {
  const fp = parseFullPrices(html)
  let productName = '', consoleName = ''
  const h = html && html.match(/Full Price Guide:\s*([^<(]+?)\s*\(([^)]+)\)/i)
  if (h) { productName = decodeEntities(h[1]); consoleName = decodeEntities(h[2]) }
  const first = (...keys) => { for (const k of keys) if (fp[k] != null) return fp[k]; return null }
  return {
    productName, consoleName,
    prices: {
      sealed: first('New', 'Sealed', 'Brand New', 'Box only'),
      loose: first('Loose', 'Used'),
      cib: first('CIB', 'Complete'),
    },
    allGrades: fp,
  }
}

// UPC / barcode -> sealed product + price. Never throws. The returned consoleName lets the caller
// infer the game. API path when a PRICECHARTING_TOKEN is set (GET /api/product?upc=), else a keyless
// scrape of the search page (a specific UPC 302s straight to the product page). Prices in cents.
// Field names on the API path follow PriceCharting's documented JSON keys and are UNVERIFIED until a
// token exists (same caveat as lookupViaApi) — kept isolated so subscribing is a config change.
export async function lookupByUpc(opts) {
  const { upc, token, enabled = true } = opts || {}
  if (!enabled) return { matched: false }
  const code = String(upc == null ? '' : upc).replace(/\D+/g, '')
  if (!code) return { matched: false }
  try {
    if (token) {
      await throttleGate()
      const d = await fetch(ORIGIN + '/api/product?t=' + encodeURIComponent(token) + '&upc=' + encodeURIComponent(code)).then((r) => r.json())
      if (!d || d.status === 'error' || !(d.id != null || d['product-name'])) return { matched: false, upc: code }
      const cents = (k) => (d && d[k] != null ? +d[k] : null)
      return {
        matched: true, source: 'pricecharting-api', confidence: 'high', upc: code,
        pc_product_id: d.id != null ? String(d.id) : null,
        url: ORIGIN + '/game/' + (d.id != null ? d.id : ''),
        name: d['product-name'] || '', consoleName: d['console-name'] || '',
        prices: { sealed: cents('new-price'), loose: cents('loose-price'), cib: cents('cib-price') },
        image: d.image || null,
      }
    }
    // keyless scrape: a specific UPC usually 302s straight to the product page.
    const res = await httpGetFull(ORIGIN + '/search-products?q=' + encodeURIComponent(code) + '&type=prices')
    const cardUrlM = res.url.match(/^https:\/\/www\.pricecharting\.com\/game\/[^?#]+/)
    if (cardUrlM && res.html.includes('id="full-prices"')) {
      const prod = parseSealedProduct(res.html)
      return {
        matched: true, source: 'pricecharting-scrape', confidence: 'medium', upc: code,
        pc_product_id: null, url: cardUrlM[0], name: prod.productName, consoleName: prod.consoleName,
        prices: prod.prices, image: null,
      }
    }
    // ambiguous — surface the first search hit as a low-confidence mapping (no price yet).
    const hits = parseSearch(res.html)
    if (hits.length) {
      const hit = hits[0]
      return {
        matched: true, source: 'pricecharting-scrape', confidence: 'low', upc: code,
        pc_product_id: hit.productId, url: hit.url, name: hit.productName, consoleName: hit.consoleName,
        prices: {}, image: null,
      }
    }
    return { matched: false, upc: code }
  } catch (e) {
    return { matched: false, upc: code, error: String((e && e.message) || e) }
  }
}

// Fetch + parse a known sealed product page (used to refresh a stored item's value). Never throws.
export async function sealedByUrl(url) {
  const u = String(url || '').trim()
  if (!u) return { matched: false }
  try {
    const html = await httpGet(u)
    const p = parseSealedProduct(html)
    if (!p.prices || Object.values(p.prices).every((v) => v == null)) return { matched: false }
    return { matched: true, url: u, name: p.productName, consoleName: p.consoleName, prices: p.prices }
  } catch (e) { return { matched: false, error: String((e && e.message) || e) } }
}

// Text search -> sealed candidate rows (for manual disambiguation when a barcode misses). A strong
// single match 302s to a product page (returned with prices); otherwise the games_table results.
export async function searchSealed(q) {
  const query = String(q || '').trim()
  if (!query) return []
  try {
    const res = await httpGetFull(ORIGIN + '/search-products?q=' + encodeURIComponent(query) + '&type=prices')
    const cardUrlM = res.url.match(/^https:\/\/www\.pricecharting\.com\/game\/[^?#]+/)
    if (cardUrlM && res.html.includes('id="full-prices"')) {
      const p = parseSealedProduct(res.html)
      return [{ productId: null, url: cardUrlM[0], productName: p.productName, consoleName: p.consoleName, prices: p.prices }]
    }
    return parseSearch(res.html).map((h) => ({ ...h, prices: {} }))
  } catch { return [] }
}

// Sealed-aware console parse: the SIBLING of parseConsole that KEEPS the sealed rows (titles WITHOUT
// a trailing "#<n>") that the card path drops. Returns [{ name, image, url }]; the caller classifies
// each name into a product_type. parseConsole itself is left untouched (unit-tested, card path).
export function parseSealedConsole(html) {
  if (!html) return []
  const tStart = html.indexOf('id="games_table"')
  if (tStart < 0) return []
  const rows = html.slice(tStart).split(/<tr id="product-/).slice(1)
  const out = []
  for (const chunk of rows) {
    const nameM = chunk.match(/<td class="title"[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/)
    if (!nameM) continue
    const title = decodeEntities(nameM[1])
    if (/#\s*[A-Za-z0-9]+\s*$/.test(title)) continue          // trailing collector number -> a single card, skip
    const imgM = chunk.match(/src="(https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[a-z0-9]+)\/\d+\.jpg"/i)
    const hrefM = chunk.match(/href="(https:\/\/www\.pricecharting\.com\/game\/[^"#]+)"/)
    out.push({ name: title, image: imgM ? imgM[1] : '', url: hrefM ? decodeEntities(hrefM[1]) : '' })
  }
  return out
}

// Enumerate one set/console's SEALED products. Cached 12h (memory + disk); a blocked/restarted
// server serves the stale disk copy rather than re-hammering PriceCharting (GR7). Mirrors
// enumerateConsole. Returns { products, stale, at }.
const sealedConsoleCache = new Map() // slug -> { at, products }
export async function enumerateSealedConsole(slug) {
  slug = String(slug || '').trim()
  if (!slug) return { products: [], stale: false, at: 0 }
  const file = 'sealed-console-' + safeName(slug) + '.json'
  let cached = sealedConsoleCache.get(slug)
  if (!cached) { cached = diskRead(file); if (cached) sealedConsoleCache.set(slug, cached) }
  if (cached && Date.now() - cached.at < CONSOLE_TTL_MS) return { products: cached.products, stale: false, at: cached.at }
  const staleFallback = () => (cached ? { products: cached.products, stale: true, at: cached.at } : { products: [], stale: false, at: 0 })
  try {
    const html = await httpGet(ORIGIN + '/console/' + encodeURIComponent(slug) + '?sort=model-number')
    const products = parseSealedConsole(html)
    if (products.length) { const entry = { at: Date.now(), products }; sealedConsoleCache.set(slug, entry); diskWrite(file, entry); return { products, stale: false, at: entry.at } }
    return staleFallback()
  } catch { return staleFallback() }
}
