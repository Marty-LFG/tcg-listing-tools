// lib/keepers.mjs — The Keepers, as a consumer of the shared Shopify receiver.
//
// This is the wiring: it owns the arming switches, records deliveries, drains them, and runs the
// projection. The decisions all live elsewhere and are tested there — keepers-ingest decides what an
// order is worth, keepers-levels and keepers-badges decide status, keepers-project decides what gets
// written. This file decides WHEN, and refuses when it should not.
//
// THREE SWITCHES, NOT ONE, and they are what make a real soak possible:
//
//   mode: 'off'      record deliveries and do nothing else
//   mode: 'observe'  re-read each order and write down what the ledger WOULD have said, appending
//                    nothing. This is how the numbers get hand-checked against real orders before a
//                    single ledger row exists.
//   mode: 'apply'    append to the ledger
//   project.enabled  whether the ledger may reach Shopify at all. Independent of mode, so the ledger
//                    can run against live traffic for a week while every customer still reads
//                    "not started yet" on the storefront.
//   project.allowLive a second, deliberate switch for the live store — the guardLiveStore shape.
//
// The eBay receiver earned its default on six measured deliveries. This one has no such history to
// lean on: its pattern's own soak turned out never to have happened (postsale.db holds zero
// notify_events, in the live DB and in backups from days after the claim was written). So the soak
// here is real work, not a formality.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configFile } from './config-paths.mjs';
import {
  registerConsumer, BUSINESS_TOPICS, startShopifyHooks, getShopifyHooksState, registerProxyHandler,
  loadConfig as loadHooksConfig,
} from './shopify-hooks.mjs';
import {
  openKeepersDb, upsertCustomer, forgetCustomer, withTransaction, appendEvent,
} from './keepers-db.mjs';
import { ingestOrder } from './keepers-ingest.mjs';
import { sweepOrders, driftReport } from './keepers-reconcile.mjs';
import { projectDirty, projectionQueueDepth } from './keepers-project.mjs';
import { loadKeepersConfig, cachedConfig, configProblem } from './keepers-config.mjs';
import { makeCheckinHandler, activeShow, nextShow } from './keepers-checkin.mjs';
import { grant, grantBadge, customerLedger, findCustomers } from './keepers-grants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_NAME = 'keepers.config.json';
const EXAMPLE_NAME = 'keepers.config.example.json';

export const MODES = ['off', 'observe', 'apply'];
// Deliberately small. The retry is a latency optimisation; the reconcile sweep is the correctness
// guarantee. Keeping those straight is what stops the retry budget from becoming load-bearing.
export const MAX_ATTEMPTS = 3;

// The topics The Keepers actually wants. Not the full business set — a topic nobody subscribes to is
// never registered with Shopify, which is the point of the union in shopify-hooks.
export const TOPICS = Object.freeze([
  'orders/paid', 'orders/updated', 'orders/cancelled', 'orders/edited',
  'refunds/create', 'customers/create', 'customers/update',
]);

export const DEFAULT_CONFIG = {
  mode: 'off',
  project: { enabled: false, allowLive: false },
  store: 'dev',
  config_ttl_sec: 900,
  drain_limit: 50,
  sweep_max_per_run: 500,
  project_limit: 50,
  retain_days: 30,
  // Show windows for the QR check-in. One printed QR forever; the SERVER infers which show is on
  // from the clock, because Liquid cannot read a query string (D-028) and a page per show would mean
  // reprinting the code every time.
  shows: [],
};

export function ensureConfigSeeded() {
  const live = configFile(CONFIG_NAME);
  if (fs.existsSync(live)) return;
  try {
    const seed = path.join(ROOT, 'data', EXAMPLE_NAME);
    if (fs.existsSync(seed)) { fs.copyFileSync(seed, live); return; }
  } catch { /* fall through */ }
  try { fs.writeFileSync(live, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n'); } catch { /* read-only fs */ }
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(CONFIG_NAME), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, project: { ...DEFAULT_CONFIG.project, ...(raw.project || {}) } };
  } catch { return { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project } }; }
}

