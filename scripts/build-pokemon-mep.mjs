// build-pokemon-mep.mjs — bake data/pokemon-mep.json: a SELF-CONTAINED roster of the EN "Mega
// Evolution Promo" set (TCGplayer id `mep`). This set is NOT in pokemontcg.io (its promo catalog
// stops at `svp`, 2023) and has NO PriceCharting console, so neither EN lane can serve it. It IS in
// the paid Scrydex `/pokemon/v1` API (ids `mep-<n>`), but our key is 402 SUBSCRIPTION_INACTIVE — so
// we bake it ourselves from two KEYLESS sources:
//   - roster (name/number/price + stage/type/hp) : TCGplayer's public search API (server-side; a Node
//       fetch with browser headers passes where the browser can't — CORS). Paginated (cap 50/page).
//   - card images (runtime, not baked)           : images.scrydex.com/pokemon/mep-<bareNumber>/{small,
//       large} — that CDN is keyless even though the API isn't.
// The Pokémon builder loads data/pokemon-mep.json client-side, shows the set in the EN picker, and
// resolves a typed number against this roster (doLookupMep). Listing-only: no pokemontcg.io id, so
// identity_key stays blank (tracker/inventory gated), like the JP/early-EN lanes.
//
// AUTOMATION: wired into the 24h in-process refresh (lib/refresh.mjs `pokemon-mep` bake), so a NEW
// promo (or price move) lands within `interval_hours`. GR7: a fetch failure THROWS pre-write, so the
// refresh keeps the existing catalog (atomic temp+rename); a fresh deploy cold-starts from the tracked
// data/pokemon-mep-seed.json (ensureMepSeeded). GRADUATION: if pokemontcg.io ever ingests the set, the
// builder hides this overlay (activeSets) and the whole thing can be deleted.

import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'data', 'pokemon-mep.json')

// TCGplayer public search API — the price-guide page's own backend. setName = the URL slug.
const TCGP_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false'
const TCGP_SET = 'me-mega-evolution-promo'
const TCGP_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Origin': 'https://www.tcgplayer.com',
  'Referer': 'https://www.tcgplayer.com/',
}
const PAGE = 50   // API rejects size > 50 with HTTP 400

// TCGplayer variant tag -> canonical label. Order matters (first match wins).
const VARIANTS = [
  [/\[\s*staff\s*\]/i, 'Staff'],
  [/pok[eé]mon\s+center\s+exclusive/i, 'Pokémon Center Exclusive'],
  [/cos?mos\s+holo/i, 'Cosmos Holo'],             // tolerate the "Comos Holo" typo (missing s)
  [/p[ia]tch\s+black\s+stamp(?:ed)?/i, 'Pitch Black Stamped'], // tolerate "Patch Black Stamp"
  [/ace\s+trainer/i, 'Ace Trainer'],
  [/pre[\s-]?release/i, 'Prerelease'],
]

const pad3 = (n) => ('00' + String(parseInt(n, 10))).slice(-3)
const priceToUsd = (v) => {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const m = String(v).replace(/[$,]/g, '').match(/\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
function variantOf(name) {
  for (const [re, label] of VARIANTS) if (re.test(name)) return label
  return 'Standard'
}
// Strip the "- NNN", bracket/paren tags, and any stray number to get the clean card name.
function cleanName(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]/g, ' ')       // [Staff]
    .replace(/\([^)]*\)/g, ' ')        // (Cosmos Holo), (Pokemon Center Exclusive), ...
    .replace(/\b\d{2,3}[A-Za-z]?\b/g, ' ') // stray collector numbers
    .replace(/(^|\s)[-–](\s|$)/g, ' ') // separator dashes (no hyphenated species in this set)
    .replace(/\s+/g, ' ')
    .trim()
}
const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt } }

// Fetch every product for the set from TCGplayer (paginated). Returns normalised rows. THROWS on a
// hard failure (GR7: the refresh then keeps the existing baked file). `fetchImpl` is injectable for tests.
export async function fetchTcgplayerRows(fetchImpl = fetch) {
  const rows = []
  let from = 0, total = Infinity
  while (from < total) {
    const body = JSON.stringify({
      algorithm: 'sales_dismax', from, size: PAGE,
      filters: { term: { productLineName: ['pokemon'], setName: [TCGP_SET] }, range: {}, match: {} },
      context: { shippingCountry: 'US' }, sort: {},
    })
    const r = await fetchImpl(TCGP_URL, { method: 'POST', headers: TCGP_HEADERS, body })
    if (!r.ok) throw new Error('TCGplayer search HTTP ' + r.status)
    const j = await r.json()
    const res = (j.results || [])[0]
    const items = (res && res.results) || []
    total = (res && res.totalResults) || 0
    for (const p of items) {
      if (p.sealed) continue
      const ca = p.customAttributes || {}
      if (!ca.number || !p.productName) continue
      rows.push({
        name: p.productName,
        number: ca.number,
        price: p.marketPrice,
        stage: ca.stage || '',
        type: Array.isArray(ca.energyType) ? ca.energyType.join(' / ') : '',
        hp: ca.hp || '',
        rarity: p.rarityName || ca.rarityDbName || 'Promo',
        releaseDate: String(ca.releaseDate || '').slice(0, 10),
      })
    }
    if (!items.length) break
    from += PAGE
  }
  if (!rows.length) throw new Error('TCGplayer returned no products for ' + TCGP_SET)
  return rows
}

// images.scrydex.com serves a fixed "no image" PNG (HTTP 200) for absent cards — detect it by its
// exact byte length so we never present the placeholder as the real card. NB: this CDN omits the
// Content-Length header over Node's fetch (both HEAD and GET), so we must read the body and measure
// it. We probe the SMALL image (~45–56KB) to keep the bake light.
const PLACEHOLDER_SMALL_BYTES = 45551
const scrydexImgUrl = (bareNum, size) => `https://images.scrydex.com/pokemon/mep-${bareNum}/${size}`

