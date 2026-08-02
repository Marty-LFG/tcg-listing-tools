// build-riftbound-data.mjs — bake the full Riftbound card catalog for the offline tier.
//
// Source: the OFFICIAL League of Legends card gallery (no key required). The page is a
// Next.js app; its card data lives at /_next/data/{buildId}/en-us/card-gallery.json. The
// buildId rotates on every Riot deploy, so we scrape it fresh from the gallery HTML each
// run (self-healing). Card images are Riot's own CDN (cmsassets.rgpub.io).
//
// This is the DEFAULT, keyless data source for the Riftbound builder — it covers every
// released set, with full energy/might/power stats that Scrydex does not carry. It has NO
// prices; the builder layers the keyless TCGplayer index (and eBay AUD comps) on top.
//
// SELF-UPDATING: the gallery ships its own set roster beside the cards — [{id, name,
// collectorNumberMax}] in RELEASE ORDER — so set codes, display names, printed totals and
// pill ordering all come from upstream. A new set needs NO code change here or in the
// builder; lib/refresh.mjs Telegram-alerts when one first appears (see newSets below).
//
// Two entry points:
//   - CLI:      `node scripts/build-riftbound-data.mjs`
//   - Import:   `import { buildRiftboundData } from './build-riftbound-data.mjs'`
//               (used by lib/refresh.mjs's in-process refresh timer).
// The write is ATOMIC (temp file + rename) and GR7-safe: a truncated/failed fetch throws
// BEFORE the rename, so the existing good catalog is never clobbered.
//
// Output: data/riftbound.json — keyed by lowercase set code, drop-in for the inline RB_DATA:
//   { "ogn": { name, code, total, cards: [ { k, num, name, rarity, type, domain, e, p, m, img } ] }, ... }
//   total = the printed set total (collectorNumberMax) — what the "/298" in a card number means
//   k     = normalized lookup key (lib/riftbound-data.mjs normNum: leading zeros stripped,
//           trailing letter/* suffix kept) — e.g. "066a", "227*", "1", "sp1"
//   num   = printed number incl. set total, VERBATIM (GR5) — e.g. "066a/298", "SP1/006"

import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { normNum } from '../lib/riftbound-data.mjs'

const GALLERY = 'https://riftbound.leagueoflegends.com/en-us/card-gallery/'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'riftbound.json')

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt } }
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

// publicCode = SET-NNN[a|*]/TOTAL, plus the special showcase promos (VEN-SP1/006). Tokens
// (UNL-T04) and per-set rune reprints (VEN-R03) carry no printed /TOTAL and are skipped —
// riftbound-data.mjs resolves R01..R06 from the canonical Origins printings instead.
const CODE_RE = /^([A-Z]{3})-(\d+[a-z*]?|SP\d+[a-z*]?)\/(\d+)$/

// The treatments the printed number CANNOT imply, keyed by identity (SETCODE-normNum).
//
// UNL-238 Baron Nashor is the game's only "(Ultimate)" — TCGplayer sells it at ~US$1,635, roughly
// 3x the set's Signatures. Riot's gallery gives it nothing to derive from: epic / unit / portrait,
// identical to its neighbours. It is over the set total, so the derivation would otherwise call it
// Overnumbered and the listing would undersell the set's headline card.
//
// A hardcoded row is normally how data rots, so this one is fenced in: it is keyed by identity (not
// by name or index), it has no Signature sibling to collide with (UNL stars stop at 237*), and
// test/data/riftbound-variants.test.mjs asserts every entry here still matches TCGplayer's own
// product name on each run — a stale or wrong override fails loudly instead of quietly shipping.
export const TREATMENT_OVERRIDE = { 'UNL-238': 'Ultimate' }

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

// The gallery's own set roster: [{ id:'VEN', name:'Vendetta', collectorNumberMax:166 }, ...] in
// RELEASE ORDER. Found structurally rather than by path (it lives under page.blades[N], and N
// moves between Riot deploys). Optional by design — groupCards falls back to the per-card
// denominators and first-seen order if Riot ever drops it (GR7: degrade, never throw).
function findSets(node, best = { arr: [] }) {
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object' && 'collectorNumberMax' in node[0]) {
      if (node.length > best.arr.length) best.arr = node
    }
    for (const v of node) findSets(v, best)
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) findSets(v, best)
  }
  return best.arr
}