/** The SETTINGS registry's validate(). Refusals, not warnings. */
export function validateKeepersConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'config must be an object';
  // An unrecognised mode is REFUSED, never treated as "not off". The failure mode of a typo must not
  // be a mode that silently does more than the person saving it believed.
  if (!MODES.includes(cfg.mode)) return `mode must be one of ${MODES.join('|')} (got ${JSON.stringify(cfg.mode)})`;
  if (!['dev', 'live'].includes(cfg.store)) return "store must be 'dev' or 'live'";
  if (cfg.project?.enabled && cfg.store === 'live' && !cfg.project?.allowLive) {
    return 'project.enabled with store=live also needs project.allowLive — writing customer metafields '
      + 'on the live store is a separate decision from turning the projection on';
  }
  // Projecting from a ledger that is not being written is a guaranteed-stale storefront: the numbers
  // would freeze at whatever the last apply run produced and never move again.
  if (cfg.project?.enabled && cfg.mode !== 'apply') {
    return `project.enabled with mode='${cfg.mode}' would publish a ledger nothing is writing to — `
      + "set mode to 'apply' first, or turn the projection off";
  }
  if (cfg.shows !== undefined && !Array.isArray(cfg.shows)) return 'shows must be an array';
  for (const s of (cfg.shows || [])) {
    if (!s?.slug) return 'every show needs a slug';
    // An unparseable window would make the show unusable rather than always-on, but a typo should be
    // caught when it is saved rather than discovered by a customer at a table.
    if (!Number.isFinite(Date.parse(s.starts_at)) || !Number.isFinite(Date.parse(s.ends_at))) {
      return `show '${s.slug}' has an unreadable starts_at/ends_at — use an ISO timestamp`;
    }
    if (Date.parse(s.ends_at) <= Date.parse(s.starts_at)) return `show '${s.slug}' ends before it starts`;
  }
  for (const k of ['config_ttl_sec', 'drain_limit', 'sweep_max_per_run', 'project_limit', 'retain_days']) {
    const v = Number(cfg[k]);
    if (!Number.isFinite(v) || v <= 0) return `${k} must be a positive number`;
  }
  return null;
}

// --- the consumer ---

/**
 * recordDelivery — runs INSIDE the request, before the ack, and throws if it could not store.
 *
 * A throw here becomes a 503 from the receiver, which is the whole contract: Shopify retries a 5xx
 * for 48 hours, and acking something nobody stored loses it for good.
 */
export function recordDelivery(db, event) {
  const action = actionFor(event.topic);
  const info = db.prepare(`
    INSERT INTO keepers_webhooks (webhook_id, topic, shop_domain, api_version, triggered_at, ref_id, status, action, payload)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(webhook_id) DO NOTHING
  `).run(
    event.webhookId, event.topic, event.shopDomain || null, event.apiVersion || null,
    event.triggeredAt || null, refIdFor(event),
    action ? 'received' : 'ignored', action,
    event.raw ? String(event.raw).slice(0, 64 * 1024) : null,
  );
  return { stored: Number(info.changes) > 0 };
}

export function actionFor(topic) {
  const t = String(topic || '');
  if (t.startsWith('orders/') || t === 'refunds/create') return 'order_by_id';
  if (t === 'customers/create' || t === 'customers/update') return 'customer_by_id';
  if (t === 'customers/redact') return 'redact';
  if (t === 'customers/data_request') return 'data_request';
  if (t === 'shop/redact') return 'redact_shop';
  return null;
}

/** Best-effort subject id. Never used to drive anything — the handler re-reads by id. */
export function refIdFor(event) {
  const d = event?.body || {};
  const t = String(event?.topic || '');
  if (t === 'refunds/create') return d.order_id ? `gid://shopify/Order/${d.order_id}` : null;
  if (t.startsWith('orders/')) return d.admin_graphql_api_id || (d.id ? `gid://shopify/Order/${d.id}` : null);
  if (t.startsWith('customers/')) return d.admin_graphql_api_id || (d.id ? `gid://shopify/Customer/${d.id}` : null);
  return null;
}

