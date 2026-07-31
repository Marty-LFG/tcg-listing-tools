// lib/repricer-scan.mjs — one pass over our live listings: what does the market say, and what would
// we do about it?
//
// READ-ONLY with respect to eBay. This module never writes a price and never creates a proposal; it
// records a `price_checks` row per listing and stops. That is deliberate — it is the whole value of
// shadow mode, available before any of the delivery surfaces exist: run it once and you can read
// exactly what the repricer would have proposed, and why it refused everything else.
//
// The judgement itself is in lib/repricer-decide.mjs, which is pure. This file is the I/O half:
// fetch, throttle, persist, count. Keeping the split means every guardrail is unit-tested without a
// network, and everything here is about being a good citizen of two rate-limited APIs.
//
// Budget shape per pass (~160 listings): one paged GetMyeBaySelling for the mirror, then per
// candidate one GetItem (live price + postage + Best Offer + variations) and one Browse comps call.
// Trading is comfortable at 5,000/day; Browse is the binding constraint at 5,000/day.

import { parseCardTitle } from './listing-title-parse.mjs';
import { singlesEbayValue, classifyLang, buildNumberRe } from './comps-singles.mjs';
import { getListingState } from './ebay-trading.mjs';
import { importSellerListings } from './listings.mjs';
import { decideReprice, eligibleForReprice } from './repricer-decide.mjs';
import { scrubSecrets } from './logbuffer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The game has to come from the title. priceItem() hardcodes 'Pokemon', which is fine when a human
// is looking at the answer but not when a scan prices Riftbound and Lorcana off it: prefixing
// "Pokemon" returns Pokemon cards that merely share a collector number, and the precision filter
// cannot tell the difference because it only checks the number appears.
const GAMES = [
  [/\bpok[eé]mon\b/i, 'Pokemon'],
  [/\briftbound\b/i, 'Riftbound'],
  [/\blorcana\b/i, 'Lorcana'],
  [/\bone piece\b/i, 'One Piece'],
  [/\b(star wars:?\s*unlimited|swu)\b/i, 'Star Wars Unlimited'],
  [/\b(magic:?\s*the gathering|mtg)\b/i, 'Magic The Gathering'],
  [/\byu-?gi-?oh\b/i, 'Yu-Gi-Oh'],
];
export function inferGame(title) {
  const t = String(title || '');
  for (const [re, name] of GAMES) if (re.test(t)) return name;
  return null;   // decideReprice turns this into skip/unknown_game rather than guessing
}

// game + name + number. The number is what the comps precision filter actually keys on; the set name
// is deliberately left out because parseCardTitle cannot resolve it without a per-game set list, and
// a wrong set in the query is worse than no set.
export function compsQueryFor(game, identity) {
  return [game, identity && identity.name, identity && identity.number].filter(Boolean).join(' ').trim();
}

const finishHint = (title) => (/non[\s-]?foil|non[\s-]?holo/i.test(title || '') ? 'nonfoil'
  : /holo|foil|reverse|etched|rainbow/i.test(title || '') ? 'foil' : null);

// Identity work that costs no API call, so an unusable title is refused before we spend anything.
//
// `numberSafe` is the load-bearing part. The comps precision filter keys on the collector number via
// buildNumberRe, and that function inverts on some real shapes: buildNumberRe('039a/298') compiles to
// /\b0*39\b/, which fails to match the card's own number while matching "Mewtwo 39 Promo". The test
// is therefore self-referential — build the filter's regex from the number and check it matches that
// number. If the filter cannot recognise the card it was built for, it cannot be trusted to pick that
// card's comps out of a search result either. Catches alt-art suffixes (039a/298) and the One Piece
// style (OP01-003), passes the ordinary shapes (016/084, 86, 152/132).
export function identifyListing(row) {
  const title = row.title || '';
  const identity = parseCardTitle(title);
  identity.game = inferGame(title);
  identity.numberSafe = false;
  if (identity.number) {
    try {
      const re = buildNumberRe(identity.number);
      identity.numberSafe = !!(re && re.test(identity.number));
    } catch { identity.numberSafe = false; }
  }
  return identity;
}

let _running = false;
export const isScanRunning = () => _running;

