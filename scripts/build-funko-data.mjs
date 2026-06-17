// build-funko-data.mjs — vendor + slim the Funko Pop catalog for the offline assist.
//
// Source: kennymkchan/funko-pop-data (MIT). The raw file is ~7.4 MB, 23.9k rows with 4
// fields (handle/title/imageName/series) and mixes in non-vinyl products (apparel, pins,
// Mystery Minis, Dorbz, Hikari, Soda, plushies, ...). This script keeps only actual
// **Pop! vinyl figures** and derives franchise / exclusive / chase tags from the messy
// `series` array so the builder can pre-fill those fields.
//
// The dataset is FROZEN at Jan 2021 — it is an assist for older Pops, never a source of
// truth. Re-run with `node scripts/build-funko-data.mjs` to refresh from upstream.
//
// Output: data/funko_pop.json — an array of slim records:
//   { t: title, img: imageUrl, fr: franchise|"", ex: exclusive|"", ch: 1? }

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC = 'https://raw.githubusercontent.com/kennymkchan/funko-pop-data/master/funko_pop.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'funko_pop.json')

// "Pop! X" lines that are NOT standard vinyl figures — apparel, pins, plush, Pez dispensers.
const NON_VINYL_POP = new Set(['Pop! Tees & Apparel', 'Pop! Pins', 'Pop! Plush'])
// A series token that denotes an actual Pop! vinyl figure line.
function isVinylPopLine(s) {
  return s.startsWith('Pop! ') && !NON_VINYL_POP.has(s) && !/^Pop! Pez/.test(s)
}

// Map a messy series token to a clean exclusive label (retailer or convention).
function exclusiveFromSeries(series) {
  for (const s of series) {
    const m = s.match(/^Funko (.+?) Exclusives$/)
    if (m) return m[1]                                   // "Funko Hot Topic Exclusives" -> "Hot Topic"
    if (/^Funko[- ]Shop$/i.test(s)) return 'Funko Shop'
    if (/^San Diego Comic-?Con\s*(\d{4})?/i.test(s)) return ('SDCC ' + (s.match(/\d{4}/) || '')).trim()
    if (/^New York Comic[- ]?Con\s*(\d{4})?/i.test(s)) return ('NYCC ' + (s.match(/\d{4}/) || '')).trim()
    if (/^Emerald City Comic[- ]?Con\s*(\d{4})?/i.test(s)) return ('ECCC ' + (s.match(/\d{4}/) || '')).trim()
    if (/Comic[- ]?Con/i.test(s) && /\d{4}/.test(s)) return s                  // other con, keep as-is
  }
  return ''
}

// Pick the most specific franchise/line: prefer a "Pop! X" that isn't the generic ones.
function franchiseFromSeries(series) {
  const lines = series
    .filter(isVinylPopLine)
    .map(s => s.slice('Pop! '.length))
  // Only a real franchise/category — never the generic "Vinyl"/"Funko" line label.
  return lines.find(l => !['Vinyl', 'Funko'].includes(l)) || ''
}

const raw = await (await fetch(SRC)).json()

const out = []
for (const e of raw) {
  const series = Array.isArray(e.series) ? e.series : []
  if (!series.some(isVinylPopLine)) continue
  const rec = { t: e.title, img: e.imageName || '' }
  const fr = franchiseFromSeries(series); if (fr) rec.fr = fr
  const ex = exclusiveFromSeries(series); if (ex) rec.ex = ex
  if (series.some(s => /chase/i.test(s))) rec.ch = 1
  out.push(rec)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(out))
console.log(`kept ${out.length} of ${raw.length} entries -> ${OUT}`)
