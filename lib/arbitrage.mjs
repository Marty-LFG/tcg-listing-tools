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
  resolveCard, printingsWithSource, toCents, MULTI_RE,
} from './arb-core.mjs';

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
async function setCards(env, setId) {
  if (!isSetId(setId)) return { cards: null, reason: 'bad_set_id' };
  const d = await getSetCards(env, setId);
  if (!d || !d.cards) return { cards: null, reason: 'set_not_cached' };
  refreshIfPricesAreStale(d.at, () => getSetCards(env, setId, { refresh: true }));
  return { cards: d.cards, at: d.at };
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
async function loadScanCard(env, { card_id, printing_key }) {
  const setId = setIdOfCard(card_id);
  const { cards, reason } = await setCards(env, setId);
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
  const out = [], unknown = [];
  const watching = new Set(db.prepare('SELECT card_id || \'|\' || printing_key AS k FROM arb_watch WHERE active = 1').all().map((r) => r.k));
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const parsed = parseCatch(line, { setCodes: codes });
    if (parsed.setCode) { const s = findSet({ code: parsed.setCode }); if (s && s.id) current = s.id; else unknown.push({ line, why: 'unknown set code ' + parsed.setCode }); }
    if (parsed.num == null && !parsed.nameQuery) { if (!parsed.setCode) unknown.push({ line, why: 'no card number or *name on this line' }); continue; }
    if (!current) { unknown.push({ line, why: 'no set chosen' }); continue; }
    const { cards, reason } = await setCards(env, current);
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
    tooGoodRatio: cfg.too_good_ratio, coupon: row.coupon, condClass: f.cond.cls,
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
  };
}

const HIT_COLS = ['game', 'set_id', 'card_id', 'number', 'name', 'printing_key', 'scored_printing_key', 'printing_ambiguous', 'item_id', 'legacy_item_id',
  'price_cents', 'price_currency', 'ship_cents', 'fee_cents', 'delivered_cents', 'market_usd_cents', 'market_currency', 'market_at', 'fx_usd_aud', 'fx_date',
  'buyer_pct', 'buyer_aud_cents', 'profit_cents', 'margin_pct', 'ratio', 'title', 'url', 'image', 'seller', 'seller_fb_pct', 'seller_fb_score',
  'cond', 'cond_id', 'cond_class', 'cond_evidence', 'match_tier', 'coupon', 'best_offer', 'warnings', 'listed_at', 'last_scan_id'];

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

  for (const want of cards) {
    if (shouldCancel && shouldCancel()) return finish(null, true);
    const now = nowIso();
    const loaded = await loadScanCard(env, want);
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
  else if (obj.card) { JOB.done++; JOB.hits_new += obj.card.hits_new || 0; JOB.hits_total += obj.card.hits || 0; }
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
export function startArbJob(env, db, base, { cards, mode }) {
  if (JOB.running) return { ok: false, code: 'job_running', id: JOB.id, error: 'a scan is already running — attach to it instead of starting a second one' };
  JOB.id = 'a' + Date.now().toString(36);
  JOB.mode = mode; JOB.running = true; JOB.cancel_requested = false; JOB.cancelled = false; JOB.aborted = null;
  JOB.started_at = nowIso(); JOB.finished_at = null;
  JOB.total = cards.length; JOB.done = JOB.hits_new = JOB.hits_total = 0;
  JOB.events = []; JOB.seq = 0;
  JOB.promise = runScan(env, db, base, { cards, mode, scanId: JOB.id, emit: jobEmit, shouldCancel: () => JOB.cancel_requested })
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

export function getArbWatchState() {
  let cfg = null; try { cfg = loadArbConfig(); } catch { /* unreadable */ }
  let budget = null; try { if (_db && cfg) budget = budgetState(_db, cfg); } catch { /* db closed */ }
  return {
    running: !!globalThis.__arbWatchTimer,
    enabled: !!(cfg && cfg.watch && cfg.watch.enabled),
    interval_hours: cfg && cfg.watch ? cfg.watch.interval_hours : null,
    next_run_at: _watch.next_run_at, last_run: _watch.last_run, last_result: _watch.last_result,
    budget, scan: getArbJobState(),
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
    const card = renderArbHit(hit, { dashboardUrl: (base || '') + '/arbitrage.html' });
    const out = await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text: card.text, buttons: card.buttons });
    if (out && out.ok) { db.prepare('UPDATE arb_hits SET notified_at = ? WHERE id = ?').run(nowIso(), r.id); sent++; }
  }
  return { sent, held, pending: Math.max(0, rows.length - sent - held) };
}

export async function runWatchPass({ env = _env, db = _db, base = _base } = {}) {
  const cfg = loadArbConfig();
  _watch.last_run = nowIso();
  if (!db || !base) { _watch.last_result = { skipped: 'not_armed' }; return _watch.last_result; }
  if (JOB.running) { _watch.last_result = { skipped: 'scan_running' }; return _watch.last_result; }
  const rows = db.prepare('SELECT id AS watch_id, card_id, printing_key FROM arb_watch WHERE active = 1 ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC LIMIT ?').all(cfg.watch.max_cards_per_pass);
  if (!rows.length) { _watch.last_result = { skipped: 'nothing_watched' }; return _watch.last_result; }
  const budget = budgetState(db, cfg);
  if (budget.remaining < rows.length) { _watch.last_result = { skipped: 'budget', need: rows.length, remaining: budget.remaining }; return _watch.last_result; }
  const started = startArbJob(env, db, base, { cards: rows, mode: 'watch' });
  if (!started.ok) { _watch.last_result = { skipped: started.code }; return _watch.last_result; }
  await JOB.promise;
  const st = getArbJobState();
  const alerts = await alertNewHits(env, db, cfg, base).catch((e) => ({ error: String(e?.message || e) }));
  _watch.last_result = { scan_id: st.id, cards: st.done, hits_new: st.hits_new, hits_total: st.hits_total, aborted: st.aborted, alerts };
  console.log('[arb] watch pass —', JSON.stringify(_watch.last_result));
  return _watch.last_result;
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
            if (b.watch === true) {
              cards = db.prepare('SELECT id AS watch_id, card_id, printing_key FROM arb_watch WHERE active = 1 ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC LIMIT ?').all(cfg.watch.max_cards_per_pass);
              if (!cards.length) return send(res, 400, { error: 'nothing is being watched', code: 'nothing_watched' });
            } else {
              cards = (Array.isArray(b.cards) ? b.cards : []).filter((c) => c && typeof c.card_id === 'string' && typeof c.printing_key === 'string');
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
            const added = [], failed = [];
            const ins = db.prepare(`INSERT INTO arb_watch (game, set_id, card_id, number, name, set_name, printed_total, ptcgo_code, printing_key, active, last_market_usd_cents, last_market_at)
                                    VALUES ('pokemon', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                                    ON CONFLICT(game, card_id, printing_key) DO UPDATE SET active = 1, name = excluded.name, set_name = excluded.set_name, printed_total = excluded.printed_total, ptcgo_code = excluded.ptcgo_code`);
            for (const c of cards) {
              const loaded = await loadScanCard(env, c);
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

          return send(res, 404, { error: 'unknown endpoint', endpoints: ['/config', '/resolve', '/scan', '/scan/state', '/scan/:id/stream', '/scan/:id/cancel', '/scan/:id', '/watch', '/watch/:id', '/watch/run', '/hits', '/hits/:id', '/hits/:id/check-qty'] });
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
