// lib/enumerate.mjs — Workflow A: turn a whole SET into listable rows, one per
// (card × printing). The printing matrix comes from each card's price-key set:
// Pokémon tcgplayer.prices keys (normal / reverseHolofoil / holofoil / 1stEdition…),
// Lorcana usd vs usd_foil (Enchanted = foil-only). Golden Rule 5: printings are
// never collapsed — each yields its own row with a distinct variant token.
//
// ENUMERATORS[game] is an adapter table beside normalize.mjs's MAPPERS — adding
// MTG/SWU/Riftbound later is one entry each. Async generators: the bulk plugin
// streams rows as NDJSON while pages are still fetching. Golden Rule 7: every
// failure yields a {warning} record and partial rows, never a throw/500.
import { imageFrom } from './normalize.mjs';
import { PRINTING_TO_FINISH, PRINTING_TO_EDITION, variantToken, formatCardNumber } from './listing-copy.mjs';
import { loadRiftboundSets, iterateRiftboundSet } from './riftbound-data.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 429-aware fetch (same shape as lib/collector.mjs jfetch).
async function jfetch(url, { retry429 = true } = {}) {
  let r = await fetch(url);
  if (r.status === 429 && retry429) { await sleep(1500); r = await fetch(url); }
  return r;
}

// Rarity → filter class. 'uncommon' must be tested before 'common' (substring).
export function rarityFilterClass(rarity) {
  const r = (rarity || '').toLowerCase();
  if (/uncommon/.test(r)) return 'uncommon';
  if (/common/.test(r)) return 'common';
  return 'rare_plus';
}
function wantRarity(rarity, filters) {
  const list = filters && Array.isArray(filters.rarities) && filters.rarities.length ? filters.rarities : null;
  return !list || list.includes(rarityFilterClass(rarity));
}

// "Super_rare" -> "Super Rare" (mirror of lorcana-listing-builder prettyRarity).
function prettyRarity(r) { return (r || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()); }

export const ENUMERATORS = {
  // Pokémon: paged search — ~1-2 requests per set at pageSize=250.
  async *pokemon({ base, setId, setName, filters }) {
    let page = 1, seen = 0;
    for (;;) {
      let r, j;
      try {
        r = await jfetch(`${base}/api/pkm/cards?q=${encodeURIComponent('set.id:' + setId)}&pageSize=250&page=${page}&orderBy=number`);
      } catch (e) { yield { warning: `pokemon set ${setId} page ${page}: ${e?.message || e}` }; return; }
      if (!r.ok) { yield { warning: `pokemon set ${setId} page ${page}: http ${r.status}` }; return; }
      try { j = await r.json(); } catch { yield { warning: `pokemon set ${setId} page ${page}: bad json` }; return; }
      const cards = j.data || [];
      for (const c of cards) {
        seen++;
        if (!wantRarity(c.rarity, filters)) continue;
        // Card-exact printed collector number — era/promo/subset aware (Golden Rule 10).
        // '039a' alt-art suffixes stay verbatim (GR5).
        const number = formatCardNumber(c.number, c.set || {}, { rarity: c.rarity });
        const tp = (c.tcgplayer && c.tcgplayer.prices) || null;
        // Printing matrix from the price keys; no price object → one row from the
        // rarity heuristic (still listable, market null — GR7).
        let keys = tp ? Object.keys(tp) : [];
        if (!keys.length) keys = [/holo/i.test(c.rarity || '') ? 'holofoil' : 'normal'];
        for (const k of keys) {
          const finish = PRINTING_TO_FINISH[k] || k;
          const edition = PRINTING_TO_EDITION[k] || null;
          const bucket = tp ? tp[k] : null;
          const market = bucket ? (bucket.market != null ? bucket.market : bucket.mid) : null;
          yield { row: {
            source: 'enumerate', game: 'pokemon', identity_key: c.id,
            name: c.name, set_id: setId, set_name: (c.set && c.set.name) || setName || '',
            number, rarity: c.rarity || '', finish, edition,
            variant: variantToken(edition, finish), printing_key: k, language: 'EN',
            image: imageFrom('pokemon', c),
            market_usd: market != null ? +market : null, market_aud: null,
            market_source: 'pokemontcg', raw_price: bucket || null,
            quantity: 1, graded: false,
          }, cachePayload: { game: 'pokemon', identity_key: c.id, source: 'pokemontcg', json: c } };
        }
      }
      const total = j.totalCount != null ? +j.totalCount : null;
      if (!cards.length || (total != null && page * 250 >= total)) return;
      page++;
      await sleep(300);   // politeness gap between pages (collector convention)
    }
  },

  // Lorcana: try the set's card list endpoint; fall back to iterating collector
  // numbers 1..N against the proven per-card path (lorcana-listing-builder doLookup).
  async *lorcana({ base, setId, setName, filters }) {
    let cards = null;
    try {
      const r = await jfetch(`${base}/api/lorcana/sets/${encodeURIComponent(setId)}/cards`);
      if (r.ok) { const j = await r.json(); cards = Array.isArray(j) ? j : (j.results || j.data || null); }
    } catch {}
    if (Array.isArray(cards) && cards.length) {
      for (const c of cards) yield* lorcanaCardRows(c, setId, setName, filters);
      return;
    }
    // Fallback: per-card walk. Find the set's total if we can; else walk until misses.
    let total = null;
    try {
      const r = await jfetch(`${base}/api/lorcana/sets/${encodeURIComponent(setId)}`);
      if (r.ok) { const j = await r.json(); const s = j && (j.data || j); total = s && (s.total_cards || s.card_count || s.total) || null; }
    } catch {}
    yield { warning: `lorcana set ${setId}: no bulk card list — iterating ${total ? total + ' numbers' : 'until misses'}` };
    let misses = 0;
    for (let n = 1; total ? n <= +total : misses < 5; n++) {
      let r;
      try { r = await jfetch(`${base}/api/lorcana/cards/${encodeURIComponent(setId)}/${n}`); }
      catch { misses++; continue; }
      if (!r.ok) { misses++; if (!total && misses >= 5) break; continue; }
      misses = 0;
      let c; try { c = await r.json(); } catch { continue; }
      c = c && (c.data || c);
      yield* lorcanaCardRows(c, setId, setName, filters);
      await sleep(150);
    }
  },

  // Riftbound: no live keyless card API to page — enumerate the baked catalog
  // (data/riftbound.json) directly. Single-printing per card; runes/alt-arts/
  // overnumbered are their own baked entries and fall out as their own rows.
  async *riftbound({ setId, setName, filters }) {
    for (const { card, canonical, setMeta } of iterateRiftboundSet(setId)) {
      if (!wantRarity(canonical.rarity, filters)) continue;
      const finish = canonical.finish === 'Foil' ? 'Foil' : 'Normal';
      yield { row: {
        source: 'enumerate', game: 'riftbound', identity_key: setMeta.code + '-' + card.k,
        name: canonical.name, set_id: setMeta.id, set_name: (setMeta.name || setName || '') + ' (' + setMeta.code + ')',
        number: canonical.number, rarity: canonical.rarity, finish, edition: null,
        variant: canonical.variant, printing_key: finish === 'Foil' ? 'foil' : 'normal', language: 'EN',
        image: canonical.image,
        market_usd: null, market_aud: null, market_source: null,
        quantity: 1, graded: false,
        // riftbound card facts for the description (carried on the row; re-resolved on export).
        rb_type: canonical.type, rb_domain: canonical.domain, rb_tags: canonical.tags,
        rb_e: canonical.e, rb_p: canonical.p, rb_m: canonical.m,
      } };
    }
  },
};

