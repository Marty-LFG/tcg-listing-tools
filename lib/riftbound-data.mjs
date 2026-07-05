// lib/riftbound-data.mjs — the ONE server-side source for baked Riftbound card
// resolution (the offline catalog in data/riftbound.json). Riftbound has no live
// keyless card API the server can rely on (Scrydex needs a key and is currently
// 401; riftscribe/dotgg cover images but not a stable lookup), so the bulk tool
// resolves Riftbound from the same baked catalog the single-card builder uses.
//
// GR9 MIRROR: the helpers below (normNum / mapRarity / variantOf / finishOf /
// rbDotgg / RUNE_ORDER / parseRune / buildRuneIndex / the (Alternate Art)/
// (Overnumbered) name-suffix detection) are VERBATIM ports of
// riftbound-listing-builder.html (embedLookup + runeFill). If you change the
// builder's resolution, change it here too.
//
// Pure/dual-target: no DOM, no fetch, no DB. Reads data/riftbound.json from disk
// once and memoises by mtime (the refresh timer rewrites that file; a stale
// cache would hide new cards — GR7-adjacent freshness).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(path.resolve(__dirname, '..'), 'data', 'riftbound.json');

// ---------------------------------------------------------------------------
// Baked catalog load (memoised by file mtime so a refresh is picked up live).
// ---------------------------------------------------------------------------
let _cache = null;   // { mtimeMs, data }
export function loadRiftboundData(dataPath = DATA_PATH) {
  try {
    const st = fs.statSync(dataPath);
    if (_cache && _cache.mtimeMs === st.mtimeMs && _cache.path === dataPath) return _cache.data;
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    _cache = { mtimeMs: st.mtimeMs, path: dataPath, data };
    return data;
  } catch { return {}; }
}

// Set list for the picker / Collectr set-name resolver.
//   id   = lowercase catalog key ('ogn'); .toUpperCase() is the identity/image code.
//   code = uppercase 3-letter code ('OGN'); name = display name.
export function loadRiftboundSets(dataPath = DATA_PATH) {
  const data = loadRiftboundData(dataPath);
  return Object.keys(data).map((k) => ({ id: k, name: data[k].name || k.toUpperCase(), code: (data[k].code || k).toUpperCase() }));
}

// ---------------------------------------------------------------------------
// Helpers — verbatim ports of riftbound-listing-builder.html.
// ---------------------------------------------------------------------------
export function normNum(s) {
  s = String(s == null ? '' : s).split('/')[0].trim().toLowerCase();
  const m = s.match(/^0*(\d+)([a-z*]*)$/);
  return m ? m[1] + m[2] : s;
}
export function mapRarity(r) { return r === 'Alternate Art' ? 'Showcase' : (r || ''); }
export function variantOf(r) { if (r === 'Alternate Art') return 'Alternate Art'; if (r === 'Overnumbered') return 'Overnumbered'; return ''; }
export function finishOf(r) { return ['Epic', 'Alternate Art', 'Overnumbered'].includes(r) ? 'Foil' : 'Non-foil'; }
export function domainDisp(d) { return (d || '').split(';').join(' / '); }
export function championTag(name) { const p = (name || '').split(' - '); return p.length > 1 ? p[0] : ''; }

// dotgg image URL for any Riftbound card: {SET}-{NNN}{suffix}.webp (3-digit padded).
export function rbDotgg(setCode, numStr) {
  const head = String(numStr || '').split('/')[0].trim();
  const m = head.match(/^0*(\d+)([a-z*]?)$/i);
  const code = (setCode || '').toUpperCase() + '-' + (m ? String(m[1]).padStart(3, '0') + (m[2] || '').toLowerCase() : head);
  return head ? 'https://static.dotgg.gg/riftbound/cards/' + code + '.webp' : '';
}

// ---- runes: reprinted in every set with an R## number (Spiritforged onward), but
// only Origins' runes are catalogued (gallery/riftscribe carry no reprints). Resolve
// R01..R06 -> domain, reuse the canonical OGN rune data, and take the per-set art
// from dotgg ({SET}-R##[a]); OGN uses its printed NNN[a] art (r.img). Mirror of the
// builder's parseRune/buildRuneIndex/runeFill.
export const RUNE_ORDER = ['Fury', 'Calm', 'Mind', 'Body', 'Chaos', 'Order'];
export function parseRune(raw) {
  const m = String(raw || '').trim().match(/^[rR]0*(\d+)([a-z*]?)/);
  if (!m) return null;
  const idx = parseInt(m[1], 10), dom = RUNE_ORDER[idx - 1];
  if (!dom) return null;
  return { idx, dom, variant: (m[2] || '').toLowerCase(), num: 'R' + String(idx).padStart(2, '0') + (m[2] || '').toLowerCase() };
}
function buildRuneIndex(data) {
  const byDomain = {};
  for (const sid in data) {
    const s = data[sid]; if (!s || !s.cards) continue;
    for (const c of s.cards) {
      if (!/rune/i.test(c.type || '')) continue;
      const dom = (c.domain || '').split(';')[0].trim(); if (!dom) continue;
      const slot = byDomain[dom] || (byDomain[dom] = {});
      slot[/\(alternate art\)/i.test(c.name || '') ? 'alt' : 'base'] = c;
    }
  }
  return byDomain;
}

