// lib/ebay-testbed.mjs — the API behind ebay-testbed.html.
//
// A bench for one question: which way of ASKING eBay produces the best comps? It builds the same
// search several ways (lib/ebay-query.mjs modes), runs each, and reports what each one actually
// bought — so a query strategy can be chosen from measurements instead of from intuition.
//
// TWO RULES THIS FILE IS BUILT AROUND
//
// 1. Rank by CLUSTER SIZE and PRICE DELTA, never by result count. singlesEbayValue refuses below
//    minComps and its relaxation ladder wants 5 rows a rung, so a query returning 6 totals cannot
//    price anything while a loose one returning 200 and filtering to 12 can. "Fewest results" is
//    the opposite of the goal, and a table sorted on `total` would recommend the worst engine.
//
// 2. Run the REAL engine. Every lane calls singlesEbayValue (via its browseQuery option), so what
//    is being compared is what production would actually have decided. A testbed that reimplements
//    the clustering it is measuring is measuring itself (GR9).
//
// Mounted at /api/testbed, NOT /api/ebay-testbed: Vite matches middleware prefixes with startsWith,
// and this suite has been bitten twice by that already (/api/rb vs /api/rbs). Nothing new goes
// under an existing prefix.
//
// Read-only with respect to eBay and to our own data — it searches and reports, it never prices a
// listing or writes an inventory row. Never throws (GR7): every failure is a JSON body.
import { buildEbayQuery, MODES, PACKS, GRADERS, isUnsafeExclusion } from './ebay-query.mjs';
import { CATEGORY, ASPECT_FILL, TRUST_FILL, PROFESSIONAL_GRADER, CARD_CONDITION, GAME_ASPECT } from './ebay-vocab.mjs';
import { searchUrl, browseSearchUrl, SOP } from './ebay-links.mjs';
import { singlesEbayValue } from './comps-singles.mjs';
import { openDb } from './db.mjs';
import { readJsonBody } from './req-body.mjs';

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };

// The Browse app token is roughly 5,000 calls a day and one ablation sweep is ~25 of them. A page
// that recounts on every keystroke could spend the daily budget in an afternoon, so the spend is
// counted here rather than trusted to the UI. Resets with the process, which is the right
// granularity for a tool that is opened, used and closed.
let _calls = 0;
const DAILY_SOFT_CAP = 1500;
export const callCount = () => _calls;

// One Browse call through our own proxy, so token minting and the AU marketplace header stay in
// the one place that knows about them. Returns a shape, never throws.
async function browse(base, path, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    _calls++;
    const r = await fetch(base + path, { signal: ac.signal });
    let json = null;
    try { json = await r.json(); } catch { /* upstream sent non-json */ }
    return { status: r.status, json, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e), ms: Date.now() - t0 };
  } finally { clearTimeout(t); }
}

// A count-only probe: limit=1 and read `total`. This is the fastest feedback the API allows and it
// is how every measurement in this feature's design was taken — cheap enough to fire on each
// toggle, which is what makes the cost of a filter visible while you are choosing it.
export async function countFor(base, plan) {
  const path = browseSearchUrl(plan.browse.q, {
    limit: 1,
    categoryIds: plan.browse.category_ids,
    filter: plan.browse.filter,
    aspectFilter: plan.browse.aspect_filter,
  });
  if (!path) return { total: null, status: 0, reason: 'empty_query' };
  const r = await browse(base, path);
  if (r.status !== 200 || !r.json) {
    return { total: null, status: r.status, ms: r.ms, reason: r.status === 503 ? 'ebay_unconfigured' : 'http_' + r.status,
      detail: r.json && r.json.errors && r.json.errors[0] && String(r.json.errors[0].message || '').slice(0, 140) };
  }
  return { total: r.json.total != null ? r.json.total : 0, status: 200, ms: r.ms };
}

