// lib/arbitrage.mjs — the eBay AU → local-buyer arbitrage finder, server side. Mounted at /api/arb
// (a fresh prefix: Vite matches middleware with startsWith, and nothing else starts with it).
//
// WHAT IT DOES. A local buyer pays 80% of the TCGplayer market price for Near Mint raw Pokémon cards
// of the matched printing. This module, for each card the operator names, runs ONE eBay Browse call
// (fixed price, AU-located, raw), keeps every listing that is plausibly that card in that condition
// (lib/arb-core.mjs decides), prices it landed — item + postage + the buyer-protection fee — and
// stores the ones the buyer's price beats by the configured floors as hits.
//
// WHAT IT NEVER DOES. It never buys anything, never writes a listing, never touches inventory. Its
// only side effects are its own tables (lib/db.mjs migrateArbitrage), one counter of eBay calls, and
// an optional Telegram card per NEW hit from a scheduled pass.
//
// THE BUDGET IS THE DESIGN CONSTRAINT. The Browse app token is ~5,000 calls a day for the whole app,
// and this tool is one call per card per scan. So calls are counted per UTC day in SQLite, attempts
// not successes, a scan is refused up front when it would overrun the day's share, and a 429 burns
// the rest of the day so the scheduler stops trying. AGENTS.md §9 asks for exactly this.
//
// Never throws out of a route (GR7): every failure is a JSON body, and once a scan is streaming every
// later failure is a {card}/{summary} record rather than an HTTP status.
import fs from 'node:fs';
import { openDb } from './db.mjs';
import { readJsonBody } from './req-body.mjs';
import { ndjsonStart } from './ndjson.mjs';
import { configFile } from './config-paths.mjs';
import { getSetCards, isSetId } from './pkm-cards-cache.mjs';
import { findSet, readCache as readSetsCache } from './pkm-sets-cache.mjs';
import { refreshIfPricesAreStale } from './set-cache.mjs';
import { parseCatch } from './runner-core.mjs';
import { sendMessage, telegramEnabled, telegramChatConfigured } from './telegram.mjs';
import { renderArbHit } from './telegram-cards.mjs';
import { loadArbConfig, ensureArbConfigSeeded } from './arb-config.mjs';
import {
  buildScanQuery, numberMatcher, rowFromBrowse, filterListing, hitMaths, qualifies, warningsFor,
  marketAgeDays, alertable, rankHits, reconcileHits, canTransition, HIT_STATUSES, findCards,
  resolveCard, printingsWithSource, toCents, MULTI_RE, ARB_FILTER,
  buildSetIndex, matchTitleToCard, sweepQuery,
} from './arb-core.mjs';
import { browseSearchUrl } from './ebay-links.mjs';
import { CATEGORY } from './ebay-vocab.mjs';

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

// The seller username to exclude, so we never "find" our own listing. The config's own key wins;
// otherwise the same source the comps engine uses (repricer.config.json, lib/listings.mjs
// ownSeller), then the env var the testbed reads. One answer, three places it could be written.
function ownSeller(env, cfg) {
  if (cfg && cfg.exclude_seller_username) return String(cfg.exclude_seller_username).trim() || null;
  try { const v = JSON.parse(fs.readFileSync(configFile('repricer.config.json'), 'utf8')).exclude_seller_username; if (v) return String(v).trim(); } catch { /* absent */ }
  return (env && env.EBAY_SELLER_USERNAME && String(env.EBAY_SELLER_USERNAME).trim()) || null;
}

// One Frankfurter rate per scan, with its fixing date, so every hit can say which rate joined its two
// currencies. Same endpoint lib/repricer-scan.mjs fxUsdToAud reads; this one keeps the date. Null on
// any failure — the scan then refuses rather than guessing a rate (GR4).
async function loadFx(base) {
  try {
    const r = await fetch(String(base || '').replace(/\/$/, '') + '/api/fx/latest?from=USD&to=AUD');
    if (!r.ok) return null;
    const j = await r.json();
    const rate = j && j.rates && (j.rates.AUD ?? j.rates.aud);
    return rate > 0 ? { rate, date: j.date || null } : null;
  } catch { return null; }
}

// One Browse call through our own proxy (token minting + the AU marketplace and postcode headers live
// there). Returns a shape, never throws — same as lib/ebay-testbed.mjs browse().
async function browse(base, path, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base + path, { signal: ac.signal });
    let json = null;
    try { json = await r.json(); } catch { /* non-json upstream */ }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Budget — eBay calls per UTC day
// ---------------------------------------------------------------------------

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function budgetState(db, cfg) {
  const day = utcDay();
  const row = db.prepare('SELECT calls FROM arb_budget WHERE day = ?').get(day);
  const used = row ? row.calls : 0;
  const cap = cfg.daily_call_budget;
  return { day, used, cap, remaining: Math.max(0, cap - used) };
}

// Reserve one call. False when the day is spent — checked BEFORE incrementing, so the counter never
// records an attempt that was refused.
export function reserveCall(db, cfg, n = 1) {
  const day = utcDay();
  const st = budgetState(db, cfg);
  if (st.used + n > st.cap) return false;
  db.prepare(`INSERT INTO arb_budget(day, calls, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls, updated_at = excluded.updated_at`).run(day, n, nowIso());
  return true;
}

// A 429 means eBay has already said no for the day. Spend the rest of the budget so the up-front
// check refuses every later scan until UTC midnight, rather than each one discovering it again.
function burnBudget(db, cfg) {
  const day = utcDay();
  db.prepare(`INSERT INTO arb_budget(day, calls, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(day) DO UPDATE SET calls = MAX(calls, excluded.calls), updated_at = excluded.updated_at`).run(day, cfg.daily_call_budget, nowIso());
}

// ---------------------------------------------------------------------------
// Cards — resolving what the operator typed against the catalogue
// ---------------------------------------------------------------------------

// A set's cards from the same cache the batch runner reads (lib/pkm-cards-cache.mjs). The route's
// own price-age refresh is repeated here: a month-old market figure would quietly overstate or
// understate every hit, and the disk copy never expires on its own.
//
// `memo` is a per-request (resolve) or per-scan Map: getSetCards re-reads and re-parses the set's
// multi-megabyte JSON on every call, and a 300-card watch pass over one set would otherwise parse the
// same file 300 times and fire the staleness refresh 300 times.
async function setCards(env, setId, memo) {
  if (!isSetId(setId)) return { cards: null, reason: 'bad_set_id' };
  if (memo && memo.has(setId)) return memo.get(setId);
  const d = await getSetCards(env, setId);
  const out = (!d || !d.cards) ? { cards: null, reason: 'set_not_cached' } : { cards: d.cards, at: d.at };
  if (out.cards) refreshIfPricesAreStale(d.at, () => getSetCards(env, setId, { refresh: true }));
  if (memo) memo.set(setId, out);
  return out;
}

const setIdOfCard = (cardId) => { const i = String(cardId || '').lastIndexOf('-'); return i > 0 ? cardId.slice(0, i) : ''; };

// The flat card facts every later step needs, off a pokemontcg.io card. `set.ptcgoCode` is not in
// the cached card's `set` block, so it is joined from the sets cache.
function cardFacts(card) {
  const set = card.set || {};
  const meta = findSet({ id: set.id }) || {};
  return {
    card_id: card.id, set_id: set.id || setIdOfCard(card.id), set_name: set.name || meta.name || '',
    printed_total: set.printedTotal || meta.printedTotal || null, ptcgo_code: meta.ptcgoCode || set.ptcgoCode || null,
    number: String(card.number == null ? '' : card.number), name: card.name || '', rarity: card.rarity || '',
    image: (card.images && (card.images.small || card.images.large)) || null,
    market_at: (card.tcgplayer && card.tcgplayer.updatedAt) || null,
  };
}

