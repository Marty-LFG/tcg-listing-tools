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
import { fileURLToPath } from 'node:url';
import { configFile } from './config-paths.mjs';
import { registerConsumer, BUSINESS_TOPICS } from './shopify-hooks.mjs';
import {
  openKeepersDb, upsertCustomer, forgetCustomer, withTransaction, appendEvent,
} from './keepers-db.mjs';
import { ingestOrder } from './keepers-ingest.mjs';
import { sweepOrders, driftReport } from './keepers-reconcile.mjs';
import { projectDirty, projectionQueueDepth } from './keepers-project.mjs';
import { loadKeepersConfig, cachedConfig, configProblem } from './keepers-config.mjs';

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