/**
 * drainWebhooks — work the queue.
 *
 * Every order topic re-reads the order by id and derives state from scratch, so the ORDER these are
 * processed in does not matter. That is what makes unordered at-least-once delivery survivable, and
 * it is why there is no attempt to sort by triggered_at here.
 */
export async function drainWebhooks(env, db, { cfg, rules, store, limit = 50, nowMs = Date.now(), knownCodes = [], codePrefix = '' } = {}) {
  const now = new Date(nowMs).toISOString();
  const due = db.prepare(`
    SELECT webhook_id, topic, ref_id, action, attempt FROM keepers_webhooks
    WHERE status = 'received' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY received_at LIMIT ?
  `).all(now, limit);

  const observeOnly = cfg.mode === 'observe';
  let handled = 0; let failed = 0; let skipped = 0;

  for (const w of due) {
    let out = null; let error = null;
    try {
      if (w.action === 'order_by_id' && w.ref_id) {
        out = await ingestOrder(env, db, w.ref_id, { rules, store, knownCodes, codePrefix, observeOnly });
        if (!out.ok) error = out.error;
      } else if (w.action === 'customer_by_id' && w.ref_id) {
        if (!observeOnly) withTransaction(db, () => { upsertCustomer(db, { customerGid: w.ref_id }); });
        out = { ok: true, customerGid: w.ref_id };
      } else if (w.action === 'redact' && w.ref_id) {
        // Written, not stubbed. The events survive with their owner removed, so the aggregate history
        // still reconciles while the person is no longer in it.
        if (!observeOnly) withTransaction(db, () => { out = forgetCustomer(db, w.ref_id); });
        else out = { observed: true };
      } else if (w.action === 'data_request' || w.action === 'redact_shop') {
        // Recorded and acknowledged; acting on these is a human obligation, not an automatic one.
        out = { ok: true, noted: w.action };
      } else {
        skipped++;
        db.prepare("UPDATE keepers_webhooks SET status='skipped', handled_at=?, action=? WHERE webhook_id=?")
          .run(now, w.action, w.webhook_id);
        continue;
      }
    } catch (e) { error = String(e?.message || e); }

    if (!error) {
      handled++;
      db.prepare(`
        UPDATE keepers_webhooks SET status=?, handled_at=?, observation=?, error=NULL WHERE webhook_id=?
      `).run(observeOnly ? 'skipped' : 'handled', now, JSON.stringify(out ?? null).slice(0, 8192), w.webhook_id);
    } else {
      failed++;
      const attempt = Number(w.attempt || 0) + 1;
      const settled = attempt >= MAX_ATTEMPTS;
      db.prepare(`
        UPDATE keepers_webhooks SET status=?, attempt=?, next_attempt_at=?, error=? WHERE webhook_id=?
      `).run(
        // Once the budget is spent the row settles as failed and the SWEEP picks the order up. The
        // retry never has to be the thing that saves us.
        settled ? 'failed' : 'received', attempt,
        settled ? null : new Date(nowMs + 30000 * attempt).toISOString(),
        String(error).slice(0, 500), w.webhook_id,
      );
    }
  }
  return { due: due.length, handled, failed, skipped, observeOnly };
}

/**
 * runKeepersPass — the consumer's schedule(). Called after the ack, debounced by the receiver.
 */
export async function runKeepersPass(env, db, { trigger = 'schedule', nowMs = Date.now() } = {}) {
  const cfg = loadConfig();
  const problem = validateKeepersConfig(cfg);
  if (problem) return { ok: false, error: 'config_invalid', detail: problem };
  if (cfg.mode === 'off') return { ok: true, skipped: 'mode_off' };

  const conf = await loadKeepersConfig(env, db, { store: cfg.store, ttlSec: cfg.config_ttl_sec, nowMs });
  const confProblem = configProblem(conf);
  if (confProblem) {
    // Fail closed: no usable economy means no accrual, not a guessed one.
    return { ok: false, error: 'economy_unusable', detail: confProblem, configSource: conf?.source || 'none' };
  }

  const drained = await drainWebhooks(env, db, {
    cfg, rules: conf.rules, store: cfg.store, limit: cfg.drain_limit, nowMs,
    codePrefix: conf.rules.redemption_code_prefix || '',
  });

  let projected = null;
  if (cfg.project?.enabled && cfg.mode === 'apply') {
    projected = await projectDirty(env, db, {
      rankTable: conf.ranks, badges: conf.badges, rules: conf.rules,
      store: cfg.store, limit: cfg.project_limit, nowMs, allowLive: cfg.project.allowLive,
    });
  }

  return {
    ok: true, trigger, mode: cfg.mode,
    configSource: conf.source,
    drained, projected,
    queueDepth: projectionQueueDepth(db),
  };
}