// What each identity field COSTS in results. Removing one token at a time and re-counting turns
// "this query returns nothing" into "the set name is what killed it" — the difference between a
// dead end and a fix. Sorted by cost, so the landmines surface at the top and the zero-cost terms
// below are deletion candidates.
export async function ablate(base, identity, opts, { max = 25 } = {}) {
  const full = buildEbayQuery(identity, opts);
  const baseline = await countFor(base, full);
  const out = [];
  const fields = full.core.fields.slice();
  const terms = full.excludes.slice(0, Math.max(0, max - fields.length)).map((e) => e.term);
  // Ablate the core by removing the WORDS from the finished query, not by blanking the field and
  // rebuilding. Rebuilding frees a slot in the core budget, which lets a previously-dropped field
  // back in — so the measurement would report "removed the name" while actually having swapped the
  // name for the set name, and a removal could come back with FEWER results than the baseline.
  // Same string surgery as the exclusion arm below, so the two halves are comparable.
  const coreWords = full.core.text ? full.core.text.split(' ') : [];
  const valueWords = (f) => String((full.core.values && full.core.values[f]) || '').split(' ').filter(Boolean);
  for (const f of fields) {
    const drop = new Set(valueWords(f));
    if (!drop.size) continue;
    const q = [coreWords.filter((w) => !drop.has(w)).join(' '), ...full.excludes.map((e) => e.raw || ('-' + e.term))].join(' ').replace(/\s+/g, ' ').trim();
    const c = await countFor(base, { browse: { ...full.browse, q } });
    out.push({ kind: 'field', label: f, total: c.total, delta: (c.total != null && baseline.total != null) ? c.total - baseline.total : null });
  }
  for (const term of terms) {
    const kept = full.excludes.filter((e) => e.term !== term);
    const q = [full.core.text, ...kept.map((e) => e.raw || ('-' + e.term))].join(' ').trim();
    const c = await countFor(base, { browse: { ...full.browse, q } });
    out.push({ kind: 'exclude', label: '-' + term, total: c.total, delta: (c.total != null && baseline.total != null) ? c.total - baseline.total : null });
  }
  out.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  return { baseline: baseline.total, terms: out, truncated: full.excludes.length > terms.length };
}

// Ask eBay what aspects a search actually has, and how many listings filled each value in. This is
// the discovery half of the "only gate on well-filled aspects" rule — and the fill rate is the
// thing a static table cannot know for a specific card.
export async function discoverAspects(base, { q, category = CATEGORY.ccgSingles, aspectFilter = null } = {}) {
  const path = browseSearchUrl(q || 'pokemon', {
    limit: 1, categoryIds: category, filter: 'itemLocationCountry:AU',
    aspectFilter, fieldgroups: 'ASPECT_REFINEMENTS',
  });
  if (!path) return { ok: false, reason: 'empty_query' };
  const r = await browse(base, path);
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status, reason: r.status === 503 ? 'ebay_unconfigured' : 'http_' + r.status };
  const dists = (r.json.refinement && r.json.refinement.aspectDistributions) || [];
  const aspects = dists.map((a) => {
    const values = (a.aspectValueDistributions || []).map((v) => ({ value: v.localizedAspectValue, count: v.matchCount }));
    const sum = values.reduce((n, v) => n + (v.count || 0), 0);
    const notSpec = values.filter((v) => v.value === 'Not specified').reduce((n, v) => n + (v.count || 0), 0);
    return {
      name: a.localizedAspectName,
      fill: sum ? Math.round(1000 * (sum - notSpec) / sum) / 10 : null,
      baked: ASPECT_FILL[a.localizedAspectName] || null,
      values: values.sort((x, y) => (y.count || 0) - (x.count || 0)).slice(0, 20),
    };
  }).sort((a, b) => (b.fill || 0) - (a.fill || 0));
  return { ok: true, total: r.json.total, trustFill: TRUST_FILL, aspects };
}

