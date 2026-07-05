// build-pokemon-intl-sets.mjs — bake the multi-language (JP / Simplified-CN / Traditional-CN /
// Korean) Pokémon SET INDEX for the listing builder's language-aware picker.
//
// Source: TCGdex (https://api.tcgdex.net/v2/{lang}) — keyless, CORS-friendly, and it uses the
// PRINTED set code as the set id (JP `SV3`/`M5`, CN `CSV4C`), which is exactly the symbol the
// user searches by. English stays on pokemontcg.io (the only real EN price source); this bake is
// JP/CN/KO only. TCGdex has NO prices — the builder layers eBay AUD comps on top.
//
// The brief list `/v2/{lang}/sets` carries only {id, name, cardCount}; serie / releaseDate /
// symbol need a per-set fetch. To stay polite we ENRICH INCREMENTALLY: the existing
// data/pokemon-intl-sets.json is reused, so only NEW sets are fetched (the first build does the
// full ~300, every daily refresh after that is a handful). A human-curated overlay
// (data/pokemon-intl-seed.json) adds English names (name_en) + nullable English-equivalent sets
// (enEquivalent), and can INJECT a brand-new set TCGdex has not ingested yet.
//
// Two entry points:
//   - CLI:    `node scripts/build-pokemon-intl-sets.mjs`
//   - Import: `import { buildPokemonIntlSets } from './build-pokemon-intl-sets.mjs'`
//             (used by lib/refresh.mjs's daily in-process refresh timer).
// The write is ATOMIC (temp file + rename) and GR7-safe: a failed brief-list fetch throws BEFORE
// the rename (existing catalog kept); a single per-set enrichment failure is logged and skipped.
//
// Output: data/pokemon-intl-sets.json — { "ja":[rec,…], "zh-cn":[…], "zh-tw":[…], "ko":[…] }
//   rec = { code (UPPERCASE printed code = search key), tcgdexId (original casing, for API calls),
//           name_native, name_en?, serie, releaseDate, cardCount, symbol (base URL, append .png),
//           enEquivalent?:{id,name}, seeded? }   — sorted newest-first by releaseDate.

