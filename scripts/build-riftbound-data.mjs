// build-riftbound-data.mjs — bake the full Riftbound card catalog for the offline tier.
//
// Source: the OFFICIAL League of Legends card gallery (no key required). The page is a
// Next.js app; its card data lives at /_next/data/{buildId}/en-us/card-gallery.json. The
// buildId rotates on every Riot deploy, so we scrape it fresh from the gallery HTML each
// run (self-healing). Card images are Riot's own CDN (cmsassets.rgpub.io).
//
// This is the DEFAULT, keyless data source for the Riftbound builder — it covers every
// released set (OGN Origins / OGS Proving Grounds / SFD Spiritforged / UNL Unleashed),
// with full energy/might/power stats that Scrydex does not carry. It has NO prices; the
// builder layers eBay AUD comps (and optional Scrydex live pricing) on top.
//
// Two entry points:
//   - CLI:      `node scripts/build-riftbound-data.mjs`  (run when a new set drops)
//   - Import:   `import { buildRiftboundData } from './build-riftbound-data.mjs'`
//               (used by lib/refresh.mjs's daily in-process refresh timer).
// The write is ATOMIC (temp file + rename) and GR7-safe: a truncated/failed fetch throws
// BEFORE the rename, so the existing good catalog is never clobbered.
//
// Output: data/riftbound.json — keyed by lowercase set code, drop-in for the inline RB_DATA:
//   { "ogn": { name, code, cards: [ { k, num, name, rarity, type, domain, e, p, m, img } ] }, ... }
//   k   = normalized lookup key (mirrors the builder's normNum: leading zeros stripped,
//         trailing letter/* suffix kept) — e.g. "066a", "227*", "1"
//   num = printed number incl. set total, leading zeros kept — e.g. "066a/298"

import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const GALLERY = 'https://riftbound.leagueoflegends.com/en-us/card-gallery/'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'riftbound.json')

// Release order for stable set/pill ordering.
const SET_ORDER = ['OGN', 'OGS', 'SFD', 'UNL']

// Mirror the builder's normNum (riftbound-listing-builder.html) so baked keys line up
// with what the page computes from a typed card number.
function normNum(s) {
  s = String(s || '').split('/')[0].trim().toLowerCase()
  const m = s.match(/^0*(\d+)([a-z*]*)$/)
  return m ? m[1] + m[2] : s
}

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

// Recursively find the largest array of card-like objects (those carrying a publicCode).
function findCards(node, best = { arr: [] }) {
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object' && 'publicCode' in node[0]) {
      if (node.length > best.arr.length) best.arr = node
    }
    for (const v of node) findCards(v, best)
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) findCards(v, best)
  }
  return best.arr
}

// Safe accessors for the Sanity CMS field shapes ({label, value:{id,label}} / {values:[...]}).
const idOf = (f) => (f && f.value && f.value.id != null ? f.value.id : null)
const labelOf = (f) => (f && f.value && f.value.label != null ? f.value.label : null)

// Bake the catalog and (atomically) write it to `out`. Returns a summary object.
// Throws on any fetch/structure failure BEFORE writing — the caller keeps the old file.
export async function buildRiftboundData({ out = OUT } = {}) {
  const html = await (await fetch(GALLERY)).text()
  const bid = html.match(/"buildId"\s*:\s*"([^"]+)"/)
  if (!bid) throw new Error('Could not find Next.js buildId in gallery HTML — Riot changed the page structure.')
  const dataUrl = `https://riftbound.leagueoflegends.com/_next/data/${bid[1]}/en-us/card-gallery.json`

  const json = await (await fetch(dataUrl)).json()
  const cards = findCards(json)
  if (cards.length < 500) throw new Error(`Only found ${cards.length} cards (expected ~950) — response truncated or structure changed.`)

  const sets = {}
  let kept = 0, skipped = 0
  for (const c of cards) {
    // publicCode = SET-NNN[suffix]/TOTAL. Skip tokens / anything that doesn't match (e.g. UNL-T04).
    const pc = String(c.publicCode || '')
    const m = pc.match(/^([A-Z]{3})-(\d+[a-z*]?)\/\d+$/)
    if (!m) { skipped++; continue }
    const code = m[1]
    const num = pc.replace(/^[A-Z]{3}-/, '').toLowerCase()       // "066a/298"
    const k = normNum(num)                                       // "66a"

    let name = c.name || ''
    // Encode the variant in the name so the builder's existing strip logic derives the
    // variant + a Foil finish + the right pitch (mirrors how Scrydex/riftscribe names work).
    const suffix = m[2].match(/[a-z*]$/i)
    if (suffix) {
      if (suffix[0] === '*') name += ' (Overnumbered)'
      else name += ' (Alternate Art)'
    }

    const type = (c.cardType && Array.isArray(c.cardType.type) && c.cardType.type[0] && c.cardType.type[0].label) || ''
    const rarity = titleCase(idOf(c.rarity) || '')
    const domain = (c.domain && Array.isArray(c.domain.values) ? c.domain.values.map((v) => v.label).filter(Boolean).join(';') : '')
    const e = idOf(c.energy), p = idOf(c.power), m2 = idOf(c.might)
    const img = (c.cardImage && c.cardImage.url) || ''

    const set = (sets[code.toLowerCase()] ||= { name: labelOf(c.set) || code, code, cards: [] })
    set.cards.push({
      k, num, name, rarity, type, domain,
      e: e != null ? String(e) : '',
      p: p != null ? String(p) : '',
      m: m2 != null ? String(m2) : '',
      img,
    })
    kept++
  }

  // Order sets by release; order cards by collector number then suffix for stable output.
  const ordered = {}
  const seen = new Set()
  const sortCards = (a, b) => {
    const na = parseInt(a.k, 10) || 0, nb = parseInt(b.k, 10) || 0
    return na - nb || a.k.localeCompare(b.k)
  }
  for (const code of SET_ORDER) {
    const key = code.toLowerCase()
    if (sets[key]) { sets[key].cards.sort(sortCards); ordered[key] = sets[key]; seen.add(key) }
  }
  for (const key of Object.keys(sets)) {                          // any future set not in SET_ORDER
    if (!seen.has(key)) { sets[key].cards.sort(sortCards); ordered[key] = sets[key] }
  }

  // Atomic write: stage to a temp file then rename over the live catalog (never a partial file).
  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(ordered))
  renameSync(tmp, out)

  const summary = Object.entries(ordered).map(([, s]) => `${s.code}:${s.cards.length}`).join(' ')
  return { kept, skipped, total: cards.length, sets: Object.keys(ordered).length, summary, out }
}

// CLI entry — only runs when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildRiftboundData()
  console.log(`kept ${r.kept} of ${r.total} cards (skipped ${r.skipped} non-numbered) across ${r.sets} sets [${r.summary}] -> ${r.out}`)
}