// Run one lane end to end: build the plan, count it, then hand the SAME Browse query to the real
// comps engine so the reported price is the one production would have arrived at.
export async function runLane(base, { id, identity, opts, excludeSeller }) {
  const plan = buildEbayQuery(identity, opts);
  const count = await countFor(base, plan);
  const browseQuery = browseSearchUrl(plan.browse.q, {
    limit: 200,
    categoryIds: plan.browse.category_ids,
    filter: plan.browse.filter,
    aspectFilter: plan.browse.aspect_filter,
  });
  let comps = { matched: false, reason: 'not_run' };
  if (count.total != null && count.total > 0) {
    _calls++;
    comps = await singlesEbayValue({
      base,
      query: plan.browse.q,
      browseQuery: browseQuery ? browseQuery.split('?')[1] : null,
      numberMatch: plan.filterHints.numberMatch,
      lang: plan.filterHints.lang,
      finish: plan.filterHints.finish,
      graded: plan.filterHints.graded,
      excludeSeller: excludeSeller || null,
      minComps: opts && opts.minComps != null ? opts.minComps : 4,
    });
  }
  return {
    id: id || plan.mode,
    mode: plan.mode,
    nkw: plan.nkw,
    nkwLength: plan.nkwLength,
    dropped: plan.core.dropped,
    warnings: plan.warnings,
    aspects: plan.aspects,
    browse: plan.browse,
    webUrl: searchUrl(plan.nkw, {
      category: plan.browse.category_ids || null,
      aspects: Object.keys(plan.aspects || {}).length ? plan.aspects : null,
      sort: (opts && opts.sort) || SOP.priceLow,
    }),
    total: count.total,
    countMs: count.ms,
    countReason: count.reason || null,
    // What the lane BOUGHT. `comparable` is the cluster the price was actually made from and is
    // the number to rank on; `total` is only context for it.
    comparable: comps.matched ? comps.comparable : 0,
    sampleSize: comps.sampleSize != null ? comps.sampleSize : null,
    recommended: comps.matched ? comps.recommended : null,
    fair: comps.matched ? comps.fair : null,
    confidence: comps.matched ? comps.confidence : null,
    reliable: comps.matched ? !!comps.reliable : false,
    reason: comps.matched ? null : comps.reason,
  };
}

// The fixed lane set. Named and stable so a comparison means the same thing between sessions.
export const LANES = [
  { id: 'production', label: 'Production (today)', opts: { mode: 'recall' } },
  { id: 'structured', label: 'Structured', opts: { mode: 'structured' } },
  { id: 'hybrid', label: 'Hybrid', opts: { mode: 'hybrid' } },
  { id: 'precision', label: 'Precision (Card Ladder)', opts: { mode: 'precision' } },
];

// Pull an identity off a real stock row, so lanes can be tested against cards actually held rather
// than against a hand-typed example that may not represent anything.
export function identityFromItem(row) {
  if (!row) return null;
  return {
    game: row.game || 'pokemon',
    name: row.name || '',
    number: row.number != null ? String(row.number) : '',
    setName: row.set_name || '',
    setCode: row.set_code || '',
    lang: ({ EN: 'en', JP: 'ja', JA: 'ja', ZH: 'zh-cn', CN: 'zh-cn', TW: 'zh-tw', KO: 'ko' })[String(row.language || 'EN').toUpperCase()] || 'en',
    finish: /non[\s-]?foil|non[\s-]?holo/i.test(String(row.finish || row.variant || '')) ? 'nonfoil'
      : /holo|foil|reverse|etched|rainbow/i.test(String(row.finish || row.variant || '')) ? 'foil' : null,
    condition: row.condition || '',
    graded: !!(row.graded || row.grading_company),
    company: row.grading_company || null,
    grade: row.grade != null ? row.grade : null,
  };
}

