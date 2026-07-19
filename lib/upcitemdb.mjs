// lib/upcitemdb.mjs — keyless barcode → product resolver (UPCItemDB), the missing link for sealed scans.
//
// WHY: PriceCharting's PUBLIC search cannot resolve a raw UPC (verified live — a numeric query returns
// `category=no-results`); only its PAID API (`/api/product?upc=`) does. So the keyless sealed-scan path
// missed almost everything. UPCItemDB's free "trial" endpoint maps a UPC/EAN → a product title / brand /
// category / image with NO key (rate-limited ~100/day, 6/min per IP). We then feed the resolved NAME into
// PriceCharting's NAME search (which DOES work) for live pricing. An optional UPCITEMDB_KEY unlocks the
// higher-volume /prod/v1 endpoint (the token upgrade path). Never throws (GR7): a miss / rate-limit / down
// returns {matched:false} so the scan always degrades to manual entry, never crashes.
//
// No new deps (global fetch only). Money is not handled here — pricing stays in lib/pricecharting.mjs (GR3/4).

const TRIAL_URL = 'https://api.upcitemdb.com/prod/trial/lookup'
const PAID_URL  = 'https://api.upcitemdb.com/prod/v1/lookup'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Leading brand/format boilerplate a UPCItemDB title carries that hurts a PriceCharting name match.
const TITLE_STRIP = [
  /pok[eé]mon\s+trading\s+card\s+game\s*:?/ig,
  /pok[eé]mon\s+tcg\s*:?/ig,
  /magic\s*:?\s*the\s+gathering\s*(tcg)?\s*:?/ig,
  /\btrading\s+card\s+game\b/ig,
  /\b(tcg|ccg)\b\s*:?/ig,
  /[®™©]/g,
]

// Clean a verbose UPCItemDB title into a concise, search-friendly product name.
// "Pokemon Trading Card Game: Scarlet & Violet - Surging Sparks Elite Trainer Box"
//   -> "Scarlet & Violet Surging Sparks Elite Trainer Box"
// Exported for the offline unit harness.
export function cleanSealedTitle(title) {
  let s = String(title == null ? '' : title)
  for (const re of TITLE_STRIP) s = s.replace(re, ' ')
  return s.replace(/\s*[-–—:]\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

// UPC/EAN → { matched, title, name(cleaned), brand, category, image, upc } | { matched:false }.
// key present => the /prod/v1 endpoint with the user_key header (paid); else the keyless trial endpoint.
export async function lookupUpcName({ upc, key, keyType, enabled = true } = {}) {
  if (!enabled) return { matched: false }
  const code = String(upc == null ? '' : upc).replace(/\D+/g, '')
  if (!code) return { matched: false }
  try {
    const headers = { 'User-Agent': UA, Accept: 'application/json' }
    let url = TRIAL_URL + '?upc=' + encodeURIComponent(code)
    if (key) { url = PAID_URL + '?upc=' + encodeURIComponent(code); headers.user_key = key; headers.key_type = keyType || '3scale' }
    const r = await fetch(url, { headers })
    if (!r.ok) return { matched: false, status: r.status }       // 429 = rate-limited; caller degrades (GR7)
    const d = await r.json().catch(() => null)
    const item = d && Array.isArray(d.items) && d.items[0]
    const title = item && String(item.title || '').trim()
    if (!title) return { matched: false }
    return {
      matched: true,
      title,
      name: cleanSealedTitle(title),
      brand: (item.brand || '').trim(),
      category: (item.category || '').trim(),
      image: (Array.isArray(item.images) && item.images.find(Boolean)) || null,
      upc: code,
    }
  } catch (e) { return { matched: false, error: String((e && e.message) || e) } }
}
