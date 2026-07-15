// build-pokemon-en-early.mjs — bake data/pokemon-en-early.json: EN Pokémon sets that PriceCharting
// lists BEFORE pokemontcg.io catalogs them (pokemontcg.io lags to ~street date), so pre-release-event
// cards are browsable + listable early. The EN lane is otherwise a live pokemontcg.io mirror with no
// early source; this bake is its seed/early overlay (parallel to build-pokemon-intl-sets.mjs for JP).
//
// Discovery is HIGH-PRECISION + corroborated — it never invents a set from a bare console slug:
//   AUTO   : a JP set's curated enEquivalent.name (data/pokemon-intl-sets.json) that is NOT yet in
//            pokemontcg.io AND has a matching English PriceCharting console. JP is used ONLY as an
//            "an EN set is coming" signal + its announced EN NAME; the roster/numbering come from the
//            EN PriceCharting console (JP<->EN sets are N:1 — EN merges JP sets — never assumed equal).
//   MANUAL : data/pokemon-en-early-seed.json (sets with no JP mapping / a name mismatch / to pin a
//            code or date). Manual wins on a name collision.
// GRADUATION: any candidate pokemontcg.io now lists is DROPPED (it's authoritative there); the caller
//            may pass clearCache(lang, code) to bust its stale set_cards row so the catalog re-fetches.
//
// GR7: knownEnSetNorms() + the directory fetch THROW on outage so a transient failure keeps the
// existing file (atomic temp+rename) rather than emptying it. Returns { summary, sets, newSets,
// graduated, out }. Two entry points: CLI (`node scripts/build-pokemon-en-early.mjs`) + import.

import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { listPokemonConsoles } from '../lib/pricecharting.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'data', 'pokemon-en-early.json')
const SEED = join(ROOT, 'data', 'pokemon-en-early-seed.json')
const INTL = join(ROOT, 'data', 'pokemon-intl-sets.json')

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '')
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...(headers || {}) } })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}
const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt } }

// pokemontcg.io EN set names (normalized) = the graduation gate. THROWS on failure so a transient
// outage never drops/keeps the wrong set (GR7: the caller then keeps the existing baked file).
export async function knownEnSetNorms(env = {}, fetchImpl = fetchJson) {
  const headers = env && env.POKEMONTCG_API_KEY ? { 'X-Api-Key': env.POKEMONTCG_API_KEY } : {}
  const j = await fetchImpl('https://api.pokemontcg.io/v2/sets?pageSize=500', headers)
  const set = new Set()
  for (const s of ((j && j.data) || [])) if (s.name) set.add(norm(s.name))
  if (!set.size) throw new Error('pokemontcg.io returned no sets')
  return set
}

// name -> English console slug (exact `pokemon-<slug>` first, then a suffix-tolerant scan). Pure.
export function enConsoleResolver(englishSlugs) {
  const bySlug = new Set(englishSlugs)
  return (name) => {
    const exact = 'pokemon-' + slugify(name)
    if (bySlug.has(exact)) return exact
    const target = slugify(name)
    if (target.length < 4) return ''
    for (const slug of englishSlugs) {
      const suf = slug.slice('pokemon-'.length)
      if (suf === target || suf.includes(target) || target.includes(suf)) return slug
    }
    return ''
  }
}

// Pure core (unit-testable offline): given the known-EN name set, the english console slugs, the
// manual seed, and the JP intl index, compute the early-set list + new/graduated deltas vs `prior`.
export function computeEnEarly({ known, english, seed, intl, prior }) {
  const resolveConsole = enConsoleResolver(english || [])
  const candidates = new Map()   // norm(name) -> record
  const add = (c) => {
    if (!c || !c.name) return
    const key = norm(c.name)
    if (known.has(key)) return                              // already live in pokemontcg.io -> not "early"
    const prev = candidates.get(key)
    if (!prev || c.manual) candidates.set(key, { ...(prev || {}), ...c })   // manual overrides auto
  }

  for (const e of ((seed && seed.sets) || [])) {
    add({ code: e.code || '', name: (e.name || '').trim(), series: e.series || '', releaseDate: e.releaseDate || '',
      pcSlug: e.pcSlug || resolveConsole(e.name) || '', jpEquivalent: e.jpEquivalent || '', source: 'manual', manual: true })
  }
  for (const lang of Object.keys(intl || {})) {
    for (const rec of (intl[lang] || [])) {
      const eq = rec && rec.enEquivalent
      const name = eq && eq.name ? String(eq.name).trim() : ''
      if (!name || known.has(norm(name))) continue
      const pcSlug = resolveConsole(name)
      if (!pcSlug) continue                                 // no EN console yet -> nothing to show, skip
      add({ code: eq.id || '', name, series: rec.serie || '', releaseDate: '', pcSlug, jpEquivalent: rec.code || '', source: 'auto' })
    }
  }

  const sets = [...candidates.values()]
    .filter((s) => s.pcSlug)                                // only sets we can actually enumerate cards for
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || a.name.localeCompare(b.name))
  const priorSets = (prior && prior.sets) || []
  const priorNames = new Set(priorSets.map((s) => norm(s.name)))
  const nowNames = new Set(sets.map((s) => norm(s.name)))
  const newSets = sets.filter((s) => !priorNames.has(norm(s.name)))
  const graduated = priorSets.filter((s) => !nowNames.has(norm(s.name)))
  return { sets, newSets, graduated }
}

export async function buildPokemonEnEarly({ out = OUT, env = {}, clearCache } = {}) {
  const known = await knownEnSetNorms(env)                 // throws on outage -> keep existing file
  let dir
  try { dir = await listPokemonConsoles() } catch (e) { throw new Error('PriceCharting directory unavailable — ' + (e?.message || e)) }
  const { sets, newSets, graduated } = computeEnEarly({
    known, english: dir.english || [], seed: readJson(SEED, { sets: [] }), intl: readJson(INTL, {}), prior: readJson(out, { sets: [] }),
  })

  if (typeof clearCache === 'function') for (const g of graduated) { try { clearCache('en', g.code || g.name) } catch {} }

  const body = { generatedAt: new Date().toISOString().slice(0, 10), sets }
  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(body, null, 2))
  renameSync(tmp, out)

  const summary = `${sets.length} early EN set(s) [${sets.map((s) => s.name).join(', ') || 'none'}]`
    + (newSets.length ? ` · ${newSets.length} new` : '') + (graduated.length ? ` · ${graduated.length} graduated` : '')
  return { summary, sets, newSets, graduated, out }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildPokemonEnEarly({ env: process.env })
  console.log('pokemon-en-early baked [' + r.summary + '] -> ' + r.out)
}
