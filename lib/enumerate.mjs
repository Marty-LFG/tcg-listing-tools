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
import { PRINTING_TO_FINISH, PRINTING_TO_EDITION, variantToken, formatCardNumber,
  langCode, mtgColourName, mtgTreatmentOf, mtgPromoNote, mtgLanguageName } from './listing-copy.mjs';
import { loadRiftboundSets, iterateRiftboundSet } from './riftbound-data.mjs';
import { getSetCards } from './pkm-cards-cache.mjs';
import { getSetCards as getLorcanaSetCards } from './lorcana-cards-cache.mjs';
import { getSetCards as getMtgSetCards } from './mtg-cards-cache.mjs';
import { listMtgSets } from './mtg-sets-cache.mjs';
import { mtgPrintingsFor, lorcanaPrintingsFor } from './runner-core.mjs';

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
  // Pokémon: the whole set from lib/pkm-cards-cache.mjs, which fetches it once and keeps it. This
  // used to page pokemontcg.io itself on every enumeration — the same live-fetch-every-time the
  // batch runner had, and worse here, because enumerating a shelf's worth of sets did it per set.
  // Nothing about the rows below changed: the cache stores the RAW upstream card.
  async *pokemon({ env, setId, setName, filters }) {
    let seen = 0;
    let cards = null;
    try {
      const got = await getSetCards(env, setId);
      cards = got.cards;
      if (got.stale) yield { warning: `pokemon set ${setId}: pokemontcg.io is down — enumerated from the stored copy taken ${got.at}` };
      else if (got.partial) yield { warning: `pokemon set ${setId}: pokemontcg.io returned only part of the set` };
    } catch (e) { yield { warning: `pokemon set ${setId}: ${e?.message || e}` }; return; }
    if (!cards || !cards.length) { yield { warning: `pokemon set ${setId}: no cards available (upstream down and nothing cached)` }; return; }
    {
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
    }
  },

  // Lorcana: the set's card list from lib/lorcana-cards-cache.mjs, which fetches it once and keeps
  // it. This used to ask Lorcast for the list on every enumeration, and the fallback below — a walk
  // of the collector numbers, one request each — is a set's worth of requests when that list comes
  // back empty. Cached, the second enumeration of a set costs nothing and the fallback stays unused.
  async *lorcana({ base, setId, setName, filters }) {
    let cards = null;
    try {
      const got = await getLorcanaSetCards(setId);
      cards = got.cards;
      if (got.stale) yield { warning: `lorcana set ${setId}: Lorcast is down — enumerated from the stored copy taken ${got.at}` };
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

  // Magic: the set's printings from lib/mtg-cards-cache.mjs, which fetches them once and keeps
  // them. The printing matrix is mtgPrintingsFor — `finishes[]`, NOT the price keys, because
  // Scryfall's `prices` object always carries all three fields (mostly null) and `usd` already
  // means "Normal" for Lorcana in PRINTING_TO_FINISH.
  //
  // The collector number goes through VERBATIM (GR10): Magic prints '1', and formatCardNumber would
  // make it '001/531' — a number that is not on the card.
  async *mtg({ setId, setName, filters }) {
    let cards = null, at = null;
    try {
      const got = await getMtgSetCards(setId);
      cards = got.cards; at = got.at;
      if (got.stale) yield { warning: `mtg set ${setId}: Scryfall is down — enumerated from the stored copy taken ${at}` };
      else if (got.partial) yield { warning: `mtg set ${setId}: Scryfall returned only part of the set` };
    } catch (e) { yield { warning: `mtg set ${setId}: ${e?.message || e}` }; return; }
    if (!cards || !cards.length) { yield { warning: `mtg set ${setId}: no cards available (Scryfall down and nothing cached)` }; return; }
    const code = String(setId).toUpperCase();
    for (const c of cards) {
      if (!wantRarity(c.rarity, filters)) continue;
      const printings = mtgPrintingsFor(c);
      // Scryfall always populates `finishes`; a record without one is malformed, and a plain card is
      // the under-promising answer. Never a rarity guess — Magic's rarity says nothing about foiling.
      const list = printings.length ? printings : [{ key: 'nonfoil', finish: 'Nonfoil', variant: 'Base', marketUsd: null }];
      for (const p of list) {
        yield { row: {
          source: 'enumerate', game: 'mtg', identity_key: (String(c.set || setId) + '-' + c.collector_number).toLowerCase(),
          name: c.name, set_id: setId,
          // The "(CODE)" suffix is load-bearing: titleParts' mtg branch reads the code out of these
          // parens for the abbreviated title, and stripSetCodeSuffix removes it for the eBay facet.
          set_name: (c.set_name || setName || '') + ' (' + code + ')',
          number: String(c.collector_number == null ? '' : c.collector_number),
          rarity: prettyRarity(c.rarity || ''), finish: p.finish, edition: null,
          variant: p.variant, printing_key: p.key,
          // Off the PRINT: a whole-set fetch carries Dwarvish, Japanese and Phyrexian printings.
          language: langCode(mtgLanguageName(c.lang || 'en')),
          image: imageFrom('mtg', c),
          // null for a surge foil, on purpose — Scryfall reports the plain-foil figure there.
          market_usd: p.marketUsd, market_aud: null,
          market_source: p.marketUsd != null ? 'scryfall' : null,
          quantity: 1, graded: false,
          // The facts the description table and the derived aspects need after a DB round-trip.
          // Same names lib/channels/ebay-map.mjs buildRowIn falls back to reading.
          colour: mtgColourName(c.colors || (c.card_faces && c.card_faces[0] && c.card_faces[0].colors) || []),
          card_type: c.type_line || '', treatment: mtgTreatmentOf(c), promo_note: mtgPromoNote(c),
          illustrator: c.artist || '', set_code: code, set_release_date: c.released_at || '',
          full_art: !!c.full_art, promo: !!c.promo,
        }, cachePayload: { game: 'mtg', identity_key: (String(c.set || setId) + '-' + c.collector_number).toLowerCase(), source: 'scryfall', json: c } };
      }
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
  const image = imageFrom('lorcana', c);
  const common = {
    source: 'enumerate', game: 'lorcana', identity_key: setId + '/' + num,
    name, set_id: setId, set_name: (c.set && c.set.name) || setName || '',
    number: num, rarity, language: 'EN', image,
    market_aud: null, market_source: 'lorcast', quantity: 1, graded: false,
  };
  // The printing matrix now comes from lorcanaPrintingsFor (lib/runner-core.mjs), the SAME function
  // the batch runner reads. This used to be a private ladder here that only knew about Enchanted,
  // so an Epic or an Iconic — foil-only rarities worth up to US$3,632 — enumerated as an ordinary
  // 'Foil' and collided with nothing to distinguish it (GR5). Two ladders, already drifted.
  for (const v of lorcanaPrintingsFor(c)) {
    yield { row: {
      ...common, finish: v.finish, edition: null,
      variant: v.variant, printing_key: v.key,
      market_usd: v.marketUsd, raw_price: p || null,
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
  if (game === 'mtg') {
    // From the stored Scryfall set list (paper only — digital sets are not stock). value = the set
    // CODE, which is what /api/mtg/set/:id/cards and identity_key are both keyed on.
    return listMtgSets().map((s) => ({ value: s.id, label: s.name, code: String(s.code || '').toUpperCase() }));
  }
  throw new Error('enumeration not yet supported for ' + game);
}