// A watch row or a scan request names a card by id + printing; this turns that back into the card
// and its printing matrix. `no_market` is a real answer: the buyer pays on MARKET and a printing
// that only has a `low` cannot be scored (GR4).
async function loadScanCard(env, { card_id, printing_key }, memo) {
  const setId = setIdOfCard(card_id);
  const { cards, reason } = await setCards(env, setId, memo);
  if (!cards) return { error: reason || 'set_not_cached' };
  const card = cards.find((c) => c && c.id === card_id);
  if (!card) return { error: 'card_not_found' };
  const facts = cardFacts(card);
  const printings = printingsWithSource(card).map((p) => ({ ...p, marketUsd: p.which === 'market' ? p.marketUsd : null }));
  const wanted = printings.find((p) => p.key === printing_key);
  if (!wanted) return { error: 'printing_not_found', facts, printings };
  if (!(wanted.marketUsd > 0)) return { error: 'no_market', facts, printings, wanted };
  return { card, facts, printings, wanted };
}

// POST /resolve — the catch lines, with no eBay call at all. Mirrors the batch runner's grammar
// (lib/runner-core.mjs parseCatch): `125 r`, `*charizard`, and a bare set code switches the set for
// the lines after it.
async function resolveLines(env, db, base, { setId, lines }) {
  const sets = readSetsCache();
  const codes = new Set(((sets && sets.body && sets.body.data) || []).map((s) => s.ptcgoCode).filter(Boolean).map((c) => c.toUpperCase()));
  const fx = await loadFx(base);
  const cfg = loadArbConfig();
  let current = String(setId || '').trim();
  const out = [], unknown = [], memo = new Map();
  const watching = new Set(db.prepare('SELECT card_id || \'|\' || printing_key AS k FROM arb_watch WHERE active = 1').all().map((r) => r.k));
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const parsed = parseCatch(line, { setCodes: codes });
    if (parsed.setCode) { const s = findSet({ code: parsed.setCode }); if (s && s.id) current = s.id; else unknown.push({ line, why: 'unknown set code ' + parsed.setCode }); }
    if (parsed.num == null && !parsed.nameQuery) { if (!parsed.setCode) unknown.push({ line, why: 'no card number or *name on this line' }); continue; }
    if (!current) { unknown.push({ line, why: 'no set chosen' }); continue; }
    const { cards, reason } = await setCards(env, current, memo);
    if (!cards) { unknown.push({ line, why: reason === 'bad_set_id' ? 'bad set id ' + current : 'set ' + current + ' is not cached and pokemontcg.io did not answer' }); continue; }
    const found = findCards(cards, parsed);
    if (!found.length) { unknown.push({ line, why: (parsed.nameQuery ? 'no card named like "' + parsed.nameQuery + '"' : 'no card numbered ' + parsed.num) + ' in ' + current }); continue; }
    for (const card of found) {
      const { printings, chosen } = resolveCard(card, parsed.printing);
      const facts = cardFacts(card);
      const marketUsd = chosen && chosen.which === 'market' ? chosen.marketUsd : null;
      out.push({
        line, ...facts,
        printings: printings.map((p) => ({ key: p.key, finish: p.finish, variant: p.variant, marketUsd: p.marketUsd, which: p.which })),
        chosen_key: chosen ? chosen.key : null,
        market_usd: marketUsd,
        market_which: chosen ? chosen.which : null,
        market_age_days: marketAgeDays(facts.market_at),
        buyer_aud: marketUsd != null && fx ? Math.round(marketUsd * fx.rate * cfg.buyer_pct * 100) / 100 : null,
        watching: !!(chosen && watching.has(card.id + '|' + chosen.key)),
        unknown_tokens: parsed.unknown,
      });
    }
  }
  return { cards: out, unknown, fx: fx ? { rate: fx.rate, date: fx.date } : null, set_id: current, buyer_pct: cfg.buyer_pct };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

// What one qualifying listing becomes in arb_hits. Cents in source currency (GR3), the fx that joined
// them on the row.
function hitRow({ facts, printing_key, row, f, h, fx, cfg, scanId, now }) {
  const warnings = warningsFor(h, {
    tooGoodRatio: cfg.too_good_ratio, coupon: row.coupon, condClass: f.cond.cls, condEvidence: f.cond.evidence,
    marketAgeDays: marketAgeDays(facts.market_at, Date.parse(now)), maxMarketAgeDays: cfg.max_market_age_days,
    printingAmbiguous: f.market.ambiguous, multi: MULTI_RE.test(row.title || ''), bestOffer: row.bestOffer,
  });
  return {
    game: 'pokemon', set_id: facts.set_id, card_id: facts.card_id, number: facts.number, name: facts.name,
    printing_key, scored_printing_key: f.market.key, printing_ambiguous: f.market.ambiguous ? 1 : 0,
    item_id: row.itemId, legacy_item_id: row.legacyItemId,
    price_cents: toCents(row.price), price_currency: row.currency || 'AUD', ship_cents: toCents(row.ship),
    fee_cents: h.feeCents, delivered_cents: h.deliveredCents,
    market_usd_cents: toCents(f.market.marketUsd), market_currency: 'USD', market_at: facts.market_at,
    fx_usd_aud: fx.rate, fx_date: fx.date, buyer_pct: cfg.buyer_pct, buyer_aud_cents: h.buyerAudCents,
    profit_cents: h.profitCents, margin_pct: h.marginPct, ratio: h.ratio,
    title: row.title, url: row.url, image: row.image,
    seller: row.seller, seller_fb_pct: row.sellerFbPct, seller_fb_score: row.sellerFbScore,
    cond: row.cond, cond_id: row.condId, cond_class: f.cond.cls, cond_evidence: f.cond.evidence, match_tier: f.tier,
    coupon: row.coupon ? 1 : 0, best_offer: row.bestOffer ? 1 : 0,
    warnings: JSON.stringify(warnings), listed_at: row.listedAt, last_scan_id: scanId,
    source: 'scan',
  };
}

const HIT_COLS = ['game', 'set_id', 'card_id', 'number', 'name', 'printing_key', 'scored_printing_key', 'printing_ambiguous', 'item_id', 'legacy_item_id',
  'price_cents', 'price_currency', 'ship_cents', 'fee_cents', 'delivered_cents', 'market_usd_cents', 'market_currency', 'market_at', 'fx_usd_aud', 'fx_date',
  'buyer_pct', 'buyer_aud_cents', 'profit_cents', 'margin_pct', 'ratio', 'title', 'url', 'image', 'seller', 'seller_fb_pct', 'seller_fb_score',
  'cond', 'cond_id', 'cond_class', 'cond_evidence', 'match_tier', 'coupon', 'best_offer', 'warnings', 'listed_at', 'last_scan_id', 'source'];