import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { listPokemonConsoles } from '../lib/pricecharting.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'data', 'pokemon-intl-sets.json')
const SEED_PATH = join(ROOT, 'data', 'pokemon-intl-seed.json')
const API = 'https://api.tcgdex.net/v2'
const LANGS = ['ja', 'zh-cn', 'zh-tw', 'ko']
// TCGdex lang -> PriceCharting console-language bucket (zh-tw has no PC bucket; it stays TCGdex).
const PC_BUCKET = { ja: 'japanese', 'zh-cn': 'chinese', ko: 'korean' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const titleCaseSlug = (suf) => suf.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')

// Merge PriceCharting consoles into the set index — the key to JP/CN/KO card data + images.
// (1) Attach a pcSlug to matching TCGdex sets. (2) Add every remaining PC console as its own set so
// EVERY PriceCharting-covered set is card-lookupable. JP/KO consoles are slugged by ENGLISH set name;
// CN consoles are slugged by the printed CODE.
function mergePcConsoles(result, dir) {
  let matched = 0, added = 0
  const jaByCode = new Map((result.ja || []).map((s) => [s.code, s]))
  for (const lang of Object.keys(PC_BUCKET)) {
    const bucketName = PC_BUCKET[lang]
    const slugs = dir[bucketName] || []
    const pre = 'pokemon-' + bucketName + '-'
    const list = result[lang] || (result[lang] = [])
    const used = new Set()
    // 1) attach pcSlug to existing TCGdex sets
    for (const rec of list) {
      const cands = []
      if (lang === 'zh-cn') {
        const c = rec.code.toLowerCase()
        cands.push('pokemon-chinese-' + c.replace(/\./g, ''), 'pokemon-chinese-' + c.replace(/\./g, '-'), 'pokemon-chinese-' + c)
        if (rec.name_en) cands.push('pokemon-chinese-' + slugify(rec.name_en))
      } else if (lang === 'ja') {
        if (rec.name_en) cands.push('pokemon-japanese-' + slugify(rec.name_en))
      } else if (lang === 'ko') {
        const jp = jaByCode.get(rec.code)
        if (jp && jp.name_en) cands.push('pokemon-korean-' + slugify(jp.name_en))
        if (rec.name_en) cands.push('pokemon-korean-' + slugify(rec.name_en))
      }
      let slug = cands.find((c) => slugs.includes(c))
      if (!slug && rec.name_en) {
        const ns = slugify(rec.name_en)
        if (ns.length >= 4) slug = slugs.find((b) => { const suf = b.slice(pre.length); return suf === ns || suf.includes(ns) || ns.includes(suf) })
      }
      if (slug) { rec.pcSlug = slug; used.add(slug); matched++ }
    }
    // 2) add every unmatched PC console as its own set (full card-lookup coverage)
    for (const slug of slugs) {
      if (used.has(slug)) continue
      const suf = slug.slice(pre.length)
      if (/promo/i.test(suf)) continue                          // skip the generic per-era promo bucket
      const rec = { code: '', tcgdexId: '', name_native: '', name_en: '', serie: '', releaseDate: '', cardCount: null, pcSlug: slug, pcOnly: true }
      if (lang === 'zh-cn') rec.code = suf.toUpperCase()        // CN slug IS the printed code
      else rec.name_en = titleCaseSlug(suf)                     // JP/KO slug IS the English name
      list.push(rec); added++
    }
    list.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || (a.name_en || a.code || '').localeCompare(b.name_en || b.code || ''))
  }
  return { matched, added }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

// Small concurrency pool with a per-request delay — polite to a free community API.
async function pooled(items, worker, { concurrency = 6, delayMs = 60 } = {}) {
  let i = 0
  async function run() {
    while (i < items.length) {
      const idx = i++
      await worker(items[idx], idx)
      if (delayMs) await sleep(delayMs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
}

function loadSeed() {
  try { return JSON.parse(readFileSync(SEED_PATH, 'utf8')); } catch { return {}; }
}

// Map `${lang}:${CODE}` -> prior record, so an already-enriched set is reused (no re-fetch).
function loadExisting(out) {
  const map = new Map()
  try {
    const j = JSON.parse(readFileSync(out, 'utf8'))
    for (const lang of Object.keys(j)) for (const r of (j[lang] || [])) if (r && r.code) map.set(lang + ':' + r.code, r)
  } catch {}
  return map
}

const cc = (o) => (o ? (o.official != null ? o.official : (o.total != null ? o.total : null)) : null)

// Bake the index and (atomically) write it to `out`. Returns a summary object.
export async function buildPokemonIntlSets({ out = OUT } = {}) {
  const seed = loadSeed()
  const prior = loadExisting(out)
  const result = {}
  let fetched = 0, reused = 0, injected = 0

  for (const lang of LANGS) {
    let brief
    try { brief = await fetchJson(API + '/' + encodeURIComponent(lang) + '/sets'); }
    catch (e) { throw new Error('brief set list failed for ' + lang + ' — ' + e.message); }   // structural → keep old file
    if (!Array.isArray(brief) || !brief.length) throw new Error('no sets returned for ' + lang)

    const records = []
    const toEnrich = []
    for (const b of brief) {
      const code = String(b.id || '').toUpperCase()
      if (!code) continue
      const p = prior.get(lang + ':' + code)
      const rec = {
        code,
        tcgdexId: b.id,
        name_native: b.name || (p && p.name_native) || '',
        serie: (p && p.serie) || '',
        releaseDate: (p && p.releaseDate) || '',
        cardCount: cc(b.cardCount) != null ? cc(b.cardCount) : (p ? p.cardCount : null),
        symbol: (p && p.symbol) || b.symbol || '',
      }
      records.push(rec)
      if (!rec.releaseDate) toEnrich.push(rec)   // only un-enriched sets need a full fetch
      else reused++
    }

    await pooled(toEnrich, async (rec) => {
      try {
        const f = await fetchJson(API + '/' + encodeURIComponent(lang) + '/sets/' + encodeURIComponent(rec.tcgdexId))
        rec.serie = (f.serie && (f.serie.name || f.serie.id)) || rec.serie
        rec.releaseDate = f.releaseDate || rec.releaseDate
        rec.symbol = f.symbol || rec.symbol
        if (cc(f.cardCount) != null) rec.cardCount = cc(f.cardCount)
        if (!rec.name_native && f.name) rec.name_native = f.name
        fetched++
      } catch (e) { console.warn('[pkm-intl] enrich ' + lang + '/' + rec.tcgdexId + ' failed — ' + e.message); }
    }, { concurrency: 6, delayMs: 60 })

    // Merge the curated overlay: enrich existing rows; inject not-yet-ingested sets.
    const byCode = new Map(records.map((r) => [r.code, r]))
    const seedLang = seed[lang] || {}
    for (const rawCode of Object.keys(seedLang)) {
      const code = rawCode.toUpperCase()
      const sd = seedLang[rawCode] || {}
      const ex = byCode.get(code)
      if (ex) {
        if (sd.name_en) ex.name_en = sd.name_en
        if (sd.enEquivalent) ex.enEquivalent = sd.enEquivalent
        if (sd.name_native && !ex.name_native) ex.name_native = sd.name_native
        if (sd.serie && !ex.serie) ex.serie = sd.serie
        if (sd.releaseDate && !ex.releaseDate) ex.releaseDate = sd.releaseDate
        if (sd.cardCount != null && ex.cardCount == null) ex.cardCount = sd.cardCount
      } else {
        const rec = {
          code, tcgdexId: sd.tcgdexId || rawCode,
          name_native: sd.name_native || '', name_en: sd.name_en || '',
          serie: sd.serie || '', releaseDate: sd.releaseDate || '',
          cardCount: sd.cardCount != null ? sd.cardCount : null,
          symbol: sd.symbol || '', seeded: true,
        }
        if (sd.enEquivalent) rec.enEquivalent = sd.enEquivalent
        records.push(rec); byCode.set(code, rec); injected++
      }
    }

    records.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    result[lang] = records
  }

  // Merge PriceCharting consoles (JP/CN/KO card + image source). Best-effort (GR7).
  let pcMatched = 0, pcAdded = 0
  try {
    const dir = await listPokemonConsoles()
    const r = mergePcConsoles(result, dir)
    pcMatched = r.matched; pcAdded = r.added
  } catch (e) { console.warn('[pkm-intl] PriceCharting console directory unavailable — ' + (e?.message || e)) }

  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(result))
  renameSync(tmp, out)

  const counts = LANGS.map((l) => l + ':' + result[l].length).join(' ')
  const summary = counts + ' (fetched ' + fetched + ', reused ' + reused + ', injected ' + injected + ', pcSlugs ' + pcMatched + ', pcAdded ' + pcAdded + ')'
  return { summary, out, fetched, reused, injected, pcMatched, pcAdded }
}

// CLI entry — only runs when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildPokemonIntlSets()
  console.log('pokemon-intl baked [' + r.summary + '] -> ' + r.out)
}
