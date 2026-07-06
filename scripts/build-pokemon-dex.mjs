// build-pokemon-dex.mjs — bake ENGLISH Pokémon names for the JP/CN/KO listing output.
//
// Why: TCGdex serves JP/CN/KO card NAMES in native script (リザードンex), but eBay listings must be
// English (Charizard ex). Two resolution paths are needed because TCGdex's high-value ex/special
// cards often OMIT the `dexId`:
//   1. dexId  -> English  (works for most cards, which carry a national-dex number)
//   2. native species name -> English  (fallback for the dexId-less ex/full-art chase cards)
// Source: PokéAPI GraphQL (keyless) — one small set of queries yields the English + Japanese(katakana)
// + Korean + Simplified/Traditional-Chinese species names. Dex names change ~once per generation, so
// this is a rare standalone bake (NOT in the daily refresh).
//
// CLI: `node scripts/build-pokemon-dex.mjs` -> data/pokemon-dex-en.json
//   { dex:{ "6":"Charizard", … }, ja:{ "リザードン":"Charizard", … }, ko:{…}, "zh-cn":{…}, "zh-tw":{…},
//     romaji:{ "charizard":"Lizardon", … } }   // English-name(lowercased) -> PokéAPI ja-roma romanization

import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pokemon-dex-en.json')
const GQL = 'https://beta.pokeapi.co/graphql/v1beta'
const MAX_DEX = 1025
const CHUNK = 200
// PokéAPI language code -> our output bucket. ja-Hrkt = katakana (what TCGdex JP cards print).
const LANGS = { en: 'en', 'ja-Hrkt': 'ja', ko: 'ko', 'zh-Hans': 'zh-cn', 'zh-Hant': 'zh-tw' }
// Romaji (e.g. トリデプス -> "Torideps") is the "ja-roma" name — only the REST species endpoint carries it
// (the GraphQL mirror exposes an older "roomaji" variant with different spellings), so it's a separate pass.
const REST_SPECIES = 'https://pokeapi.co/api/v2/pokemon-species/'
const ROMAJI_CONCURRENCY = 8

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// eBay-friendly ASCII: drop combining accents (Flabébé -> Flabebe); keep symbols like ♀/♂.
const deAccent = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')

async function gql(ids) {
  const query = 'query($ids:[Int!]){ pokemon_v2_pokemonspecies(where:{id:{_in:$ids}}){ id ' +
    'pokemon_v2_pokemonspeciesnames(where:{pokemon_v2_language:{name:{_in:["en","ja-Hrkt","ko","zh-Hans","zh-Hant"]}}}){ ' +
    'name pokemon_v2_language{name} } } }'
  const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query, variables: { ids } }) })
  if (!r.ok) throw new Error('PokéAPI GraphQL HTTP ' + r.status)
  const j = await r.json()
  const rows = j && j.data && j.data.pokemon_v2_pokemonspecies
  if (!Array.isArray(rows)) throw new Error('unexpected GraphQL shape: ' + JSON.stringify(j).slice(0, 200))
  return rows
}

// Best-effort "ja-roma" romaji per species from the REST endpoint (the GraphQL mirror lacks it).
// Failures are tolerated — romaji is enrichment, so a partial/empty result never fails the bake.
async function fetchRomaji(id) {
  try {
    const r = await fetch(REST_SPECIES + id + '/')
    if (!r.ok) return null
    const j = await r.json()
    const hit = (j.names || []).find((n) => n.language && n.language.name === 'ja-roma')
    return (hit && hit.name) || null
  } catch { return null }
}

// Resolve romaji for every dex id with bounded concurrency; writes into map.romaji keyed by English name.
async function fillRomaji(map) {
  const ids = Object.keys(map.dex)
  let i = 0
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++]
      const romaji = await fetchRomaji(id)
      if (romaji) map.romaji[map.dex[id].toLowerCase()] = romaji
    }
  }
  await Promise.all(Array.from({ length: ROMAJI_CONCURRENCY }, worker))
}

export async function buildPokemonDex({ out = OUT } = {}) {
  const map = { dex: {}, ja: {}, ko: {}, 'zh-cn': {}, 'zh-tw': {}, romaji: {} }
  let seen = 0
  for (let start = 1; start <= MAX_DEX; start += CHUNK) {
    const ids = []
    for (let i = start; i < start + CHUNK && i <= MAX_DEX; i++) ids.push(i)
    const rows = await gql(ids)
    for (const sp of rows) {
      const names = {}
      for (const n of (sp.pokemon_v2_pokemonspeciesnames || [])) {
        const bucket = LANGS[n.pokemon_v2_language && n.pokemon_v2_language.name]
        if (bucket) names[bucket] = n.name
      }
      const en = deAccent(names.en)
      if (!en) continue
      seen++
      map.dex[sp.id] = en
      for (const lang of ['ja', 'ko', 'zh-cn', 'zh-tw']) if (names[lang]) map[lang][names[lang]] = en
    }
    await sleep(150)   // be polite between chunks
  }
  if (seen < 900) throw new Error('only resolved ' + seen + ' species — response truncated?')

  await fillRomaji(map)   // English name -> "ja-roma" romanization (best-effort REST pass)

  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(map))
  renameSync(tmp, out)
  return { species: seen, ja: Object.keys(map.ja).length, romaji: Object.keys(map.romaji).length, ko: Object.keys(map.ko).length, out }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildPokemonDex()
  console.log('pokemon-dex baked: ' + r.species + ' species (ja ' + r.ja + ', romaji ' + r.romaji + ', ko ' + r.ko + ') -> ' + r.out)
}