function applyReconcile(db, { inserts, updates, gone }, watchId) {
  const ins = db.prepare(`INSERT INTO arb_hits (${HIT_COLS.join(', ')}, watch_id, status, first_seen, last_seen)
                          VALUES (${HIT_COLS.map(() => '?').join(', ')}, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE arb_hits SET ${HIT_COLS.map((c) => c + ' = ?').join(', ')}, watch_id = COALESCE(?, watch_id),
                          status = ?, gone_reason = ?, last_seen = ? WHERE id = ?`);
  const gn = db.prepare('UPDATE arb_hits SET status = \'gone\', gone_reason = ?, last_scan_id = ?, last_seen = ? WHERE id = ?');
  const work = () => {
    for (const r of inserts) ins.run(...HIT_COLS.map((c) => r[c] ?? null), watchId ?? null, r.status, r.first_seen, r.last_seen);
    for (const u of updates) {
      const p = u.patch;
      const status = p.status || u.from;
      upd.run(...HIT_COLS.map((c) => p[c] ?? null), watchId ?? null, status, p.status === 'seen' && u.from === 'gone' ? null : (p.gone_reason ?? null), p.last_seen, u.id);
    }
    for (const g of gone) gn.run(g.reason, g.last_scan_id, g.last_seen, g.id);
  };
  // node:sqlite has no .transaction(); BEGIN/COMMIT by hand, the way lib/inventory.mjs does.
  db.exec('BEGIN'); try { work(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// The scan itself. `cards` is [{ card_id, printing_key, watch_id? }]. Emits the NDJSON vocabulary the
// page and the job ring buffer share: {start} → {card}* with {hit}* → {summary}. A card whose Browse
// call failed is reported and its stored hits left alone — nothing was observed, so nothing is "gone".
async function runScan(env, db, base, { cards, mode, emit, shouldCancel, scanId }) {
  const cfg = loadArbConfig();
  const t0 = nowIso();
  const totals = { cards: 0, calls: 0, rows: 0, hits_new: 0, hits_total: 0, errors: 0 };
  db.prepare('INSERT OR REPLACE INTO arb_scans (id, mode, started_at, cards) VALUES (?, ?, ?, ?)').run(scanId, mode, t0, cards.length);
  const finish = (aborted, cancelled) => {
    db.prepare('UPDATE arb_scans SET finished_at = ?, cards = ?, calls = ?, rows = ?, hits_new = ?, hits_total = ?, fx_usd_aud = ?, aborted = ?, cancelled = ? WHERE id = ?')
      .run(nowIso(), totals.cards, totals.calls, totals.rows, totals.hits_new, totals.hits_total, fx ? fx.rate : null, aborted || null, cancelled ? 1 : 0, scanId);
    emit({ summary: { ...totals, aborted: aborted || null, cancelled: !!cancelled, budget: budgetState(db, cfg) } });
  };

  const fx = await loadFx(base);
  if (!fx) { emit({ start: { scan_id: scanId, total: cards.length, budget: budgetState(db, cfg) } }); return finish('fx_unavailable'); }
  emit({ start: { scan_id: scanId, total: cards.length, fx, budget: budgetState(db, cfg), buyer_pct: cfg.buyer_pct, fee_mode: cfg.buyer_fee_mode } });
  const excludeSeller = ownSeller(env, cfg);
  const memo = new Map();

  for (const want of cards) {
    if (shouldCancel && shouldCancel()) return finish(null, true);
    const now = nowIso();
    const loaded = await loadScanCard(env, want, memo);
    if (loaded.error) {
      totals.errors++;
      emit({ card: { card_id: want.card_id, printing_key: want.printing_key, error: loaded.error, name: loaded.facts && loaded.facts.name } });
      continue;
    }
    const { facts, printings, wanted } = loaded;
    const q = buildScanQuery({ ...facts, set: { id: facts.set_id, name: facts.set_name, printedTotal: facts.printed_total, ptcgoCode: facts.ptcgo_code } }, { queryMode: cfg.query_mode, limit: cfg.browse_limit });
    if (!reserveCall(db, cfg)) return finish('budget_exhausted');
    totals.calls++;
    const r = await browse(base, q.path);
    if (r.status === 429) { burnBudget(db, cfg); return finish('rate_limited'); }
    if (r.status === 503) return finish('ebay_unconfigured');
    if (r.status !== 200 || !r.json) {
      totals.errors++;
      emit({ card: { ...facts, printing_key: wanted.key, error: r.status ? 'ebay_http_' + r.status : 'ebay_unreachable', detail: r.error || (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || null, query: q.q } });
      await sleep(cfg.call_gap_ms);
      continue;
    }
    totals.cards++;
    const rows = (r.json.itemSummaries || []).map(rowFromBrowse).filter(Boolean);
    totals.rows += rows.length;
    const matcher = numberMatcher({ number: facts.number, set: { id: facts.set_id, name: facts.set_name, printedTotal: facts.printed_total, ptcgoCode: facts.ptcgo_code } });
    const ctx = { matcher, printings, wantedKey: wanted.key, excludeSeller, sellerMinPct: cfg.seller_min_feedback_pct, sellerMinScore: cfg.seller_min_feedback_score };
    const dropped = {};
    const current = [];
    let kept = 0, below = 0, best = null;
    for (const row of rows) {
      const f = filterListing(row, ctx);
      if (!f.ok) { dropped[f.reason] = (dropped[f.reason] || 0) + 1; continue; }
      if (!(f.market && f.market.marketUsd > 0)) { dropped.no_market = (dropped.no_market || 0) + 1; continue; }
      kept++;
      const h = hitMaths({ priceCents: toCents(row.price), shipCents: toCents(row.ship), marketUsdCents: toCents(f.market.marketUsd), fx: fx.rate, buyerPct: cfg.buyer_pct, feeMode: cfg.buyer_fee_mode });
      // The closest miss is worth a line: "kept 17, none qualified" says nothing about whether the
      // market is A$2 or A$40 away from a hit.
      if (!best || h.profitCents > best.profit_cents) best = { delivered_cents: h.deliveredCents, buyer_aud_cents: h.buyerAudCents, profit_cents: h.profitCents, margin_pct: h.marginPct, title: row.title, url: row.url, ambiguous: !!f.market.ambiguous };
      if (!qualifies(h, cfg)) { below++; continue; }
      current.push(hitRow({ facts, printing_key: wanted.key, row, f, h, fx, cfg, scanId, now }));
    }
    const existing = db.prepare('SELECT id, item_id, status, last_seen FROM arb_hits WHERE card_id = ? AND printing_key = ?').all(facts.card_id, wanted.key);
    const rec = reconcileHits({ existing, current, seenItemIds: rows.map((x) => x.itemId), now, scanId });
    try { applyReconcile(db, rec, want.watch_id); }
    catch (e) { console.error('[arb] store failed —', e?.message || e); emit({ warning: { card_id: facts.card_id, message: 'could not store hits: ' + String(e?.message || e) } }); }
    totals.hits_new += rec.inserts.length;
    totals.hits_total += current.length;
    if (want.watch_id) {
      db.prepare('UPDATE arb_watch SET last_scanned_at = ?, last_scan_id = ?, last_market_usd_cents = ?, last_market_at = ?, last_rows = ?, last_kept = ?, last_hits = ? WHERE id = ?')
        .run(now, scanId, toCents(wanted.marketUsd), facts.market_at, rows.length, kept, current.length, want.watch_id);
    }
    emit({ card: { ...facts, printing_key: wanted.key, market_usd: wanted.marketUsd, market_age_days: marketAgeDays(facts.market_at), query: q.q, rows: rows.length, kept, below_floor: below, hits: current.length, hits_new: rec.inserts.length, gone: rec.gone.length, dropped, best } });
    // Every hit this scan produced, with its stored id, so the page can act on it straight away.
    const stored = db.prepare('SELECT * FROM arb_hits WHERE card_id = ? AND printing_key = ? AND last_scan_id = ? AND status IN (\'new\', \'seen\', \'bought\', \'dismissed\')').all(facts.card_id, wanted.key, scanId);
    for (const hit of rankHits(stored)) emit({ hit: publicHit(hit) });
    await sleep(cfg.call_gap_ms);
  }
  return finish(null, false);
}

const publicHit = (r) => ({ ...r, warnings: (() => { try { return JSON.parse(r.warnings || '[]'); } catch { return []; } })() });

// ---------------------------------------------------------------------------
// The newly-listed sweep
// ---------------------------------------------------------------------------
// One broad Browse query per set, newest first, paged until it reaches the listing the last pass
// already read (the set's watermark). Every title is matched back to the catalogue on its own
// evidence (lib/arb-core.mjs matchTitleToCard) and then goes through exactly the filter and maths a
// named-card scan uses. Measured 2026-09-12: ~130 new AU/BIN/raw listings a day for a current set,
// so a pass is one page per query per set — two to four calls a day per set.
//
// A sweep sees only what is NEW, so it can never say a stored hit is gone: reconciliation runs only
// over the listings this pass actually saw, and an older hit it did not see is left alone.
const SWEEP_PAGE = 200;

async function runSweep(env, db, base, { sets, emit, shouldCancel, scanId }) {
  const cfg = loadArbConfig();
  const t0 = nowIso();
  const totals = { sets: 0, calls: 0, rows: 0, new_rows: 0, matched: 0, hits_new: 0, hits_total: 0, errors: 0 };
  db.prepare('INSERT OR REPLACE INTO arb_scans (id, mode, started_at, cards) VALUES (?, ?, ?, ?)').run(scanId, 'sweep', t0, sets.length);
  const finish = (aborted, cancelled) => {
    db.prepare('UPDATE arb_scans SET finished_at = ?, cards = ?, calls = ?, rows = ?, hits_new = ?, hits_total = ?, fx_usd_aud = ?, aborted = ?, cancelled = ? WHERE id = ?')
      .run(nowIso(), totals.sets, totals.calls, totals.rows, totals.hits_new, totals.hits_total, fx ? fx.rate : null, aborted || null, cancelled ? 1 : 0, scanId);
    emit({ summary: { ...totals, mode: 'sweep', aborted: aborted || null, cancelled: !!cancelled, budget: budgetState(db, cfg) } });
  };

  const fx = await loadFx(base);
  if (!fx) { emit({ start: { scan_id: scanId, mode: 'sweep', total: sets.length, budget: budgetState(db, cfg) } }); return finish('fx_unavailable'); }
  emit({ start: { scan_id: scanId, mode: 'sweep', total: sets.length, fx, budget: budgetState(db, cfg), buyer_pct: cfg.buyer_pct, fee_mode: cfg.buyer_fee_mode, queries: cfg.sweep.queries } });
  const excludeSeller = ownSeller(env, cfg);
  const memo = new Map();

  // Printed totals collide: Paradox Rift and Destined Rivals are both "/182", so "Pokemon 182" is one
  // query that serves both. Sets sharing a total form a group; the first set in the group runs the
  // number query once and every title from it is matched against every set in the group.
  const byTotal = new Map();
  for (const sw of sets) if (sw.printed_total) { if (!byTotal.has(sw.printed_total)) byTotal.set(sw.printed_total, []); byTotal.get(sw.printed_total).push(sw); }
  const metaOf = (sw) => ({ id: sw.set_id, name: sw.set_name, printedTotal: sw.printed_total, total: sw.total, ptcgoCode: sw.ptcgo_code });
  const indexes = new Map();
  const indexFor = async (sw) => {
    if (indexes.has(sw.set_id)) return indexes.get(sw.set_id);
    const { cards } = await setCards(env, sw.set_id, memo);
    const built = cards ? { set: sw, meta: metaOf(sw), index: buildSetIndex(cards, metaOf(sw)) } : null;
    indexes.set(sw.set_id, built);
    return built;
  };

  for (const sw of sets) {
    if (shouldCancel && shouldCancel()) return finish(null, true);
    const now = nowIso();
    const own = await indexFor(sw);
    if (!own) { totals.errors++; emit({ set: { set_id: sw.set_id, set_name: sw.set_name, error: 'set_not_cached' } }); continue; }
    const setMeta = own.meta;
    const printingsById = new Map();
    const seen = new Set(), dropped = {}, current = [];
    let rows = 0, newRows = 0, matched = 0, kept = 0, calls = 0, okPages = 0, total = null, reached = false, aborted = null, best = null;
    let newest = sw.watermark || null;
    const pagesCap = sw.watermark ? cfg.sweep.max_pages_per_set : cfg.sweep.first_run_pages;
    const sharedWith = [];

    for (const mode of cfg.sweep.queries) {
      const q = sweepQuery(setMeta, mode);
      if (!q) continue;
      // Which sets a title from this query may belong to. The name query is this set's alone; the
      // number query is the whole printed-total group, run by its first member only.
      let groupSets = [sw];
      if (mode === 'number') {
        const grp = byTotal.get(sw.printed_total) || [sw];
        if (grp[0].set_id !== sw.set_id) continue;
        groupSets = grp;
        for (const g of grp) if (g.set_id !== sw.set_id) sharedWith.push(g.set_id);
      }
      const groupIdx = (await Promise.all(groupSets.map(indexFor))).filter(Boolean);
      let reachedThisQuery = false;
      for (let page = 0; page < pagesCap && !reachedThisQuery; page++) {
        if (!reserveCall(db, cfg)) { aborted = 'budget_exhausted'; break; }
        calls++; totals.calls++;
        const path = browseSearchUrl(q, { limit: SWEEP_PAGE, categoryIds: CATEGORY.ccgSingles, filter: ARB_FILTER, offset: page * SWEEP_PAGE }) + '&sort=newlyListed';
        const r = await browse(base, path);
        if (r.status === 429) { burnBudget(db, cfg); aborted = 'rate_limited'; break; }
        if (r.status === 503) { aborted = 'ebay_unconfigured'; break; }
        if (r.status !== 200 || !r.json) { dropped['ebay_http_' + (r.status || 0)] = (dropped['ebay_http_' + (r.status || 0)] || 0) + 1; break; }
        okPages++;
        if (total == null || (r.json.total > total)) total = r.json.total ?? total;
        const items = r.json.itemSummaries || [];
        if (!items.length) break;
        for (const it of items) {
          const row = rowFromBrowse(it);
          if (!row) continue;
          rows++; totals.rows++;
          // ISO timestamps compare as strings. Past the watermark means past everything this pass
          // has not read — newest-first, so nothing further down this query is new either.
          if (sw.watermark && row.listedAt && row.listedAt <= sw.watermark) { reachedThisQuery = true; reached = true; break; }
          if (row.listedAt && (!newest || row.listedAt > newest)) newest = row.listedAt;
          if (!row.itemId || seen.has(row.itemId)) continue;
          seen.add(row.itemId); newRows++; totals.new_rows++;
          let m = null, hitSet = null;
          for (const gi of groupIdx) { const r2 = matchTitleToCard(row.title, gi.index); if (r2.card) { m = r2; hitSet = gi; break; } if (!m || r2.reason === 'name_mismatch') m = r2; }
          if (!m || !m.card) { const why = (m && m.reason) || 'no_number'; dropped[why] = (dropped[why] || 0) + 1; continue; }
          matched++; totals.matched++;
          let printings = printingsById.get(m.card.id);
          if (!printings) { printings = printingsWithSource(m.card).map((p) => ({ ...p, marketUsd: p.which === 'market' ? p.marketUsd : null })); printingsById.set(m.card.id, printings); }
          if (!printings.some((p) => p.marketUsd > 0)) { dropped.no_market = (dropped.no_market || 0) + 1; continue; }
          const facts = cardFacts(m.card);
          const f = filterListing(row, { matcher: numberMatcher({ number: facts.number, set: hitSet.meta }), printings, wantedKey: null, excludeSeller, sellerMinPct: cfg.seller_min_feedback_pct, sellerMinScore: cfg.seller_min_feedback_score });
          if (!f.ok) { dropped[f.reason] = (dropped[f.reason] || 0) + 1; continue; }
          if (!(f.market && f.market.marketUsd > 0)) { dropped.no_market = (dropped.no_market || 0) + 1; continue; }
          kept++;
          const h = hitMaths({ priceCents: toCents(row.price), shipCents: toCents(row.ship), marketUsdCents: toCents(f.market.marketUsd), fx: fx.rate, buyerPct: cfg.buyer_pct, feeMode: cfg.buyer_fee_mode });
          if (!best || h.profitCents > best.profit_cents) best = { name: facts.name, number: facts.number, printing_key: f.market.key, delivered_cents: h.deliveredCents, buyer_aud_cents: h.buyerAudCents, profit_cents: h.profitCents, margin_pct: h.marginPct, title: row.title, url: row.url, ambiguous: !!f.market.ambiguous };
          if (!qualifies(h, cfg)) { dropped.below_floor = (dropped.below_floor || 0) + 1; continue; }
          current.push({ ...hitRow({ facts, printing_key: f.market.key, row, f, h, fx, cfg, scanId, now }), source: 'sweep' });
        }
        if (items.length < SWEEP_PAGE) break;
      }
      if (aborted) break;
    }

    // Reconcile against whatever is already stored for the listings this pass SAW — under whichever
    // printing an earlier named-card scan filed them, so one listing never becomes two rows.
    const seenIds = [...seen];
    const existing = [];
    for (let i = 0; i < seenIds.length; i += 500) {
      const chunk = seenIds.slice(i, i + 500);
      existing.push(...db.prepare(`SELECT id, item_id, status, last_seen, card_id, printing_key FROM arb_hits WHERE item_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
    }
    const exByItem = new Map(existing.map((r) => [r.item_id, r]));
    const groups = new Map();
    const groupOf = (k) => { if (!groups.has(k)) groups.set(k, { existing: [], current: [] }); return groups.get(k); };
    for (const ex of existing) groupOf(ex.card_id + '|' + ex.printing_key).existing.push(ex);
    for (const h of current) {
      const ex = exByItem.get(h.item_id);
      if (ex) { h.printing_key = ex.printing_key; groupOf(ex.card_id + '|' + ex.printing_key).current.push(h); }
      else groupOf(h.card_id + '|' + h.printing_key).current.push(h);
    }
    let hitsNew = 0;
    for (const g of groups.values()) {
      const rec = reconcileHits({ existing: g.existing, current: g.current, seenItemIds: seenIds, now, scanId });
      try { applyReconcile(db, rec, null); hitsNew += rec.inserts.length; }
      catch (e) { console.error('[arb] sweep store failed —', e?.message || e); emit({ warning: { set_id: sw.set_id, message: 'could not store hits: ' + String(e?.message || e) } }); }
    }
    totals.hits_new += hitsNew; totals.hits_total += current.length;
    if (okPages) {
      totals.sets++;
      db.prepare('UPDATE arb_sweep_sets SET watermark = ?, last_run_at = ?, last_scan_id = ?, last_total = ?, last_calls = ?, last_rows = ?, last_new_rows = ?, last_matched = ?, last_hits = ?, last_hits_new = ?, last_dropped = ? WHERE set_id = ?')
        .run(newest, now, scanId, total, calls, rows, newRows, matched, current.length, hitsNew, JSON.stringify(dropped), sw.set_id);
    } else totals.errors++;
    emit({ set: { set_id: sw.set_id, set_name: sw.set_name, total, calls, pages_ok: okPages, rows, new_rows: newRows, matched, kept, hits: current.length, hits_new: hitsNew, dropped, watermark: newest, reached_watermark: reached, first_run: !sw.watermark, shared_number_query_with: sharedWith, best, error: okPages ? null : (aborted || 'ebay_unreachable') } });
    const hitSetIds = [...new Set(current.map((h) => h.set_id))];
    const stored = hitSetIds.length ? db.prepare(`SELECT * FROM arb_hits WHERE last_scan_id = ? AND set_id IN (${hitSetIds.map(() => '?').join(',')}) AND status IN ('new', 'seen', 'bought', 'dismissed')`).all(scanId, ...hitSetIds) : [];
    for (const hit of rankHits(stored)) emit({ hit: publicHit(hit) });
    if (aborted) return finish(aborted);
    await sleep(cfg.call_gap_ms);
  }
  return finish(null, false);
}

// ---------------------------------------------------------------------------
// The job — one scan at a time, viewable from any tab, survives the tab closing
// ---------------------------------------------------------------------------
// The exact shape of lib/listings.mjs' batch job: a globalThis singleton, a replayable ring buffer
// with sequence numbers, and a follow() that any number of responses can attach to.

const RING_MAX = 5000;
const JOB = globalThis.__arbScanJob || (globalThis.__arbScanJob = {
  id: null, mode: null, running: false, cancel_requested: false, started_at: null, finished_at: null,
  total: 0, done: 0, hits_new: 0, hits_total: 0, aborted: null, cancelled: false,
  events: [], seq: 0, waiters: [], promise: null,
});
function jobWake() { const w = JOB.waiters.splice(0); for (const f of w) { try { f(); } catch { /* viewer gone */ } } }
function jobEmit(obj) {
  const rec = { seq: ++JOB.seq, ...obj };
  JOB.events.push(rec);
  if (JOB.events.length > RING_MAX) JOB.events.splice(0, JOB.events.length - RING_MAX);
  if (obj.start) JOB.total = obj.start.total || 0;
  else if (obj.card || obj.set) { const u = obj.card || obj.set; JOB.done++; JOB.hits_new += u.hits_new || 0; JOB.hits_total += u.hits || 0; }
  else if (obj.summary) { JOB.aborted = obj.summary.aborted || null; JOB.cancelled = !!obj.summary.cancelled; }
  jobWake();
  return rec;
}
export function getArbJobState() {
  const { id, mode, running, cancel_requested, started_at, finished_at, total, done, hits_new, hits_total, aborted, cancelled, seq } = JOB;
  return { id, mode, running, cancel_requested, started_at, finished_at, total, done, hits_new, hits_total, aborted, cancelled, seq };
}
export function cancelArbJob(id) {
  if (!JOB.running || (id && id !== JOB.id)) return { ok: false, error: 'no scan is in progress', code: 'not_running' };
  JOB.cancel_requested = true;
  jobWake();
  return { ok: true, id: JOB.id, message: 'stopping after the current card' };
}
export function startArbJob(env, db, base, { cards, sets, mode }) {
  if (JOB.running) return { ok: false, code: 'job_running', id: JOB.id, error: 'a scan is already running — attach to it instead of starting a second one' };
  const units = mode === 'sweep' ? (sets || []) : (cards || []);
  JOB.id = 'a' + Date.now().toString(36);
  JOB.mode = mode; JOB.running = true; JOB.cancel_requested = false; JOB.cancelled = false; JOB.aborted = null;
  JOB.started_at = nowIso(); JOB.finished_at = null;
  JOB.total = units.length; JOB.done = JOB.hits_new = JOB.hits_total = 0;
  JOB.events = []; JOB.seq = 0;
  const args = { scanId: JOB.id, emit: jobEmit, shouldCancel: () => JOB.cancel_requested };
  JOB.promise = (mode === 'sweep' ? runSweep(env, db, base, { sets: units, ...args }) : runScan(env, db, base, { cards: units, mode, ...args }))
    .catch((e) => {
      console.error('[arb] scan failed —', e?.message || e);
      jobEmit({ summary: { cards: JOB.done, hits_new: JOB.hits_new, hits_total: JOB.hits_total, aborted: String(e?.message || e) } });
    })
    .finally(() => { JOB.running = false; JOB.finished_at = nowIso(); jobWake(); });
  return { ok: true, id: JOB.id };
}
async function followArbJob(write, fromSeq, isClosed) {
  let cursor = Math.max(0, fromSeq | 0);
  for (;;) {
    if (isClosed && isClosed()) return;
    const pending = JOB.events.filter((e) => e.seq > cursor);
    for (const e of pending) { write(e); cursor = e.seq; }
    if (!JOB.running && !JOB.events.some((e) => e.seq > cursor)) return;
    await new Promise((resolve) => { JOB.waiters.push(resolve); setTimeout(resolve, 1000); });
  }
}

// ---------------------------------------------------------------------------
// The scheduled watch pass + Telegram
// ---------------------------------------------------------------------------

let _env = {}, _db = null, _base = null;
const _watch = { last_run: null, next_run_at: null, last_result: null };

const sweepSets = (db, onlyEnabled = true) => db.prepare('SELECT * FROM arb_sweep_sets' + (onlyEnabled ? ' WHERE enabled = 1' : '') + ' ORDER BY added_at').all();

export function getArbWatchState() {
  let cfg = null; try { cfg = loadArbConfig(); } catch { /* unreadable */ }
  let budget = null; try { if (_db && cfg) budget = budgetState(_db, cfg); } catch { /* db closed */ }
  let sweep = null; try { if (_db && cfg) sweep = { enabled: !!cfg.sweep.enabled, sets: sweepSets(_db).length, queries: cfg.sweep.queries }; } catch { /* db closed */ }
  return {
    running: !!globalThis.__arbWatchTimer,
    enabled: !!(cfg && cfg.watch && cfg.watch.enabled),
    interval_hours: cfg && cfg.watch ? cfg.watch.interval_hours : null,
    next_run_at: _watch.next_run_at, last_run: _watch.last_run, last_result: _watch.last_result,
    budget, sweep, scan: getArbJobState(),
  };
}

// Send one Telegram card per NEW hit that has never been notified and carries no alert-blocking
// warning. Capped per pass — Telegram serialises at ~1/s (lib/telegram.mjs) and a first pass over a
// big watch list could otherwise queue an hour of messages. Silent when Telegram is not configured.
async function alertNewHits(env, db, cfg, base) {
  if (!cfg.watch.alerts || !telegramEnabled(env) || !telegramChatConfigured(env)) return { sent: 0, skipped: 'telegram_off' };
  const rows = db.prepare('SELECT * FROM arb_hits WHERE status = \'new\' AND notified_at IS NULL ORDER BY profit_cents DESC').all();
  let sent = 0, held = 0;
  for (const r of rows) {
    const hit = publicHit(r);
    if (!alertable(hit.warnings)) { held++; continue; }
    if (sent >= cfg.watch.max_alerts_per_pass) break;
    const card = renderArbHit(hit, { dashboardUrl: dashboardUrl(cfg) });
    const out = await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text: card.text, buttons: card.buttons });
    if (out && out.ok) { db.prepare('UPDATE arb_hits SET notified_at = ? WHERE id = ?').run(nowIso(), r.id); sent++; }
  }
  return { sent, held, pending: Math.max(0, rows.length - sent - held) };
}

// Two legs, cards then sets, each its own job so the page can attach to either; then one round of
// alerts for everything either leg found. A leg that has nothing to do or no budget is skipped with
// the reason recorded, and never stops the other.
export async function runWatchPass({ env = _env, db = _db, base = _base } = {}) {
  const cfg = loadArbConfig();
  _watch.last_run = nowIso();
  if (!db || !base) { _watch.last_result = { skipped: 'not_armed' }; return _watch.last_result; }
  if (JOB.running) { _watch.last_result = { skipped: 'scan_running' }; return _watch.last_result; }
  const result = { cards: null, sweep: null, alerts: null };

  const rows = db.prepare('SELECT id AS watch_id, card_id, printing_key FROM arb_watch WHERE active = 1 ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC LIMIT ?').all(cfg.watch.max_cards_per_pass);
  if (!rows.length) result.cards = { skipped: 'nothing_watched' };
  else {
    const budget = budgetState(db, cfg);
    if (budget.remaining < rows.length) result.cards = { skipped: 'budget', need: rows.length, remaining: budget.remaining };
    else {
      const started = startArbJob(env, db, base, { cards: rows, mode: 'watch' });
      if (!started.ok) result.cards = { skipped: started.code };
      else { await JOB.promise; const st = getArbJobState(); result.cards = { scan_id: st.id, cards: st.done, hits_new: st.hits_new, hits_total: st.hits_total, aborted: st.aborted }; }
    }
  }

  const sets = cfg.sweep.enabled ? sweepSets(db) : [];
  if (!cfg.sweep.enabled) result.sweep = { skipped: 'disabled' };
  else if (!sets.length) result.sweep = { skipped: 'no_sets' };
  else if (result.cards && (result.cards.aborted === 'rate_limited' || result.cards.aborted === 'ebay_unconfigured')) result.sweep = { skipped: result.cards.aborted };
  else {
    const budget = budgetState(db, cfg);
    const need = sets.length * cfg.sweep.queries.length;
    if (budget.remaining < need) result.sweep = { skipped: 'budget', need, remaining: budget.remaining };
    else {
      const started = startArbJob(env, db, base, { sets, mode: 'sweep' });
      if (!started.ok) result.sweep = { skipped: started.code };
      else { await JOB.promise; const st = getArbJobState(); result.sweep = { scan_id: st.id, sets: st.done, hits_new: st.hits_new, hits_total: st.hits_total, aborted: st.aborted }; }
    }
  }

  result.alerts = await alertNewHits(env, db, cfg, base).catch((e) => ({ error: String(e?.message || e) }));
  _watch.last_result = result;
  console.log('[arb] watch pass —', JSON.stringify(result));
  return result;
}

// Stop-then-start singleton on globalThis, unref'd boot timeout plus a recurring interval — the house
// pattern (lib/runs-jobs.mjs explains why it is not an early-return guard). env/db/base are remembered
// at module scope so a settings-driven restart can re-arm without them in scope.
export function startArbWatchJob({ env, db, base } = {}) {
  stopArbWatchJob();
  if (env) _env = env; if (db) _db = db; if (base) _base = base;
  const cfg = loadArbConfig();
  if (!cfg.watch.enabled) { console.log('[arb] watch job disarmed (watch.enabled is false)'); return null; }
  const intervalMs = Math.max(1, cfg.watch.interval_hours) * 3600_000;
  const tick = () => { _watch.next_run_at = new Date(Date.now() + intervalMs).toISOString(); return runWatchPass().catch((e) => console.error('[arb] watch pass failed —', e?.message || e)); };
  const boot = setTimeout(tick, 60_000);
  if (boot.unref) boot.unref();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  globalThis.__arbWatchTimer = timer;
  globalThis.__arbWatchBoot = boot;
  _watch.next_run_at = new Date(Date.now() + 60_000).toISOString();
  console.log(`[arb] watch job armed every ${cfg.watch.interval_hours}h`);
  return timer;
}
export function stopArbWatchJob() {
  if (globalThis.__arbWatchBoot) { clearTimeout(globalThis.__arbWatchBoot); globalThis.__arbWatchBoot = null; }
  if (globalThis.__arbWatchTimer) { clearInterval(globalThis.__arbWatchTimer); globalThis.__arbWatchTimer = null; }
  _watch.next_run_at = null;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const parseStatuses = (s) => String(s || '').split(',').map((x) => x.trim()).filter((x) => HIT_STATUSES.includes(x));

// One eBay call per card × printing, whatever the list said. `*charizard` and `125` on the same catch
// box both resolve sv3-125, and two calls for one card would be two units of budget for one answer.
function dedupeCards(list) {
  const seen = new Set(), out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c.card_id !== 'string' || typeof c.printing_key !== 'string') continue;
    const k = c.card_id + '|' + c.printing_key;
    if (seen.has(k)) continue;
    seen.add(k); out.push(c);
  }
  return out;
}

// Where a Telegram button should send a phone. `base` is this process's loopback address and is
// useless from anywhere else, so the button comes from config: the finder's own dashboard_url, else
// the postsale module's (lib/postsale.mjs reads the same key for its cards), else no button at all.
function dashboardUrl(cfg) {
  const own = cfg && cfg.dashboard_url && String(cfg.dashboard_url).trim();
  if (own) return own.replace(/\/$/, '') + '/arbitrage.html';
  try {
    const ps = JSON.parse(fs.readFileSync(configFile('postsale.config.json'), 'utf8')).dashboard_url;
    if (ps && String(ps).trim()) return String(ps).trim().replace(/\/$/, '') + '/arbitrage.html';
  } catch { /* absent */ }
  return null;
}

export function arbitragePlugin(env) {
  return {
    name: 'arbitrage',
    configureServer(server) {
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = 'http://127.0.0.1:' + port;
      ensureArbConfigSeeded();
      const db = openDb();
      startArbWatchJob({ env, db, base });

      server.middlewares.use('/api/arb', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const p = url.pathname.replace(/\/+$/, '') || '/';
          const method = req.method;
          let m;
          if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type');
            return res.end();
          }

          if (p === '/config' && method === 'GET') {
            const cfg = loadArbConfig();
            return send(res, 200, {
              config: cfg, own_seller: ownSeller(env, cfg), budget: budgetState(db, cfg),
              ebay_configured: !!(env.EBAY_APP_ID && env.EBAY_CERT_ID),
              // Without the postcode context most rows come back with no postage quote and are dropped,
              // so the tool goes quiet for a reason the page should be able to name.
              buyer_postcode_set: !!(env.EBAY_BUYER_POSTCODE && String(env.EBAY_BUYER_POSTCODE).trim()),
              telegram: { enabled: telegramEnabled(env), chat_configured: telegramChatConfigured(env) },
              watch_job: getArbWatchState(),
            });
          }

          if (p === '/resolve' && method === 'POST') {
            const b = await readJsonBody(req, 1e6);
            if (!Array.isArray(b.lines)) return send(res, 400, { error: 'lines (array of catch lines) required' });
            return send(res, 200, await resolveLines(env, db, base, { setId: b.setId, lines: b.lines }));
          }

          // POST /scan { cards:[{card_id, printing_key}] } | { watch:true } — starts the job and streams it.
          if (p === '/scan' && method === 'POST') {
            const b = await readJsonBody(req, 1e6);
            const cfg = loadArbConfig();
            let cards;
            if (b.sweep === true || Array.isArray(b.sweep)) {
              const all = sweepSets(db, false);
              const sets = b.sweep === true ? all.filter((x) => x.enabled) : all.filter((x) => b.sweep.includes(x.set_id));
              if (!sets.length) return send(res, 400, { error: 'no sets to sweep — add one first', code: 'no_sets' });
              const need = sets.length * cfg.sweep.queries.length;
              const budget = budgetState(db, cfg);
              if (need > budget.remaining) return send(res, 429, { ok: false, code: 'budget', error: `this sweep needs at least ${need} eBay calls and only ${budget.remaining} are left today`, need, ...budget });
              const started = startArbJob(env, db, base, { sets, mode: 'sweep' });
              if (!started.ok) return send(res, 409, started);
              const write = ndjsonStart(res);
              write({ job: { id: started.id, mode: 'sweep' } });
              let closed = false; res.on('close', () => { closed = true; });
              await followArbJob(write, 0, () => closed);
              return res.end();
            }
            if (b.watch === true) {
              cards = db.prepare('SELECT id AS watch_id, card_id, printing_key FROM arb_watch WHERE active = 1 ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC LIMIT ?').all(cfg.watch.max_cards_per_pass);
              if (!cards.length) return send(res, 400, { error: 'nothing is being watched', code: 'nothing_watched' });
            } else {
              cards = dedupeCards(b.cards);
              if (!cards.length) return send(res, 400, { error: 'cards (array of {card_id, printing_key}) required' });
              // A card on the watch list keeps its watch_id so the hit links back to it.
              const wids = new Map(db.prepare('SELECT id, card_id, printing_key FROM arb_watch WHERE active = 1').all().map((w) => [w.card_id + '|' + w.printing_key, w.id]));
              cards = cards.map((c) => ({ card_id: c.card_id, printing_key: c.printing_key, watch_id: wids.get(c.card_id + '|' + c.printing_key) || null }));
            }
            const budget = budgetState(db, cfg);
            if (cards.length > budget.remaining) return send(res, 429, { ok: false, code: 'budget', error: `this scan needs ${cards.length} eBay calls and only ${budget.remaining} are left today`, need: cards.length, ...budget });
            const started = startArbJob(env, db, base, { cards, mode: b.watch === true ? 'watch' : 'adhoc' });
            if (!started.ok) return send(res, 409, started);
            const write = ndjsonStart(res);
            write({ job: { id: started.id } });
            let closed = false; res.on('close', () => { closed = true; });
            await followArbJob(write, 0, () => closed);
            return res.end();
          }
          if (p === '/scan/state' && method === 'GET') return send(res, 200, { ...getArbJobState(), budget: budgetState(db, loadArbConfig()) });
          if ((m = p.match(/^\/scan\/([A-Za-z0-9_-]+)\/stream$/)) && method === 'GET') {
            const st = getArbJobState();
            if (st.id !== m[1]) return send(res, 404, { error: 'no such scan', code: 'unknown_job', current: st.id });
            const write = ndjsonStart(res);
            let closed = false; res.on('close', () => { closed = true; });
            await followArbJob(write, +(url.searchParams.get('from') || 0), () => closed);
            return res.end();
          }
          if ((m = p.match(/^\/scan\/([A-Za-z0-9_-]+)\/cancel$/)) && method === 'POST') {
            const out = cancelArbJob(m[1]);
            return send(res, out.ok ? 200 : 409, out);
          }
          if ((m = p.match(/^\/scan\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
            const st = getArbJobState();
            if (st.id === m[1]) return send(res, 200, st);
            const row = db.prepare('SELECT * FROM arb_scans WHERE id = ?').get(m[1]);
            return row ? send(res, 200, row) : send(res, 404, { error: 'no such scan', code: 'unknown_job', current: st.id });
          }

          // The watch list.
          if (p === '/watch' && method === 'GET') {
            const rows = db.prepare('SELECT w.*, (SELECT COUNT(*) FROM arb_hits h WHERE h.card_id = w.card_id AND h.printing_key = w.printing_key AND h.status IN (\'new\',\'seen\')) AS open_hits FROM arb_watch w ORDER BY active DESC, added_at DESC').all();
            return send(res, 200, { watch: rows, job: getArbWatchState() });
          }
          if (p === '/watch' && method === 'POST') {
            const b = await readJsonBody(req, 1e6);
            const cards = (Array.isArray(b.cards) ? b.cards : []).filter((c) => c && typeof c.card_id === 'string' && typeof c.printing_key === 'string');
            if (!cards.length) return send(res, 400, { error: 'cards (array of {card_id, printing_key}) required' });
            const added = [], failed = [], memo = new Map();
            const ins = db.prepare(`INSERT INTO arb_watch (game, set_id, card_id, number, name, set_name, printed_total, ptcgo_code, printing_key, active, last_market_usd_cents, last_market_at)
                                    VALUES ('pokemon', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                                    ON CONFLICT(game, card_id, printing_key) DO UPDATE SET active = 1, name = excluded.name, set_name = excluded.set_name, printed_total = excluded.printed_total, ptcgo_code = excluded.ptcgo_code`);
            for (const c of dedupeCards(cards)) {
              const loaded = await loadScanCard(env, c, memo);
              if (loaded.error && loaded.error !== 'no_market') { failed.push({ ...c, error: loaded.error }); continue; }
              const f = loaded.facts;
              ins.run(f.set_id, f.card_id, f.number, f.name, f.set_name, f.printed_total, f.ptcgo_code, c.printing_key, toCents(loaded.wanted && loaded.wanted.marketUsd), f.market_at);
              added.push(db.prepare('SELECT * FROM arb_watch WHERE card_id = ? AND printing_key = ?').get(f.card_id, c.printing_key));
            }
            return send(res, 200, { ok: true, added, failed });
          }
          if ((m = p.match(/^\/watch\/(\d+)$/)) && method === 'PATCH') {
            const b = await readJsonBody(req, 1e5);
            if (typeof b.active !== 'boolean') return send(res, 400, { error: 'active (boolean) required' });
            const r = db.prepare('UPDATE arb_watch SET active = ? WHERE id = ?').run(b.active ? 1 : 0, +m[1]);
            return r.changes ? send(res, 200, { ok: true, row: db.prepare('SELECT * FROM arb_watch WHERE id = ?').get(+m[1]) }) : send(res, 404, { error: 'no such watch row' });
          }
          if ((m = p.match(/^\/watch\/(\d+)$/)) && method === 'DELETE') {
            const r = db.prepare('DELETE FROM arb_watch WHERE id = ?').run(+m[1]);
            return r.changes ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such watch row' });
          }

          // The sets the sweep covers.
          if (p === '/sweep' && method === 'GET') {
            const cfg = loadArbConfig();
            const rows = sweepSets(db, false).map((r) => ({ ...r, last_dropped: (() => { try { return JSON.parse(r.last_dropped || '{}'); } catch { return {}; } })() }));
            return send(res, 200, { sets: rows, config: cfg.sweep, budget: budgetState(db, cfg) });
          }
          if (p === '/sweep' && method === 'POST') {
            const b = await readJsonBody(req, 1e5);
            const ids = [...new Set((Array.isArray(b.sets) ? b.sets : []).map((x) => String(x || '').trim()).filter(isSetId))];
            if (!ids.length) return send(res, 400, { error: 'sets (array of set ids) required' });
            const added = [], failed = [], memo = new Map();
            const ins = db.prepare(`INSERT INTO arb_sweep_sets (set_id, set_name, printed_total, total, ptcgo_code, enabled) VALUES (?, ?, ?, ?, ?, 1)
                                    ON CONFLICT(set_id) DO UPDATE SET enabled = 1, set_name = excluded.set_name, printed_total = excluded.printed_total, total = excluded.total, ptcgo_code = excluded.ptcgo_code`);
            for (const id of ids) {
              // The set's facts come from the sets cache, else from the first card of the set itself —
              // and a set whose cards cannot be loaded cannot be swept, so it is refused here rather
              // than failing on every pass.
              const { cards, reason } = await setCards(env, id, memo);
              if (!cards || !cards.length) { failed.push({ set_id: id, error: reason || 'set_not_cached' }); continue; }
              const meta = findSet({ id }) || {};
              const c0 = cards[0].set || {};
              const name = meta.name || c0.name || '';
              if (!name) { failed.push({ set_id: id, error: 'no_set_name' }); continue; }
              ins.run(id, name, meta.printedTotal || c0.printedTotal || null, meta.total || c0.total || null, meta.ptcgoCode || c0.ptcgoCode || null);
              added.push(db.prepare('SELECT * FROM arb_sweep_sets WHERE set_id = ?').get(id));
            }
            return send(res, 200, { ok: true, added, failed });
          }
          if ((m = p.match(/^\/sweep\/([A-Za-z0-9._-]+)$/)) && method === 'PATCH') {
            const b = await readJsonBody(req, 1e5);
            const sets = {};
            if (typeof b.enabled === 'boolean') sets.enabled = b.enabled ? 1 : 0;
            // Clearing the watermark makes the next pass a first run again (first_run_pages deep).
            if (b.reset === true) sets.watermark = null;
            if (!Object.keys(sets).length) return send(res, 400, { error: 'enabled (boolean) or reset (true) required' });
            const r = db.prepare(`UPDATE arb_sweep_sets SET ${Object.keys(sets).map((k) => k + ' = ?').join(', ')} WHERE set_id = ?`).run(...Object.values(sets), m[1]);
            return r.changes ? send(res, 200, { ok: true, row: db.prepare('SELECT * FROM arb_sweep_sets WHERE set_id = ?').get(m[1]) }) : send(res, 404, { error: 'no such sweep set' });
          }
          if ((m = p.match(/^\/sweep\/([A-Za-z0-9._-]+)$/)) && method === 'DELETE') {
            const r = db.prepare('DELETE FROM arb_sweep_sets WHERE set_id = ?').run(m[1]);
            return r.changes ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such sweep set' });
          }

          // Hits.
          if (p === '/hits' && method === 'GET') {
            const statuses = parseStatuses(url.searchParams.get('status'));
            const st = statuses.length ? statuses : ['new', 'seen'];
            const since = url.searchParams.get('since');
            const cardId = url.searchParams.get('card_id');
            const limit = Math.min(1000, Math.max(1, +(url.searchParams.get('limit') || 300)));
            const where = ['status IN (' + st.map(() => '?').join(',') + ')'];
            const args = st.slice();
            if (since) { where.push('first_seen > ?'); args.push(since); }
            if (cardId) { where.push('card_id = ?'); args.push(cardId); }
            const source = url.searchParams.get('source');
            if (source === 'scan' || source === 'sweep') { where.push('source = ?'); args.push(source); }
            const rows = db.prepare(`SELECT * FROM arb_hits WHERE ${where.join(' AND ')} ORDER BY profit_cents DESC, margin_pct DESC LIMIT ?`).all(...args, limit);
            const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM arb_hits GROUP BY status').all().map((r) => [r.status, r.n]));
            return send(res, 200, { hits: rows.map(publicHit), counts, budget: budgetState(db, loadArbConfig()) });
          }
          if (p === '/hits' && method === 'PATCH') {
            const b = await readJsonBody(req, 1e6);
            const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => +x).filter((x) => Number.isInteger(x) && x > 0);
            if (!ids.length || !HIT_STATUSES.includes(b.status)) return send(res, 400, { error: 'ids (array) and a valid status required' });
            let changed = 0, refused = 0;
            for (const id of ids) {
              const row = db.prepare('SELECT status FROM arb_hits WHERE id = ?').get(id);
              if (!row || !canTransition(row.status, b.status)) { refused++; continue; }
              db.prepare('UPDATE arb_hits SET status = ? WHERE id = ?').run(b.status, id); changed++;
            }
            return send(res, 200, { ok: true, changed, refused });
          }
          if ((m = p.match(/^\/hits\/(\d+)$/)) && method === 'PATCH') {
            const b = await readJsonBody(req, 1e5);
            const row = db.prepare('SELECT status FROM arb_hits WHERE id = ?').get(+m[1]);
            if (!row) return send(res, 404, { error: 'no such hit' });
            if (!HIT_STATUSES.includes(b.status)) return send(res, 400, { error: 'status must be one of ' + HIT_STATUSES.join(', ') });
            if (!canTransition(row.status, b.status)) return send(res, 409, { error: `a ${row.status} hit cannot become ${b.status}`, code: 'bad_transition', from: row.status });
            db.prepare('UPDATE arb_hits SET status = ? WHERE id = ?').run(b.status, +m[1]);
            return send(res, 200, { ok: true, hit: publicHit(db.prepare('SELECT * FROM arb_hits WHERE id = ?').get(+m[1])) });
          }
          // One getItem call, on request only — item summaries carry no quantity, and spending a call
          // per hit automatically would eat the budget on rows nobody buys.
          if ((m = p.match(/^\/hits\/(\d+)\/check-qty$/)) && method === 'POST') {
            const row = db.prepare('SELECT * FROM arb_hits WHERE id = ?').get(+m[1]);
            if (!row) return send(res, 404, { error: 'no such hit' });
            const cfg = loadArbConfig();
            if (!reserveCall(db, cfg)) return send(res, 429, { ok: false, code: 'budget', ...budgetState(db, cfg) });
            const r = await browse(base, '/api/ebay/buy/browse/v1/item/' + encodeURIComponent(row.item_id));
            if (r.status !== 200 || !r.json) return send(res, 200, { ok: false, error: r.status === 404 ? 'listing_gone' : 'ebay_http_' + r.status, status: r.status });
            const av = (r.json.estimatedAvailabilities || [])[0] || {};
            const qty = av.estimatedAvailableQuantity != null ? +av.estimatedAvailableQuantity : null;
            db.prepare('UPDATE arb_hits SET qty_available = ? WHERE id = ?').run(qty, row.id);
            return send(res, 200, { ok: true, qty_available: qty, availability: av.availabilityThreshold || null, sold: av.estimatedSoldQuantity ?? null, budget: budgetState(db, cfg) });
          }

          if (p === '/watch/run' && method === 'POST') {
            const out = await runWatchPass({ env, db, base });
            return send(res, 200, { ok: true, result: out });
          }

          return send(res, 404, { error: 'unknown endpoint', endpoints: ['/config', '/resolve', '/scan', '/scan/state', '/scan/:id/stream', '/scan/:id/cancel', '/scan/:id', '/watch', '/watch/:id', '/watch/run', '/sweep', '/sweep/:set_id', '/hits', '/hits/:id', '/hits/:id/check-qty'] });
        } catch (e) {
          console.error('[api/arb]', (e && e.message) || e);
          if (!res.headersSent) return send(res, 200, { error: 'arb_failed', detail: String((e && e.message) || e) });
          try { res.end(); } catch { /* already gone */ }
        }
      });

      console.log('[arb] API /api/arb · page /arbitrage.html');
    },
  };
}