// Safe accessors for the Sanity CMS field shapes ({label, value:{id,label}} / {values:[...]}).
const idOf = (f) => (f && f.value && f.value.id != null ? f.value.id : null)
const labelOf = (f) => (f && f.value && f.value.label != null ? f.value.label : null)

/**
 * Gallery cards + set roster -> the baked catalog shape. Pure; exported for the unit harness.
 *
 * VARIANT DERIVATION. Riot's own `rarity` field is NOT reliable for the premium printings — it
 * calls UNL 220/219 "Pouty Poro" a common (TCGplayer: Showcase, US$175) and VEN 167/166 "Vi,
 * Destructive" a rare (Showcase, US$125). The PRINTED NUMBER is reliable, and TCGplayer's product
 * names confirm the mapping, so derive the treatment here and encode it in the card name the same
 * way alt-art already was — the builder, lib/riftbound-data.mjs and every bulk consumer read the
 * name suffix, so all of them are correct with no further change.
 *   "299*" of 298 -> (Signature)      TCGplayer "Kai'Sa - Daughter of the Void (Signature)" US$2739
 *   "162a" of 298 -> (Alternate Art)  unchanged
 *   "167"  of 166 -> (Overnumbered)   TCGplayer "Vi - Destructive (Overnumbered)"           US$125
 *   "SP1"  of 006 -> no suffix, rarity forced to Showcase (the SP number IS the marker)
 * TREATMENT_OVERRIDE wins over all of it, for the one card whose treatment no number can imply.
 * ORDER MATTERS: every `*` card is ALSO over the total (12/12 in each of OGN/SFD/UNL), so `*` is
 * tested first or all 36 Signatures would relabel as Overnumbered. No alt-art card is ever over
 * the total; if one ever is, the letter suffix wins because it is the more specific marker.
 */
