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
//   { dex:{ "6":"Charizard", … }, ja:{ "リザードン":"Charizard", … }, ko:{…}, "zh-cn":{…}, "zh-tw":{…} }

import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pokemon-dex-en.json')
const GQL = 'https://beta.pokeapi.co/graphql/v1beta'
const MAX_DEX = 1025
const CHUNK = 200
// PokéAPI language code -> our output bucket. ja-Hrkt = katakana (what TCGdex JP cards print).
const LANGS = { en: 'en', 'ja-Hrkt': 'ja', ko: 'ko', 'zh-Hans': 'zh-cn', 'zh-Hant': 'zh-tw' }

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

export async function buildPokemonDex({ out = OUT } = {}) {
  const map = { dex: {}, ja: {}, ko: {}, 'zh-cn': {}, 'zh-tw': {} }
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

  mkdirSync(dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  writeFileSync(tmp, JSON.stringify(map))
  renameSync(tmp, out)
  return { species: seen, ja: Object.keys(map.ja).length, ko: Object.keys(map.ko).length, out }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await buildPokemonDex()
  console.log('pokemon-dex baked: ' + r.species + ' species (ja ' + r.ja + ', ko ' + r.ko + ') -> ' + r.out)
}
