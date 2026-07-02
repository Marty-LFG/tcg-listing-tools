// lib/collectr-resolve.mjs — best-effort identity resolution + enrichment for
// Collectr import rows (owner decision: best-effort, PREFER LIVE).
//
//   raw rows:    set-name → set id (fuzzy, ported from the Pokémon builder's
//                resolveSet) → /cards/{set}/{num} → stock image + LIVE market
//                price (normalize.mapPrice — live beats Collectr's export, GR4).
//   graded rows: same lookup for the image; the VALUE comes from the
//                PriceCharting graded ladder (lib/pricecharting.mjs lookup() +
//                lib/inventory.mjs valueFromLadder — the exact rung-mapper the
//                /refresh-value route uses; Golden Rule 9, one mapper).
//
// NEVER throws into the caller and never blocks a row: any miss returns the row
// unchanged (Collectr's own data stands) + resolved:false + a warning (GR7).
// Vintage set names ("Base Set (Unlimited)", "Aquapolis") will often miss — expected.
// Server-side only: self-fetches the dev-server proxies (GR1/2, collector pattern).
import { lookupPath, imageFrom, mapPrice } from './normalize.mjs';
import { lookup as pcLookup } from './pricecharting.mjs';
import { valueFromLadder } from './inventory.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jfetch(url, { retry429 = true } = {}) {
  let r = await fetch(url);
  if (r.status === 429 && retry429) { await sleep(1500); r = await fetch(url); }
  return r;
}

// ---------------------------------------------------------------------------
// Set index (memoised per process — one /sets call per game per import at most).
// ---------------------------------------------------------------------------
const _setIndex = new Map();   // game -> { at, sets:[{id,name,code}] }
const SET_INDEX_TTL_MS = 6 * 3600 * 1000;

export async function loadSetIndex(base, game, { fresh = false } = {}) {
  const hit = _setIndex.get(game);
  if (!fresh && hit && Date.now() - hit.at < SET_INDEX_TTL_MS) return hit.sets;
  let sets = [];
  try {
    if (game === 'pokemon') {
      const r = await jfetch(`${base}/api/pkm/sets?pageSize=500`);
      if (r.ok) { const j = await r.json(); sets = (j.data || []).map((s) => ({ id: s.id, name: s.name || '', code: s.ptcgoCode || '', series: s.series || '' })); }
    } else if (game === 'lorcana') {
      const r = await jfetch(`${base}/api/lorcana/sets`);
      if (r.ok) { const j = await r.json(); sets = ((j && (j.results || j.data)) || []).map((s) => ({ id: String(s.code != null ? s.code : s.set_num != null ? s.set_num : s.id), name: s.name || '', code: String(s.code || '') })); }
    }
  } catch {}
  if (sets.length) _setIndex.set(game, { at: Date.now(), sets });
  return sets;
}