/** The slow, authoritative loop. Runs on a timer, not on a webhook. */
export async function runKeepersSweep(env, db, { nowMs = Date.now() } = {}) {
  const cfg = loadConfig();
  const problem = validateKeepersConfig(cfg);
  if (problem) return { ok: false, error: 'config_invalid', detail: problem };
  if (cfg.mode === 'off') return { ok: true, skipped: 'mode_off' };

  const conf = await loadKeepersConfig(env, db, { store: cfg.store, ttlSec: cfg.config_ttl_sec, nowMs });
  const confProblem = configProblem(conf);
  if (confProblem) return { ok: false, error: 'economy_unusable', detail: confProblem };

  const swept = await sweepOrders(env, db, {
    rules: conf.rules, store: cfg.store, maxPerRun: cfg.sweep_max_per_run, nowMs,
    observeOnly: cfg.mode === 'observe', codePrefix: conf.rules.redemption_code_prefix || '',
  });
  return { ok: swept.ok, swept, drift: driftReport(db).counts, configSource: conf.source };
}

/** Register with the shared receiver. Idempotent by name, so a settings restart cannot double up. */
export function registerKeepersConsumer(env) {
  const unknown = TOPICS.filter((t) => !BUSINESS_TOPICS.includes(t));
  if (unknown.length) throw new Error(`keepers: topics not known to the receiver: ${unknown.join(', ')}`);
  return registerConsumer({
    name: 'keepers',
    topics: [...TOPICS],
    record: (event) => recordDelivery(openKeepersDb(), event),
    schedule: ({ trigger }) => runKeepersPass(env, openKeepersDb(), { trigger }),
  });
}

// --- jobs ---
//
// setInterval singletons parked on globalThis, stop-then-start, always .unref()'d — the shape
// startPostsaleJobs uses. The sweep is the correctness guarantee, so it runs on its own timer rather
// than only when a webhook happens to arrive: an engine that only reconciles when something is
// delivered cannot recover from nothing being delivered.
export function stopKeepersJobs() {
  for (const k of ['__keepersSweepTimer', '__keepersProjectTimer']) {
    if (globalThis[k]) { clearInterval(globalThis[k]); globalThis[k] = null; }
  }
}

export function startKeepersJobs(env, { sweepMin = 30, projectMin = 5 } = {}) {
  stopKeepersJobs();
  const cfg = loadConfig();
  if (cfg.mode === 'off') return { started: false, reason: 'mode_off' };

  const sweep = setInterval(() => {
    runKeepersSweep(env, openKeepersDb()).catch((e) => console.warn('[keepers] sweep failed —', e?.message || e));
  }, Math.max(60_000, sweepMin * 60_000));
  if (sweep.unref) sweep.unref();
  globalThis.__keepersSweepTimer = sweep;

  const project = setInterval(() => {
    runKeepersPass(env, openKeepersDb(), { trigger: 'timer' }).catch((e) => console.warn('[keepers] pass failed —', e?.message || e));
  }, Math.max(60_000, projectMin * 60_000));
  if (project.unref) project.unref();
  globalThis.__keepersProjectTimer = project;

  return { started: true, sweepMin, projectMin };
}