export async function scanListings({ env, rdb, tdb, cfg = {}, base, limit = 0, gapMs = 400, importFirst = true } = {}) {
  // A pass over 160 listings takes minutes; a slow eBay makes it many more. Overlapping passes would
  // double the API spend and race each other's price_checks rows for no benefit.
  if (_running) return { ok: false, skipped: 'already_running' };
  _running = true;
  const startedAt = new Date();
  const scanId = 's' + startedAt.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const stats = { scan_id: scanId, checked: 0, raise: 0, hold: 0, decline: 0, skip: 0, errors: 0, codes: {} };

  try {
    // Refresh the mirror first. Nothing else populates it — there is no scheduler for the import —
    // so a scan that required a fresh mirror would silently no-op forever.
    if (importFirst) {
      const imp = await importSellerListings(env, tdb);
      stats.import = imp && imp.ok ? { imported: imp.imported, truncated: !!imp.truncated } : { ok: false, error: imp && imp.error };
      if (!imp || !imp.ok) return { ok: false, error: 'listing import failed: ' + ((imp && imp.error) || 'unknown'), ...stats };
      // `truncated` means "not reached", not "not there" — the ended sweep is skipped on truncation,
      // so some rows may be dead. Pricing against those is worse than not pricing at all.
      if (imp.truncated) return { ok: false, error: 'listing import was truncated — not scanning against a partial mirror', ...stats };
    }

    const rows = tdb.prepare(`SELECT listing_id, sku, title, price_cents, currency, available_qty, listing_type, state, created_via
      FROM ebay_seller_listings WHERE state = 'active' ORDER BY listing_id`).all();

    const ins = rdb.prepare(`INSERT INTO price_checks
      (item_id, scan_id, our_price_cents, our_postage_cents, target_delivered_cents, target_cents,
       cluster_lo_cents, cluster_hi_cents, fair_cents, cheapest_cents, n_comparable, sample_size,
       reliable, confidence, mode, query, uplift_cents, uplift_pct, verdict, code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const record = (itemId, priceCents, postageCents, d, query) => {
      const e = d.evidence || {};
      ins.run(itemId, scanId, priceCents ?? null, postageCents ?? null,
        e.targetDeliveredCents ?? null, d.toPriceCents ?? null,
        e.clusterLoCents ?? null, e.clusterHiCents ?? null, e.fairCents ?? null, e.cheapestCents ?? null,
        e.comparable ?? null, e.sampleSize ?? null,
        e.reliable == null ? null : (e.reliable ? 1 : 0), e.confidence ?? null, e.mode ?? null,
        query ?? e.query ?? null, d.upliftCents ?? null, d.upliftPct ?? null, d.verdict, d.code ?? null);
      stats.checked++;
      stats[d.verdict] = (stats[d.verdict] || 0) + 1;
      if (d.code) stats.codes[d.code] = (stats.codes[d.code] || 0) + 1;
    };

    const guardrails = guardrailsFrom(cfg);
    let n = 0;
    for (const row of rows) {
      if (limit && n >= limit) break;
      n++;
      try {
        // 1. identity, offline. An unparseable title or unknown game is refused for free — and it is
        //    the gate that stops comps being trusted for an alt-art number the filter cannot match.
        const identity = identifyListing(row);
        const cheap = { ...row, listingId: row.listing_id, priceCents: row.price_cents, availableQty: row.available_qty, listingType: row.listing_type, postageCents: 0 };
        const pre = eligibleForReprice(cheap, identity, guardrails);
        if (!pre.ok && pre.code !== 'postage_unknown') {
          record(row.listing_id, row.price_cents, null, { verdict: 'skip', code: pre.code }, null);
          continue;
        }

        // 2. live truth from eBay. The mirror is never the basis for a decision, and this is also
        //    the only place postage, Best Offer, promotions and variations are visible.
        const live = await getListingState(env, row.listing_id);
        if (!live.ok) { stats.errors++; record(row.listing_id, row.price_cents, null, { verdict: 'skip', code: 'listing_read_failed' }, null); await sleep(gapMs); continue; }

        const listing = {
          listingId: row.listing_id, title: live.title || row.title,
          priceCents: live.price_cents, postageCents: live.postage_cents,
          currency: row.currency || 'AUD',
          availableQty: live.available_qty, listingType: live.listing_type,
          state: live.listing_status === 'Active' ? 'active' : 'ended',
          createdVia: row.created_via,
          bestOffer: !!live.best_offer_enabled,
          bestOfferAutoAcceptCents: live.best_offer_auto_accept_cents,
          discountPricing: !!live.pricing_treatment,
          isVariation: !!live.has_variations,
        };
        const elig = eligibleForReprice(listing, identity, guardrails);
        if (!elig.ok) { record(row.listing_id, listing.priceCents, listing.postageCents, { verdict: 'skip', code: elig.code }, null); await sleep(gapMs); continue; }

        // 3. the market. excludeSeller keeps our own listing out of its own comp set.
        const query = compsQueryFor(identity.game, identity);
        const comps = await singlesEbayValue({
          base, query,
          numberMatch: identity.number || '',
          lang: classifyLang(listing.title) || 'en',
          finish: finishHint(listing.title),
          graded: !!identity.graded,
          excludeSeller: cfg.exclude_seller_username || null,
        });

        // 4. the judgement (pure)
        const d = decideReprice({ listing, identity, comps, guardrails, context: { nowIso: new Date().toISOString() } });
        record(row.listing_id, listing.priceCents, listing.postageCents, d, query);
      } catch (e) {
        // GR7: one bad listing never ends the pass.
        stats.errors++;
        console.warn('[repricer/scan] ' + row.listing_id + ' — ' + (e?.message || e));
      }
      await sleep(gapMs);
    }

    stats.ok = true;
    return { ok: true, ...stats, started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), considered: rows.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ...stats };
  } finally {
    _running = false;
  }
}

// --- scheduler -------------------------------------------------------------------------------
// Stop-then-start, NOT an early-return guard: Vite restarts the dev server in-process on any
// watched-file change, and an early return would leave the OLD timer armed against a stale db/env
// while the new server believes it started one. Each (re)start cleanly replaces the prior
// timer+boot. globalThis is the cross-instance singleton because the module is re-imported on
// restart. Mirrors startCollector in lib/collector.mjs; there is deliberately no httpServer 'close'
// teardown (that raced the restart and left the loops dead for days).
//
// env/rdb/tdb/base/loadCfg are remembered so SETTINGS.repricer.apply() — which has no server context
// in scope — can restart the loop after a settings save.
let _ctx = { env: null, rdb: null, tdb: null, base: null, loadCfg: () => ({}) };
let _lastRun = null, _nextRunAt = null;

export function getRepricerScanState() {
  let enabled = false;
  try { enabled = _ctx.loadCfg().scan_enabled === true; } catch { /* unreadable config reads as off */ }
  // `enabled` lets the heartbeat tell an owner-disabled loop (a legitimate quiet state) from a
  // silently dead one, the same distinction getRefreshState() makes.
  return { running: !!globalThis.__repricerScanTimer, enabled, next_run_at: _nextRunAt, last_run: _lastRun };
}

export function startRepricerScan(ctx = {}) {
  stopRepricerScan();
  _ctx = { ..._ctx, ...ctx };
  const cfg = _ctx.loadCfg() || {};
  if (cfg.scan_enabled !== true) { console.log('[repricer] scan disabled (data/repricer.config.json)'); return null; }
  const hours = Math.max(1, Number(cfg.cadence_hours) || 24);
  const ms = hours * 3600_000;

  const tick = () => {
    _nextRunAt = new Date(Date.now() + ms).toISOString();
    // Re-read config every tick so turning the scan off in settings takes effect at the next fire
    // even if nothing restarted the timer.
    const live = _ctx.loadCfg() || {};
    const startedAt = new Date().toISOString();
    if (live.scan_enabled !== true) { _lastRun = { at: startedAt, trigger: 'schedule', ok: true, skipped: 'disabled' }; return undefined; }
    return scanListings({ env: _ctx.env, rdb: _ctx.rdb, tdb: _ctx.tdb, cfg: live, base: _ctx.base })
      .then((r) => { _lastRun = { at: startedAt, finished_at: new Date().toISOString(), trigger: 'schedule', ...r }; })
      .catch((e) => {
        // Never throw out of a timer (GR7). scrubSecrets because this string reaches the open
        // /api/status (GR2).
        _lastRun = { at: startedAt, finished_at: new Date().toISOString(), trigger: 'schedule', ok: false, error: scrubSecrets(String(e?.message || e)) };
        console.error('[repricer/scan]', e?.message || e);
      });
  };

  // 180s: the heaviest loop in the app (one GetItem + one Browse per listing), so it starts well
  // after the lighter ones rather than piling onto boot alongside them.
  const boot = setTimeout(tick, 180_000);
  if (boot.unref) boot.unref();
  const timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
  globalThis.__repricerScanTimer = timer;
  globalThis.__repricerScanBoot = boot;
  _nextRunAt = new Date(Date.now() + ms).toISOString();
  console.log(`[repricer] scan scheduled every ${hours}h`);
  return timer;
}

export function stopRepricerScan() {
  if (globalThis.__repricerScanBoot) { clearTimeout(globalThis.__repricerScanBoot); globalThis.__repricerScanBoot = null; }
  if (globalThis.__repricerScanTimer) { clearInterval(globalThis.__repricerScanTimer); globalThis.__repricerScanTimer = null; }
  _nextRunAt = null;
}

// config (dollars, owner-facing) -> guardrails (cents, machine-facing).
// Absent keys are OMITTED rather than passed as undefined: decideReprice merges over
// DEFAULT_GUARDRAILS, and `{...defaults, minComparable: undefined}` would blow the default away and
// silently disable the guardrail it was meant to carry.
export function guardrailsFrom(cfg = {}) {
  const g = cfg.guardrails || {};
  const out = {};
  const put = (k, v) => { if (v != null) out[k] = v; };
  put('minComparable', g.min_comparable);
  put('minUpliftPct', g.min_uplift_pct);
  put('minUpliftCents', g.min_uplift_aud != null ? Math.round(g.min_uplift_aud * 100) : null);
  put('requiredConfidence', g.required_confidence);
  put('maxIncreasePct', g.max_increase_pct_per_run);
  put('neverDecrease', g.never_decrease);
  put('bestOfferScaling', g.best_offer_scaling);
  put('targetAnchor', g.target_anchor);
  put('anchorN', g.anchor_n);
  return out;
}