// Fuzzy set-name → set (port of pokemon-listing-builder resolveSet, plus a
// parenthetical-stripping retry for Collectr names like "Base Set (Unlimited)").
export function resolveSet(sets, typedName) {
  if (!Array.isArray(sets) || !sets.length) return null;
  const tries = [String(typedName == null ? '' : typedName).trim()];
  const stripped = tries[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped && stripped !== tries[0]) tries.push(stripped);
  // Collectr names era base sets "<Era> Base Set" where the API set is just "<Era>"
  // ("Sun & Moon Base Set" → "Sun & Moon", "Sword & Shield Base Set" → "Sword & Shield").
  const noBase = stripped.replace(/\s+base\s+set$/i, '').trim();
  if (noBase && noBase !== stripped) tries.push(noBase);
  for (const t of tries) {
    if (!t) continue;
    const low = t.toLowerCase();
    let hit = sets.find((s) => s.id.toLowerCase() === low || (s.code && s.code.toLowerCase() === low) || s.name.toLowerCase() === low);
    if (hit) return hit;
    const starts = sets.filter((s) => s.name.toLowerCase().startsWith(low));
    if (starts.length === 1) return starts[0];
    // Set name contained IN the query ("Sun & Moon Base Set" ⊃ "Sun & Moon", "Base"):
    // the LONGEST contained name is the most specific ('Sun & Moon' beats 'Base').
    const inQuery = sets.filter((s) => low.includes(s.name.toLowerCase()));
    if (inQuery.length) return inQuery.sort((a, b) => b.name.length - a.name.length)[0];
    // Query contained in a set name ("151" → "Scarlet & Violet 151"): shortest =
    // least-decorated candidate.
    const inName = sets.filter((s) => s.name.toLowerCase().includes(low));
    if (inName.length) return inName.sort((a, b) => a.name.length - b.name.length)[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// card_cache read/write (shared with the tracker collector — 24h TTL read so a
// stale cached price never becomes the market input; ?fresh=1 forces live).
// ---------------------------------------------------------------------------
function cacheGet(db, game, key, ttlHours = 24) {
  if (!db) return null;
  try {
    const r = db.prepare(`SELECT payload FROM card_cache WHERE game = ? AND identity_key = ? AND fetched_at >= datetime('now', ?)`)
      .get(game, key, `-${ttlHours} hours`);
    return r && r.payload ? JSON.parse(r.payload) : null;
  } catch { return null; }
}
function cachePut(db, game, key, source, json) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO card_cache (game, identity_key, fetched_at, http_status, source, payload)
                VALUES (?,?,datetime('now'),200,?,?)
                ON CONFLICT(game, identity_key) DO UPDATE SET
                  fetched_at = datetime('now'), http_status = 200, source = excluded.source, payload = excluded.payload`)
      .run(game, key, source, JSON.stringify(json));
  } catch {}
}

// First-significant-token overlap, both directions ('Metagross (Delta Species)' ⇄
// 'Metagross δ'; 'N (Supporter) (Full Art)' ⇄ 'N'). Cheap but kills wrong-set hits.
function namesOverlap(a, b) {
  const tok = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9&'\- ]+/g, ' ').trim().split(/\s+/)[0] || '';
  const ta = tok(a), tb = tok(b);
  if (!ta || !tb) return true;   // nothing to compare — don't block
  return ta === tb || String(a).toLowerCase().includes(tb) || String(b).toLowerCase().includes(ta);
}

function identityFor(game, setId, lookupNum) {
  if (!setId || !lookupNum) return null;
  if (game === 'pokemon') return setId + '-' + lookupNum;
  if (game === 'lorcana' || game === 'swu') return setId + '/' + lookupNum;
  if (game === 'mtg') return setId + '-' + lookupNum;
  if (game === 'riftbound') return setId.toUpperCase() + '-' + lookupNum;
  return null;
}

// ---------------------------------------------------------------------------
// enrichRow — mutates a COPY of the row; returns { row, warnings[] }.
// opts: { setIndex, db, fresh, pcToken, pcEnabled }
// ---------------------------------------------------------------------------
export async function enrichRow(base, importRow, opts = {}) {
  const row = { ...importRow };
  const warnings = [];
  const who = row.name + (row.number ? ' ' + row.number : '');
  if (!row.game) return { row, warnings };   // unsupported game — nothing to enrich

  try {
    // 1. set-name → set id → identity_key
    const set = resolveSet(opts.setIndex || [], row.set_name);
    if (!set) { warnings.push(who + ': set "' + row.set_name + '" not matched — kept Collectr data'); return { row, warnings }; }
    const identity = identityFor(row.game, set.id, row.lookup_num);
    if (!identity) { warnings.push(who + ': no usable card number — kept Collectr data'); return { row, warnings }; }

    // 2. fetch the card (card_cache first unless fresh)
    let card = opts.fresh ? null : cacheGet(opts.db, row.game, identity);
    if (!card) {
      const path = lookupPath(row.game, identity);
      if (!path) return { row, warnings };
      const r = await jfetch(base + path);
      if (!r.ok) { warnings.push(who + ': lookup ' + identity + ' http ' + r.status + ' — kept Collectr data'); return { row, warnings }; }
      try { card = await r.json(); } catch { warnings.push(who + ': bad card json'); return { row, warnings }; }
      cachePut(opts.db, row.game, identity, row.game === 'pokemon' ? 'pokemontcg' : 'lorcast', card);
    }

    // Guard against a WRONG fuzzy set match resolving to a different card: the
    // fetched card's name must overlap the row's name, else treat as unresolved
    // (a wrong identity would attach the wrong price/image — GR5-adjacent).
    const c = card && card.data && !Array.isArray(card.data) ? card.data : card;
    if (c && c.name && !namesOverlap(c.name, row.name)) {
      warnings.push(who + ': set "' + row.set_name + '" matched "' + set.name + '" but card #' + row.lookup_num + ' there is "' + c.name + '" — kept Collectr data');
      return { row, warnings };
    }

    row.identity_key = identity;
    row.set_id = set.id;
    if (c && c.set && c.set.name) row.set_name = c.set.name;      // canonical set name when resolved
    row.image = imageFrom(row.game, card) || row.image;
    row.resolved = true;

    if (row.graded) {
      // 3g. graded value via the PriceCharting ladder (USD cents), rung-mapped to
      // this slab's company+grade. Collectr market (if any) still outranks in pricing.
      try {
        const pc = await pcLookup({ name: row.name, number: row.lookup_num || row.number, setName: row.set_name, cardId: identity, token: opts.pcToken, enabled: opts.pcEnabled !== false });
        if (pc && pc.matched && pc.ladder) {
          const rung = valueFromLadder(pc.ladder, row.grading_company, row.grade);
          if (rung && rung.cents > 0 && !/raw anchor/i.test(rung.label || '')) {
            row.pc_value_usd = rung.cents / 100;   // float; pricing converts + rounds once
            row.pc_grade_label = rung.label;
          } else warnings.push(who + ': no PriceCharting rung for ' + row.grading_company + ' ' + row.grade);
        } else warnings.push(who + ': no PriceCharting match for graded value');
      } catch { warnings.push(who + ': PriceCharting lookup failed'); }
    } else {
      // 3. live market beats the Collectr export (GR4) — keep Collectr's figure for audit.
      const live = mapPrice(row.game, card, row.finish);
      if (live && live.market != null) {
        if (live.currency === 'USD') { row.market_usd = +live.market; row.market_aud = null; }
        else if (live.currency === 'AUD') { row.market_aud = +live.market; }
        else { row.market_usd = null; }   // EUR etc. — leave Collectr's value in place
        if (live.currency === 'USD' || live.currency === 'AUD') row.market_source = live.source || row.game;
      }
    }
  } catch (e) {
    warnings.push(who + ': enrich failed (' + String(e?.message || e) + ') — kept Collectr data');
  }
  return { row, warnings };
}