// ---------------------------------------------------------------------------
// cardToCanonical — a baked card object + its set meta -> the canonical fields the
// bulk pipeline consumes. Mirrors embedLookup's field derivation (name-suffix rarity
// detection -> mapRarity/variantOf/finishOf; dotgg image with baked img fallback).
// ---------------------------------------------------------------------------
function cardToCanonical(c, setMeta) {
  const code = (setMeta.code || setMeta.id || '').toUpperCase();
  const name = c.name || '';
  let rawRarity = c.rarity || '';
  if (/\(Alternate Art\)/i.test(name)) rawRarity = 'Alternate Art';
  else if (/\(Overnumbered\)/i.test(name)) rawRarity = 'Overnumbered';
  const cleanName = name.replace(/\s*\((Alternate Art|Overnumbered)\)\s*$/i, '');
  const isUnit = /unit/i.test(c.type || '');
  return {
    name: cleanName,
    number: c.num,                                   // printed number, verbatim (GR5)
    rarity: mapRarity(rawRarity),                    // 'Showcase' for alt-art/overnumbered
    variant: variantOf(rawRarity),                   // 'Alternate Art' | 'Overnumbered' | ''
    finish: finishOf(rawRarity),                     // 'Foil' | 'Non-foil'
    type: c.type || '',
    domain: domainDisp(c.domain),
    tags: championTag(name),
    e: isUnit && c.e != null ? String(c.e) : '',
    p: isUnit && c.p != null ? String(c.p) : '',
    m: isUnit && c.m != null ? String(c.m) : '',
    image: rbDotgg(code, c.num) || c.img || '',
    image_fallback: c.img || '',
  };
}

// Rune (R##[a]) -> canonical fields, using OGN canonical data + per-set dotgg art.
function runeToCanonical(pr, setMeta, data) {
  const slot = buildRuneIndex(data)[pr.dom] || {};
  const r = (pr.variant === 'a' ? slot.alt : slot.base) || slot.base || slot.alt;
  if (!r) return null;
  const code = (setMeta.code || setMeta.id || '').toUpperCase();
  const rawRarity = pr.variant === 'a' ? 'Alternate Art' : (r.rarity || 'Common');
  const name = (r.name || (pr.dom + ' Rune')).replace(/\s*\((Alternate Art|Overnumbered)\)\s*$/i, '');
  // Origins has no OGN-R## on dotgg (it uses the printed NNN[a]); the baked OGN image
  // is correct there. Reprint sets: the per-set dotgg art is correct; OGN's image is
  // the wrong printing, so keep it only as an error fallback (mirror of runeFill).
  const dg = 'https://static.dotgg.gg/riftbound/cards/' + code + '-' + pr.num + '.webp';
  const primary = code === 'OGN' ? (r.img || dg) : dg;
  return {
    name, number: pr.num, rarity: mapRarity(rawRarity), variant: variantOf(rawRarity),
    finish: finishOf(rawRarity), type: r.type || 'Rune', domain: domainDisp(r.domain || pr.dom),
    tags: '', e: '', p: '', m: '', image: primary, image_fallback: r.img || '',
  };
}

// ---------------------------------------------------------------------------
// resolveRiftboundCard(setId, lookupNum) -> canonical fields | null.
// setId: catalog key ('ogn') or code ('OGN'). lookupNum: printed/typed number —
// plain (162), alt-art (162a), overnumbered (299*), or rune (R01 / R01a).
// ---------------------------------------------------------------------------
export function resolveRiftboundCard(setId, lookupNum, dataPath = DATA_PATH) {
  const data = loadRiftboundData(dataPath);
  const key = String(setId || '').toLowerCase();
  const set = data[key] || data[Object.keys(data).find((k) => (data[k].code || '').toLowerCase() === key)] || null;
  if (!set) return null;
  const setMeta = { id: key, code: (set.code || key).toUpperCase(), name: set.name || key };
  const raw = String(lookupNum == null ? '' : lookupNum).trim();
  if (/^r\d/i.test(raw)) {                            // rune reprint (R##[a]) — resolve from OGN + per-set art
    const pr = parseRune(raw);
    if (pr) { const out = runeToCanonical(pr, setMeta, data); if (out) return out; }
  }
  const c = (set.cards || []).find((x) => x.k === normNum(raw));
  return c ? cardToCanonical(c, setMeta) : null;
}

// Iterate a whole set's cards as canonical fields (for the enumerator). Yields one
// entry per baked card (Riftbound baked data is single-printing).
export function* iterateRiftboundSet(setId, dataPath = DATA_PATH) {
  const data = loadRiftboundData(dataPath);
  const key = String(setId || '').toLowerCase();
  const set = data[key] || data[Object.keys(data).find((k) => (data[k].code || '').toLowerCase() === key)] || null;
  if (!set) return;
  const setMeta = { id: key, code: (set.code || key).toUpperCase(), name: set.name || key };
  for (const c of (set.cards || [])) yield { card: c, canonical: cardToCanonical(c, setMeta), setMeta };
}
