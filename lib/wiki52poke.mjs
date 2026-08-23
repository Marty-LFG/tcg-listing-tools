// lib/wiki52poke.mjs — Simplified-Chinese card lists from 52poke (神奇宝贝百科), keyless.
//
// WHY THIS EXISTS. TCGdex indexes the zh-cn SETS but serves no cards for any of them — verified
// 2026-08-23: /v2/zh-cn/sets/<id> answers 200 with cardCount.official populated and an EMPTY
// cards[], and /v2/zh-cn/cards/<id>-<n> is a flat 404. PriceCharting covers 22 of 66 CN sets and
// its directory holds no more. So for the remaining ~35 sets there is no other source at all, and
// they sat in the catalogue pickable and unlistable. 52poke is a MediaWiki, and its card lists are
// machine-readable wikitext rather than rendered HTML, which makes it a far steadier parse than a
// scrape.
//
// A row looks like one of these, and that is the whole contract:
//   {{卡牌列表/entryjp|001/125|{{C|妙蛙花V|SEF}}|草||RR|}}     Pokémon — {{C|name|jp-origin-set}}
//   {{卡牌列表/entryjp|119/125|{{TCG|夏科娅}}|支援者卡||U|}}    Trainer/Energy — {{TCG|name}}
// giving number/total, the Chinese name, the type, and the rarity.
//
// Names come back CHINESE. Callers turn them English through lib/pokemon-intl.mjs englishCardName
// with the zh-cn species map already baked into data/pokemon-dex-en.json (1025 entries) — the same
// path the Japanese lane uses. Trainers and Energy have no species to resolve, so they keep their
// Chinese name, which is exactly what STOCK_GAME_ADAPTERS.pokemon already does on the JP lane
// (`englishCardName(...) || c.name`). 52poke carries no per-card images or prices; the cards are
// addressable by NUMBER, which is what the stock tools match on.
const API = 'https://wiki.52poke.com/api.php'
// MediaWiki rejects a UA-less request with 403. A descriptive one is also the polite thing to send.
const UA = 'tcg-listing-tools/1.0 (Pokemon TCG set index; +https://github.com/) node-fetch'
const TIMEOUT_MS = 20000

async function api(params) {
  const u = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params })
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally { clearTimeout(t) }
}

// The display name out of a 52poke name cell. Pokémon use {{C|名前|set}}, everything else uses
// {{TCG|target}} or {{TCG|target|display}} — the DISPLAY half wins when both are present, because
// the target is a wiki page title and can carry a disambiguator the card does not print.
export function cellName(cell) {
  const s = String(cell || '').trim()
  const c = s.match(/\{\{C\|([^|}]+)/)
  if (c) return c[1].trim()
  const tcg = s.match(/\{\{TCG\|([^|}]+)(?:\|([^|}]+))?/)
  if (tcg) return (tcg[2] || tcg[1]).trim()
  return s.replace(/\{\{|\}\}/g, '').split('|')[0].trim()
}

// Split a template invocation into its top-level cells. A regex cannot do this: the NAME cell is
// itself a template ({{C|妙蛙花V|SEF}}) whose own pipes would be read as cell separators, which
// silently yields the string "C" as every Pokémon's name. So track brace depth and only split at
// depth zero.
export function splitCells(line) {
  const body = line.slice(line.indexOf('|') + 1)
  const cells = []
  let cur = '', depth = 0
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2)
    if (two === '{{') { depth++; cur += two; i++; continue }
    if (two === '}}') { if (depth) { depth--; cur += two; i++; continue } break }   // closes the row
    const ch = body[i]
    if (ch === '|' && depth === 0) { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

// Parse a 52poke set page's card list. Pure over the wikitext, so the unit harness runs it offline.
// Returns [{ numRaw, name (CHINESE), rarity, type }] in page order.
export function parseCardList(wikitext) {
  const out = []
  const seen = new Set()
  for (const line of String(wikitext || '').split('\n')) {
    if (!line.includes('卡牌列表/entry')) continue
    const cells = splitCells(line)                 // <num>/<total> | <name> | <type> | <sub> | <rarity>
    if (cells.length < 2) continue
    const numRaw = String(cells[0] || '').split('/')[0].trim().replace(/^0+(?=\d)/, '')
    const name = cellName(cells[1])
    if (!numRaw || !name) continue
    const key = numRaw + '|' + name
    if (seen.has(key)) continue                    // a page can list a card twice across sub-tables
    seen.add(key)
    out.push({ numRaw, name, rarity: String(cells[4] || '').trim(), type: String(cells[2] || '').trim() })
  }
  return out
}

// Resolve a set's 52poke page title from its native name. The direct form hits for every set
// checked (洪荒演武 茂 -> 洪荒演武 茂（TCG）); search is the fallback for the ones that do not.
export async function resolveSetTitle(nameNative) {
  const name = String(nameNative || '').trim()
  if (!name) return ''
  const direct = name + '（TCG）'
  try {
    const j = await api({ action: 'query', titles: direct, prop: 'info' })
    const p = j && j.query && j.query.pages && j.query.pages[0]
    if (p && !p.missing) return direct
  } catch {}
  const j = await api({ action: 'query', list: 'search', srsearch: name, srlimit: '8' })
  const hits = (j && j.query && j.query.search) || []
  const tcg = hits.find((h) => h.title === direct) || hits.find((h) => h.title.endsWith('（TCG）'))
  return tcg ? tcg.title : ''
}

// One set's card list. Throws when the page cannot be found or carries no list, so the caller's
// source chain treats it as "not here" and moves on rather than caching an empty set (GR7).
export async function fetchCnSetCards(nameNative) {
  const title = await resolveSetTitle(nameNative)
  if (!title) throw new Error('no 52poke page for ' + nameNative)
  const j = await api({ action: 'query', titles: title, prop: 'revisions', rvprop: 'content', rvslots: 'main' })
  const p = j && j.query && j.query.pages && j.query.pages[0]
  const text = p && p.revisions && p.revisions[0] && p.revisions[0].slots && p.revisions[0].slots.main
    && p.revisions[0].slots.main.content
  if (!text) throw new Error('52poke page has no content: ' + title)
  const cards = parseCardList(text)
  if (!cards.length) throw new Error('52poke page has no card list: ' + title)
  return { title, cards }
}