export function ebayTestbedPlugin(env) {
  return {
    name: 'ebay-testbed',
    configureServer(server) {
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = 'http://127.0.0.1:' + port;
      const excludeSeller = (env && env.EBAY_SELLER_USERNAME) || null;

      server.middlewares.use('/api/testbed', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const p = url.pathname.replace(/\/+$/, '') || '/';
          const method = req.method;
          if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type');
            return res.end();
          }

          // The vocabulary the page renders as checkboxes. Static, so it needs no eBay call and
          // works with credentials blanked.
          if (p === '/vocab' && method === 'GET') {
            return send(res, 200, {
              modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m, coreFields: m.coreFields === Infinity ? null : m.coreFields })),
              packs: Object.entries(PACKS).map(([id, x]) => ({ id, label: x.label, terms: x.terms })),
              graders: Object.entries(GRADERS).map(([code, g]) => ({ code, ...g, unsafeWhy: isUnsafeExclusion(code) })),
              aspectFill: ASPECT_FILL, trustFill: TRUST_FILL,
              categories: CATEGORY, cardConditions: CARD_CONDITION,
              graderValues: PROFESSIONAL_GRADER, gameAspects: GAME_ASPECT,
              lanes: LANES, sorts: SOP,
              calls: _calls, softCap: DAILY_SOFT_CAP,
            });
          }

          // Pure — builds the plan with no network at all, so the page can show the query string
          // and the ↗ link even when eBay is unreachable.
          if (p === '/plan' && method === 'POST') {
            const b = await readJsonBody(req);
            const plan = buildEbayQuery(b.identity || {}, b.opts || {});
            return send(res, 200, {
              ...plan,
              webUrl: searchUrl(plan.nkw, {
                category: plan.browse.category_ids || null,
                aspects: Object.keys(plan.aspects || {}).length ? plan.aspects : null,
                sort: (b.opts && b.opts.sort) || SOP.priceLow,
              }),
              browsePath: browseSearchUrl(plan.browse.q, {
                limit: 200, categoryIds: plan.browse.category_ids,
                filter: plan.browse.filter, aspectFilter: plan.browse.aspect_filter,
              }),
            });
          }

          if (p === '/count' && method === 'POST') {
            const b = await readJsonBody(req);
            const lanes = Array.isArray(b.lanes) && b.lanes.length ? b.lanes : LANES;
            const out = [];
            for (const lane of lanes) {
              const plan = buildEbayQuery(b.identity || {}, { ...(b.opts || {}), ...(lane.opts || {}) });
              const c = await countFor(base, plan);
              out.push({ id: lane.id, label: lane.label || lane.id, nkwLength: plan.nkwLength, nkw: plan.nkw, ...c });
            }
            return send(res, 200, { lanes: out, calls: _calls, softCap: DAILY_SOFT_CAP, overBudget: _calls > DAILY_SOFT_CAP });
          }

          if (p === '/ablate' && method === 'POST') {
            const b = await readJsonBody(req);
            return send(res, 200, { ...(await ablate(base, b.identity || {}, b.opts || {})), calls: _calls });
          }

          if (p === '/aspects' && method === 'GET') {
            return send(res, 200, await discoverAspects(base, {
              q: url.searchParams.get('q') || 'pokemon',
              category: url.searchParams.get('category') || CATEGORY.ccgSingles,
              aspectFilter: url.searchParams.get('aspect_filter') || null,
            }));
          }

          if (p === '/run' && method === 'POST') {
            const b = await readJsonBody(req);
            const lanes = Array.isArray(b.lanes) && b.lanes.length ? b.lanes : LANES;
            const out = [];
            for (const lane of lanes) {
              out.push({
                label: lane.label || lane.id,
                ...(await runLane(base, {
                  id: lane.id, identity: b.identity || {},
                  opts: { ...(b.opts || {}), ...(lane.opts || {}) },
                  excludeSeller,
                })),
              });
            }
            return send(res, 200, { lanes: out, calls: _calls, softCap: DAILY_SOFT_CAP, overBudget: _calls > DAILY_SOFT_CAP });
          }

          // Prefill from real stock.
          if (p === '/item' && method === 'GET') {
            const id = url.searchParams.get('id');
            const sku = url.searchParams.get('sku');
            if (!id && !sku) return send(res, 400, { error: 'pass ?id= or ?sku=' });
            const db = openDb();
            const row = id
              ? db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+id)
              : db.prepare('SELECT * FROM inventory_items WHERE sku = ? LIMIT 1').get(String(sku));
            if (!row) return send(res, 404, { error: 'not found' });
            return send(res, 200, { identity: identityFromItem(row), row: { id: row.id, sku: row.sku, title: row.name } });
          }

          if (p === '/recent' && method === 'GET') {
            const db = openDb();
            const rows = db.prepare(`SELECT id, sku, name, number, set_name, grading_company, grade
                                     FROM inventory_items ORDER BY id DESC LIMIT 40`).all();
            return send(res, 200, { items: rows });
          }

          return send(res, 404, { error: 'unknown endpoint', endpoints: ['/vocab', '/plan', '/count', '/ablate', '/aspects', '/run', '/item', '/recent'] });
        } catch (e) {
          // GR7: a bench that 500s tells you nothing about the thing you were measuring.
          console.error('[api/testbed]', (e && e.message) || e);
          return send(res, 200, { error: 'testbed_failed', detail: String((e && e.message) || e) });
        }
      });

      console.log('[testbed] API /api/testbed · page /ebay-testbed.html');
    },
  };
}