function* lorcanaCardRows(c, setId, setName, filters) {
  if (!c || !c.collector_number) return;
  if (!wantRarity(c.rarity, filters)) return;
  const name = c.name + (c.version ? ' - ' + c.version : '');   // builder's name shape
  const num = String(c.collector_number);
  const rarity = prettyRarity(c.rarity);
  const p = c.prices || {};
  const enchanted = /enchanted/i.test(c.rarity || '');
  const image = imageFrom('lorcana', c);
  const common = {
    source: 'enumerate', game: 'lorcana', identity_key: setId + '/' + num,
    name, set_id: setId, set_name: (c.set && c.set.name) || setName || '',
    number: num, rarity, language: 'EN', image,
    market_aud: null, market_source: 'lorcast', quantity: 1, graded: false,
  };
  const rows = [];
  // Foil-only printings (Enchanted etc.) → one Foil/Enchanted row; otherwise one
  // row per priced key; nothing priced → one Base row (manual pricing, GR7).
  if (p.usd != null && !enchanted) rows.push({ finish: 'Normal', key: 'usd', market: p.usd });
  if (p.usd_foil != null) rows.push({ finish: enchanted ? 'Enchanted' : 'Foil', key: 'usd_foil', market: p.usd_foil });
  if (!rows.length) rows.push({ finish: enchanted ? 'Enchanted' : 'Normal', key: enchanted ? 'usd_foil' : 'usd', market: null });
  for (const v of rows) {
    yield { row: {
      ...common, finish: v.finish, edition: null,
      variant: variantToken(null, v.finish), printing_key: v.key,
      market_usd: v.market != null ? +v.market : null, raw_price: p || null,
    }, cachePayload: { game: 'lorcana', identity_key: common.identity_key, source: 'lorcast', json: c } };
  }
}

// Set lists for the picker (GET /api/bulk/sets).
export async function listSets(base, game) {
  if (game === 'pokemon') {
    const r = await jfetch(`${base}/api/pkm/sets?pageSize=500`);
    if (!r.ok) throw new Error('pokemon sets http ' + r.status);
    const j = await r.json();
    return (j.data || [])
      .map((s) => ({ value: s.id, label: s.name, code: s.ptcgoCode || '', icon: (s.images && s.images.symbol) || '', releaseDate: s.releaseDate || '', total: s.printedTotal || s.total || null }))
      .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  }
  if (game === 'lorcana') {
    const r = await jfetch(`${base}/api/lorcana/sets`);
    if (!r.ok) throw new Error('lorcana sets http ' + r.status);
    const j = await r.json();
    const sets = (j && (j.results || j.data)) || [];
    return sets.map((s) => ({ value: String(s.code != null ? s.code : s.set_num != null ? s.set_num : s.id), label: s.name, code: String(s.code || ''), total: s.total_cards || s.card_count || null }));
  }
  if (game === 'riftbound') {
    // Baked catalog — no network. value = catalog key ('ogn'); the enumerator/collectr resolver key off it.
    return loadRiftboundSets().map((s) => ({ value: s.id, label: s.name, code: s.code }));
  }
  throw new Error('enumeration not yet supported for ' + game);
}
