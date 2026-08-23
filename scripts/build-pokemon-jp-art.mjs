// build-pokemon-jp-art.mjs — find the Japanese cards whose PriceCharting image is not a card scan,
// and record Serebii's scan for them. Reader + rule live in lib/pokemon-jp-art.mjs.
//
// ACCRETIVE and CAPPED. A verdict per card never changes once measured (a scan that is a card stays
// a card), so the store is keyed by set+number and a measured card is never re-fetched. That matters
// because measuring means downloading the thumbnail: the first pass over the whole Japanese catalogue
// is ~20k small images, and every pass after it is just the newest set. The per-run cap keeps any one
// run bounded and REPORTS what it deferred — a bounded run that reads as "all done" is the failure
// this repo already fixed once in the coverage watchdog.
//
// Only sets with BOTH a PriceCharting console (the images to check) and an English name (the Serebii
// slug is built from it) can be measured at all.
import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { enumerateConsole } from '../lib/pricecharting.mjs'
import { normSetKey } from '../lib/pkm-sets-cache.mjs'
import { serebiiSlug, serebiiCardUrl, decideArtOverride, isSingleCardAspect, parseSerebiiIndex, serebiiAlignment, INDEX_PATH } from '../lib/pokemon-jp-art.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SETS_PATH = join(ROOT, 'data', 'pokemon-intl-sets.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const readJson = (p, f) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return f } }

// Aspect ratio of one image, or null when it cannot be read. Never throws — an unreadable image is
// simply not evidence, and must not be recorded as a verdict.
async function aspectOf(sharp, url, browser) {
  try {
    const r = await fetch(url, browser ? { headers: { 'user-agent': UA } } : undefined)
    if (!r.ok) return null
    const b = Buffer.from(await r.arrayBuffer())
    const m = await sharp(b).metadata()
    if (!m.width || !m.height) return null
    return m.width / m.height
  } catch { return null }
}

// Serebii's set roster in one request. {} on any failure — an unreadable roster means nothing can
// be PROVEN to be the same card, and decideArtOverride then keeps PriceCharting's image.
async function fetchSerebiiIndex(slug) {
  try {
    const r = await fetch('https://www.serebii.net/card/' + slug + '/', { headers: { 'user-agent': UA } })
    if (!r.ok) return {}
    return parseSerebiiIndex(await r.text(), slug)
  } catch { return {} }
}

export async function buildPokemonJpArt({ out = INDEX_PATH, max = 3000, delayMs = 0 } = {}) {
  const sharp = (await import('sharp')).default
  const idx = readJson(SETS_PATH, {})
  const prior = readJson(out, {})
  const priorSets = prior.sets || {}
  const measured = new Set(prior.measured || [])     // "setKey|number" — every card ever judged

  const sets = (idx.ja || []).filter((s) => s.pcSlug && s.name_en)
  // Newest first: that is where the crops are, and where a capped run should spend its budget.
  sets.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')))

  const out_sets = { ...priorSets }
  let checked = 0, swapped = 0, deferred = 0, setsTouched = 0
  for (const s of sets) {
    const setKey = normSetKey(s.name_en)
    const slug = serebiiSlug(s.name_en)
    if (!setKey || !slug) continue
    let cards
    try { cards = (await enumerateConsole(s.pcSlug)).cards || [] } catch { continue }
    const todo = cards.filter((c) => c.image && !measured.has(setKey + '|' + String(c.number)))
    if (!todo.length) continue
    setsTouched++
    // Serebii's roster, ONCE per set. The substitution is by NUMBER, so without a name to check it
    // against, any set where the two catalogues number differently would quietly get other cards'
    // pictures. One page request per set is what makes proving it affordable — and it is only
    // fetched for a set that actually has something to measure.
    let serebiiNames = null, aligned = null
    for (const c of todo) {
      if (checked >= max) { deferred += 1; continue }
      const pcAspect = await aspectOf(sharp, c.image + '/320.jpg', false)
      if (pcAspect == null) continue                  // could not read it — not evidence, try again next run
      checked++
      // Only a card PriceCharting got WRONG is worth a second request. Note this cannot ask
      // decideArtOverride first: with no Serebii aspect to compare against, that rule correctly
      // answers 'keep' for everything, so using it as the filter skips every fetch and finds nothing.
      if (isSingleCardAspect(pcAspect)) { measured.add(setKey + '|' + String(c.number)); continue }
      if (serebiiNames === null) {
        serebiiNames = await fetchSerebiiIndex(slug)
        const a = serebiiAlignment(cards, serebiiNames)
        aligned = a.aligned
        if (!aligned) console.warn(`[jp-art] ${s.code} (${slug}) — numbering not corroborated (${a.match}/${a.both} names agree); no art swapped for this set`)
      }
      const url = serebiiCardUrl(slug, c.number)
      const serebiiAspect = await aspectOf(sharp, url, true)
      const verdict = decideArtOverride({ pcAspect, serebiiAspect, setAligned: aligned })
      measured.add(setKey + '|' + String(c.number))
      if (verdict === 'substitute') {
        out_sets[setKey] = out_sets[setKey] || {}
        out_sets[setKey][String(c.number).replace(/^0+(?=\d)/, '')] = url
        swapped++
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  const doc = { generatedAt: new Date().toISOString(), sets: out_sets, measured: [...measured] }
  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(doc))
  renameSync(tmp, out)
  if (deferred) console.warn(`[jp-art] ${deferred} cards deferred past the ${max}-per-run cap — they run next cycle`)
  const total = Object.values(out_sets).reduce((n, m) => n + Object.keys(m).length, 0)
  return {
    summary: `${checked} newly measured across ${setsTouched} set(s), ${swapped} replaced`
      + (deferred ? `, ${deferred} deferred` : '') + `, ${total} overrides held`,
    checked, swapped, deferred, overrides: total,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildPokemonJpArt()
  console.log('pokemon-jp-art baked [' + r.summary + '] -> ' + INDEX_PATH)
}