// GET each card's small image and keep card.img (the bare number) only when a REAL image is present.
// GR7-style: on a network/probe error we stay OPTIMISTIC (keep the image) so a transient CDN outage
// never strips art from the baked file. Returns the number of cards with confirmed art.
async function probeScrydexImages(cards, { concurrency = 8, fetchImpl = fetch } = {}) {
  let confirmed = 0
  for (let i = 0; i < cards.length; i += concurrency) {
    await Promise.all(cards.slice(i, i + concurrency).map(async (c) => {
      const bare = String(parseInt(c.number, 10))
      try {
        const r = await fetchImpl(scrydexImgUrl(bare, 'small'), { method: 'GET' })
        const bytes = r.ok ? (await r.arrayBuffer()).byteLength : 0
        const present = r.ok && bytes !== PLACEHOLDER_SMALL_BYTES
        if (present) { c.img = bare; confirmed++ } else { delete c.img }
      } catch { c.img = bare }   // probe failed -> optimistic keep
    }))
  }
  return confirmed
}

// Pure core (unit-testable offline): group normalised rows into per-number cards.
export function computeMep(rows) {
  const byNum = new Map()   // padded number -> { number, names:Map, variants:[], meta }
  for (const r of (rows || [])) {
    if (!r || !r.number || !r.name) continue
    const number = pad3(r.number)
    const label = variantOf(r.name)
    const name = cleanName(r.name)
    if (!byNum.has(number)) byNum.set(number, { number, names: new Map(), variants: [], meta: {} })
    const rec = byNum.get(number)
    rec.names.set(name, (rec.names.get(name) || 0) + (label === 'Standard' ? 100 : 1))
    rec.variants.push({ label, market: priceToUsd(r.price) })
    if (!rec.meta.stage && r.stage) rec.meta.stage = r.stage
    if (!rec.meta.type && r.type) rec.meta.type = r.type
    if (!rec.meta.hp && r.hp) rec.meta.hp = r.hp
    if (r.rarity) rec.meta.rarity = r.rarity
    if (r.releaseDate && (!rec.meta.releaseDate || r.releaseDate < rec.meta.releaseDate)) rec.meta.releaseDate = r.releaseDate
  }
  const cards = [...byNum.values()].map((rec) => {
    const name = [...rec.names.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const variants = rec.variants
      .filter((v) => v.market != null)
      .sort((a, b) => (a.label === 'Standard' ? -1 : b.label === 'Standard' ? 1 : (b.market - a.market)))
    const c = { number: rec.number, name, rarity: rec.meta.rarity || 'Promo', variants }
    if (rec.meta.stage) c.stage = rec.meta.stage
    if (rec.meta.type) c.type = rec.meta.type
    if (rec.meta.hp) c.hp = rec.meta.hp
    return c
  }).sort((a, b) => Number(a.number) - Number(b.number))

  const total = cards.length
  const printedTotal = cards.reduce((m, c) => Math.max(m, Number(c.number)), 0)
  const releaseDate = [...byNum.values()].map((r) => r.meta.releaseDate).filter(Boolean).sort()[0] || ''
  return { cards, total, printedTotal, releaseDate }
}

export async function buildPokemonMep({ out = OUT, probeImages = true, fetchImpl = fetch } = {}) {
  const rows = await fetchTcgplayerRows(fetchImpl)     // throws on outage -> refresh keeps existing file
  const { cards, total, printedTotal, releaseDate } = computeMep(rows)
  if (!cards.length) throw new Error('no mep cards parsed')
  let withImg = total
  if (probeImages) withImg = await probeScrydexImages(cards, { fetchImpl })
  else cards.forEach((c) => { c.img = String(parseInt(c.number, 10)) })

  const prior = readJson(out, { cards: [] })
  const priorNums = new Set((prior.cards || []).map((c) => c.number))
  const newCards = cards.filter((c) => !priorNums.has(c.number)).map((c) => ({ number: c.number, name: c.name }))

  const body = {
    note: 'EN "Mega Evolution Promo" (TCGplayer id `mep`) roster — baked because the set is absent from '
      + 'pokemontcg.io and has no PriceCharting console. Roster (name/number/price/stage/type/hp) from '
      + 'TCGplayer\'s public search API; images resolve at runtime from images.scrydex.com/pokemon/'
      + 'mep-<bareNumber>/{small,large} (keyless CDN). Regenerated by scripts/build-pokemon-mep.mjs, '
      + 'wired into the 24h refresh (lib/refresh.mjs). Server-owned + gitignored; cold-start seed is '
      + 'data/pokemon-mep-seed.json.',
    generatedAt: new Date().toISOString().slice(0, 10),
    set: {
      code: 'mep', id: 'mep', name: 'Mega Evolution Promo', ptcgoCode: 'MEP',
      series: 'Scarlet & Violet', releaseDate: releaseDate || '2025', total, printedTotal,
    },
    source: {
      roster: 'tcgplayer:' + TCGP_SET,
      images: 'images.scrydex.com/pokemon/mep-<n>/{small,large}',
      prices: 'TCGplayer market (USD)',
    },
    cards,
  }
  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(body, null, 2))
  renameSync(tmp, out)

  const summary = `${total} mep cards (001–${pad3(printedTotal)}), ${withImg} with Scrydex art`
    + (newCards.length ? ` · ${newCards.length} new` : '')
  return { summary, cards, newCards, out }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildPokemonMep()
  console.log('pokemon-mep baked [' + r.summary + '] -> ' + r.out)
}