// The DIAG_TOKEN gate, INLINED rather than imported — lib/status.mjs imports this module for its
// jobs panel, and importing it back would be a cycle. ebay-notify.mjs does the same, and says so.
function diagOk(env, req, url) {
  const want = env.DIAG_TOKEN || process.env.DIAG_TOKEN;
  if (!want) return false;                       // unset means closed, not open
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const given = bearer || url.searchParams.get('token') || '';
  if (!given || given.length !== want.length) return false;
  try {
    const a = Buffer.from(given); const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/**
 * keepersPlugin — the Vite plugin. Registers the consumer, starts the shared receiver, arms the jobs,
 * and serves /api/keepers.
 *
 * Registration happens BEFORE the receiver starts, so its startup line names the consumers it has
 * rather than an empty list.
 */
export function keepersPlugin(env) {
  return {
    name: 'keepers',
    configureServer(server) {
      try { registerKeepersConsumer(env); }
      catch (e) { console.error('[keepers] could not register the consumer —', e?.message || e); }
      try { startShopifyHooks(env); }
      catch (e) { console.error('[keepers] could not start the receiver —', e?.message || e); }
      // The check-in reads its rates from the ECONOMY metaobject and its show windows from the local
      // config: the rates belong to both halves of the programme, the show calendar belongs to this box.
      try {
        registerProxyHandler(makeCheckinHandler(async () => {
          const cfg = loadConfig();
          const conf = await loadKeepersConfig(env, openKeepersDb(), { store: cfg.store, ttlSec: cfg.config_ttl_sec });
          return { rules: conf?.rules || {}, shows: cfg.shows || [] };
        }));
      } catch (e) { console.error('[keepers] could not register the check-in handler —', e?.message || e); }
      try { startKeepersJobs(env); }
      catch (e) { console.error('[keepers] could not arm the jobs —', e?.message || e); }

      server.middlewares.use('/api/keepers', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const send = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
        const db = () => openKeepersDb();

        if (p === '/state' && req.method === 'GET') {
          return send(200, { ...getKeepersEngineState(db()), receiver: getShopifyHooksState() });
        }
        if (p === '/config' && req.method === 'GET') {
          const cfg = loadConfig();
          return send(200, {
            config: cfg,
            problem: validateKeepersConfig(cfg),
            economy: cachedConfig(db()),
            topics: TOPICS,
          });
        }
        if (p === '/drift' && req.method === 'GET') return send(200, driftReport(db()));

        // --- the admin's customer view ---

        if (p === '/customers' && req.method === 'GET') {
          return send(200, { rows: findCustomers(db(), url.searchParams.get('q') || '') });
        }
        if (p.startsWith('/customers/') && req.method === 'GET') {
          const gid = decodeURIComponent(p.slice('/customers/'.length));
          const l = customerLedger(db(), gid);
          return l ? send(200, l) : send(404, { error: 'unknown customer' });
        }

        // --- granting by hand ---
        //
        // Gated, and the idempotency key is the CALLER'S to supply. Minting one here would make every
        // retry a fresh grant, which is the exact failure the key exists to prevent.
        if ((p === '/grant' || p === '/grant-badge') && req.method === 'POST') {
          if (!diagOk(env, req, url)) return send(403, { error: 'diag token required' });
          const body = await readJsonBody(req);
          if (!body) return send(400, { error: 'expected a JSON body' });
          try {
            let out;
            const d = db();
            withTransaction(d, () => {
              out = p === '/grant' ? grant(d, { ...body, nowMs: Date.now() }) : grantBadge(d, body);
            });
            return send(out.ok ? 200 : 400, out);
          } catch (e) { return send(500, { error: String(e?.message || e) }); }
        }

        // A loopback round-trip against our own receiver with a self-signed HMAC. Proves it is bound,
        // routing and verifying — without touching Shopify.
        //
        // 503 when it is down, NEVER 404: lib/status.mjs classifies a 404 as ok, so a dead listener
        // would paint green on the dashboard.
        if (p === '/self-test' && req.method === 'GET') {
          const st = getShopifyHooksState();
          if (!st.listening) return send(503, { ok: false, error: 'not_listening', bind_error: st.bind_error });
          const hooksCfg = loadHooksConfig();
          const secret = env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
          const body = JSON.stringify({ self_test: true, at: new Date().toISOString() });
          const hmac = crypto.createHmac('sha256', String(secret || '')).update(body).digest('base64');
          try {
            const r = await fetch(`http://${hooksCfg.listen_host}:${hooksCfg.listen_port}${hooksCfg.webhook_path}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-shopify-hmac-sha256': hmac,
                'x-shopify-topic': 'orders/updated',
                'x-shopify-shop-domain': hooksCfg.expect_shop_domain,
                'x-shopify-webhook-id': 'self-test-' + Math.random().toString(36).slice(2, 10),
                'x-shopify-triggered-at': new Date().toISOString(),
              },
              body,
            });
            // 200 proves the whole chain: bound, routed, HMAC verified, shop matched, consumer stored.
            return send(r.status === 200 ? 200 : 503, { ok: r.status === 200, http: r.status });
          } catch (e) { return send(503, { ok: false, error: String(e?.message || e) }); }
        }

        // Mutating routes are gated, and DRY-RUN BY DEFAULT. A repair that runs as a side effect of
        // someone opening a page is the wrong shape — ebay-notify's reconcile makes the same choice.
        if (p === '/sweep' && req.method === 'POST') {
          if (!diagOk(env, req, url)) return send(403, { error: 'diag token required' });
          const apply = url.searchParams.get('apply') === '1';
          try { return send(200, await runKeepersSweep(env, db(), { apply })); }
          catch (e) { return send(500, { error: String(e?.message || e) }); }
        }
        if (p === '/pass' && req.method === 'POST') {
          if (!diagOk(env, req, url)) return send(403, { error: 'diag token required' });
          try { return send(200, await runKeepersPass(env, db(), { trigger: 'manual' })); }
          catch (e) { return send(500, { error: String(e?.message || e) }); }
        }

        // The soak table: what the ledger WOULD have said, per delivery, without having said it.
        if (p === '/observations' && req.method === 'GET') {
          const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
          try {
            const rows = db().prepare(`
              SELECT webhook_id, topic, ref_id, received_at, status, observation
              FROM keepers_webhooks WHERE observation IS NOT NULL
              ORDER BY received_at DESC LIMIT ?
            `).all(limit);
            return send(200, { rows: rows.map((r) => ({ ...r, observation: safeJson(r.observation) })) });
          } catch (e) { return send(503, { error: String(e?.message || e) }); }
        }

        // The NEGATIVE test for invariant 5: any product carrying keepers.min_level while no
        // server-side enforcement exists. Should be empty, and loudly non-empty the day it is not.
        if (p === '/gate-audit' && req.method === 'GET') {
          try {
            const { shopifyGraphQL } = await import('./channels/shopify-admin.mjs');
            const cfg = loadConfig();
            const q = `query { products(first: 250, query: "metafield:keepers.min_level:*") { nodes { id title } } }`;
            const r = await shopifyGraphQL(env, q, {}, { store: cfg.store });
            const nodes = r.ok ? (r.data?.products?.nodes || []) : null;
            return send(200, {
              ok: r.ok,
              gated: nodes,
              count: nodes ? nodes.length : null,
              invariant: 'no rank-gated product may exist in a purchasable state until server-side enforcement is live (D-021)',
            });
          } catch (e) { return send(503, { error: String(e?.message || e) }); }
        }

        return send(404, { error: 'unknown route' });
      });
    },
  };
}

// Small and local: the admin routes are the only place in this module that reads a request body, and
// unlike the webhook path there is no signature over the bytes, so a JSON parse is all it needs.
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return s; } };

/** For /api/status. */
export function getKeepersEngineState(db) {
  const cfg = loadConfig();
  const conf = cachedConfig(db);
  const counts = db.prepare(`
    SELECT status, COUNT(*) n FROM keepers_webhooks GROUP BY status
  `).all().reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  return {
    mode: cfg.mode,
    store: cfg.store,
    project: { enabled: Boolean(cfg.project?.enabled), allowLive: Boolean(cfg.project?.allowLive) },
    config_problem: validateKeepersConfig(cfg),
    economy: conf ? { source: conf.source, fetchedAt: conf.fetchedAt, problem: configProblem(conf) } : null,
    webhooks: counts,
    queue_depth: projectionQueueDepth(db),
    drift: driftReport(db).counts,
  };
}