export function groupCards(rawCards, roster = [], prior = {}) {
  // Roster -> { CODE: {name, total} }, plus the release order the pills follow.
  const meta = new Map()
  const order = []
  for (const s of (roster || [])) {
    const id = String((s && s.id) || '').toUpperCase()
    if (!id || meta.has(id)) continue
    meta.set(id, { name: (s && s.name) || id, total: parseInt(s && s.collectorNumberMax, 10) || 0 })
    order.push(id)
  }

  // Pass 1: parse the printed codes and settle each set's total. The roster is authoritative;
  // the per-card denominator is the fallback, taken from a NON-SP card (an SP card's "/006" is
  // the size of the six-card showcase subset, not the set).
  const rows = []
  let skipped = 0
  for (const c of rawCards) {
    const m = String((c && c.publicCode) || '').match(CODE_RE)
    if (!m) { skipped++; continue }
    const code = m[1], numPart = m[2], denomStr = m[3]
    const sp = /^SP/i.test(numPart)
    rows.push({ c, code, numPart, denomStr, sp })
    if (!meta.has(code)) meta.set(code, { name: labelOf(c.set) || code, total: 0 })
    const mm = meta.get(code)
    if (!mm.total && !sp) mm.total = parseInt(denomStr, 10) || 0
  }

  // Pass 2: build the set objects.
  const sets = {}
  let kept = 0
  for (const { c, code, numPart, denomStr, sp } of rows) {
    const total = meta.get(code).total
    const star = numPart.endsWith('*')
    const alt = !sp && /[a-z]$/i.test(numPart)
    const over = !sp && !star && !alt && total > 0 && (parseInt(numPart, 10) || 0) > total

    const k = normNum(numPart)
    let name = c.name || ''
    const override = TREATMENT_OVERRIDE[code + '-' + k]      // wins: the number cannot imply it
    if (override) name += ' (' + override + ')'
    else if (star) name += ' (Signature)'
    else if (alt) name += ' (Alternate Art)'
    else if (over) name += ' (Overnumbered)'

    const type = (c.cardType && Array.isArray(c.cardType.type) && c.cardType.type[0] && c.cardType.type[0].label) || ''
    // Riot labels all six VEN-SP cards "epic"; TCGplayer sells them as Showcase (US$14-71) and,
    // unlike the * / over-total cards, they carry no name suffix for the builder to detect.
    const rarity = sp ? 'Showcase' : titleCase(idOf(c.rarity) || '')
    const domain = (c.domain && Array.isArray(c.domain.values) ? c.domain.values.map((v) => v.label).filter(Boolean).join(';') : '')
    const e = idOf(c.energy), p = idOf(c.power), m2 = idOf(c.might)
    const img = (c.cardImage && c.cardImage.url) || ''

    const key = code.toLowerCase()
    const set = (sets[key] ||= { name: meta.get(code).name, code, total: meta.get(code).total, cards: [] })
    set.cards.push({
      k,                                 // "66a" | "299*" | "sp1"
      num: numPart + '/' + denomStr,     // printed VERBATIM (GR5) — "066a/298", "SP1/006"
      name, rarity, type, domain,
      e: e != null ? String(e) : '',
      p: p != null ? String(p) : '',
      m: m2 != null ? String(m2) : '',
      img,
    })
    kept++
  }

  // Order sets by Riot's release order (anything absent from the roster keeps first-seen order),
  // and cards by collector number, with the SP showcase block last (parseInt('sp1') is NaN).
  const sortCards = (a, b) => {
    const sa = /^sp/.test(a.k) ? 1 : 0, sb = /^sp/.test(b.k) ? 1 : 0
    if (sa !== sb) return sa - sb
    const na = parseInt(a.k, 10) || 0, nb = parseInt(b.k, 10) || 0
    return na - nb || a.k.localeCompare(b.k)
  }
  const ordered = {}
  for (const code of order) {
    const key = code.toLowerCase()
    if (sets[key]) { sets[key].cards.sort(sortCards); ordered[key] = sets[key] }
  }
  for (const key of Object.keys(sets)) {
    if (!ordered[key]) { sets[key].cards.sort(sortCards); ordered[key] = sets[key] }
  }

  // Brand-new sets, for the Telegram alert. Gated on a non-empty prior: data/riftbound.json is
  // gitignored, so on a fresh deploy every set would otherwise look new (same guard
  // buildRiftboundPrices uses for its "N new" summary).
  const priorCodes = new Set(Object.keys(prior || {}))
  const newSets = priorCodes.size
    ? Object.keys(ordered).filter((k) => !priorCodes.has(k))
      .map((k) => ({ code: ordered[k].code, name: ordered[k].name, total: ordered[k].total, cards: ordered[k].cards.length }))
    : []

  return { ordered, kept, skipped, newSets }
}

// Bake the catalog and (atomically) write it to `out`. Returns a summary object.
// Throws on any fetch/structure failure BEFORE writing — the caller keeps the old file.
export async function buildRiftboundData({ out = OUT } = {}) {
  const html = await (await fetch(GALLERY)).text()
  const bid = html.match(/"buildId"\s*:\s*"([^"]+)"/)
  if (!bid) throw new Error('Could not find Next.js buildId in gallery HTML — Riot changed the page structure.')
  const dataUrl = `https://riftbound.leagueoflegends.com/_next/data/${bid[1]}/en-us/card-gallery.json`

  const json = await (await fetch(dataUrl)).json()
  const cards = findCards(json)
  if (cards.length < 500) throw new Error(`Only found ${cards.length} cards (expected ~1180) — response truncated or structure changed.`)

  const { ordered, kept, skipped, newSets } = groupCards(cards, findSets(json), readJson(out, {}))

  // Atomic write: stage to a temp file then rename over the live catalog (never a partial file).
  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(ordered))
  renameSync(tmp, out)

  const summary = Object.entries(ordered).map(([, s]) => `${s.code}:${s.cards.length}`).join(' ')
  return { kept, skipped, total: cards.length, sets: Object.keys(ordered).length, newSets, summary, out }
}

// CLI entry — only runs when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildRiftboundData()
  console.log(`kept ${r.kept} of ${r.total} cards (skipped ${r.skipped} non-numbered) across ${r.sets} sets [${r.summary}] -> ${r.out}`)
}
