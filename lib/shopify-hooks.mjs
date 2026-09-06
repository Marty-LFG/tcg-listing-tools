// lib/shopify-hooks.mjs — THE Shopify ingress for this store. One loopback server, one tunnel route,
// one HMAC verifier, one webhook subscription set. Consumers register against it.
//
// This is S7 in docs/SHOPIFY_CHANNEL_PLAN.md, generalised. S7 specified a receiver on :5275 for stock
// decrements; the Keepers engine needs the same server for the same store on the same port. Two
// receivers would mean two tunnel routes, two verifiers, and two subscription sets both receiving
// orders/paid while each believed it owned it. So there is one receiver and consumers plug into it:
// `keepers` today, `stock` when S7's decrement half is built.
//
// A SEPARATE node:http SERVER, ITS OWN PORT, EXACTLY THREE PATHS, BARE 404 ON EVERYTHING ELSE. Not a
// route on the Vite dev server. The reasoning is lib/ebay-notify.mjs's, unchanged: the dev server is
// LAN-bound and documented as never-expose-this, and a tunnel that can only reach three paths on a
// port serving nothing else cannot be misconfigured into reaching /api/inventory. The tunnel's own
// ingress carries the same rule from the other end, with a catch-all 404 — see
// scripts/EBAY_NOTIFICATIONS.md, which is the runbook this follows.
//
// PERSIST -> ACK -> WORK. Shopify wants a 2xx within 5 seconds and retries for 48 hours otherwise, so
// the response goes out before any downstream work. A consumer that could not record is a 503, never
// a silent 200: acking something nobody stored loses it for good.
//
// WHERE DEDUPE LIVES, AND WHY IT IS NOT HERE. This module does not keep a webhook log of its own.
// Delivery is at-least-once by design, so every consumer has to be idempotent anyway — the Keepers
// ledger is idempotent in its schema (uq_kev_source), not because anything upstream promised
// uniqueness. Making the receiver the deduper would add a third database, and would let a consumer
// quietly depend on a guarantee that the reconcile sweep is deliberately built not to need.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile } from './config-paths.mjs';
import {
  verifyWebhookHmac, readWebhookHeaders, secretProblem, shopDomainProblem,
} from './shopify-hooks-verify.mjs';
import {
  verifyProxySignature, timestampProblem, loggedInCustomerGid, pathPrefixProblem,
} from './keepers-proxy-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_NAME = 'shopify-hooks.config.json';
const EXAMPLE_NAME = 'shopify-hooks.config.example.json';
const MAX_BODY_BYTES = 256 * 1024;

// The store-wide topic set. A consumer subscribes to a subset; the union of those subsets is what the
// subscription-reconciliation job registers with Shopify, so a topic nobody wants is never subscribed
// and a topic two consumers want is subscribed once.
export const BUSINESS_TOPICS = Object.freeze([
  'orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled', 'orders/edited',
  'refunds/create', 'customers/create', 'customers/update', 'app/uninstalled',
]);
// Mandatory for the app, handled on their own path so a GDPR callback can never be mistaken for a
// business event.
export const COMPLIANCE_TOPICS = Object.freeze(['customers/data_request', 'customers/redact', 'shop/redact']);
export const KNOWN_TOPICS = Object.freeze([...BUSINESS_TOPICS, ...COMPLIANCE_TOPICS]);

export const DEFAULT_CONFIG = {
  enabled: false,
  listen_host: '127.0.0.1',
  listen_port: 5275,
  // The runbook puts cloudflared on ALCSERVER alongside the app, so loopback is correct and this stays
  // false. It exists for the topology where the connector is on a different machine — which needs a
  // deliberate decision with the tunnel layout in front of you, not a quietly relaxed default.
  allow_lan_bind: false,
  webhook_path: '/shopify/keepers',
  compliance_path: '/shopify/compliance',
  proxy_path: '/apps/keepers',
  public_endpoint: '',
  shop: 'dev',                    // which store this listener belongs to: dev | live
  expect_shop_domain: '',         // e.g. binders-keepers-dev.myshopify.com — checked on every delivery
  proxy_prefix: '/apps/keepers',  // diagnosis only; a merchant may rename the subpath per store
  proxy_max_age_sec: 120,
  // The debounced coalescing worker. Five customers checking out at once should cost one batch of
  // Admin API reads, not five. quiet_ms is the floor, max_wait_ms the ceiling, min_gap_ms the spend
  // rate limit.
  dispatch: { quiet_ms: 5000, max_wait_ms: 60000, min_gap_ms: 5000 },
};

export function ensureConfigSeeded() {
  const live = configFile(CONFIG_NAME);
  if (fs.existsSync(live)) return;
  try {
    const seed = path.join(ROOT, 'data', EXAMPLE_NAME);
    if (fs.existsSync(seed)) { fs.copyFileSync(seed, live); return; }
  } catch { /* fall through to the built-in default */ }
  try { fs.writeFileSync(live, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n'); } catch { /* read-only fs */ }
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(CONFIG_NAME), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, dispatch: { ...DEFAULT_CONFIG.dispatch, ...(raw.dispatch || {}) } };
  } catch { return { ...DEFAULT_CONFIG, dispatch: { ...DEFAULT_CONFIG.dispatch } }; }
}

/**
 * validateShopifyHooksConfig — THE SAFETY BOUNDARY, expressed as refusals.
 *
 * The shape lib/status.mjs's SETTINGS registry expects: a human-readable problem string, or null.
 * Every rule prevents something specific; none is hypothetical.
 */
export function validateShopifyHooksConfig(cfg, { vitePort = 5273, ebayPort = 5274 } = {}) {
  if (!cfg || typeof cfg !== 'object') return 'config must be an object';

  const host = String(cfg.listen_host || '');
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!host) return 'listen_host is required';
  if (!loopback && !cfg.allow_lan_bind) {
    return `listen_host ${host} is not loopback — the tunnel is the only ingress. If the connector `
      + 'genuinely runs on another machine, set allow_lan_bind: true deliberately and make sure the '
      + 'tunnel ingress is path-scoped with a catch-all 404.';
  }
  if (host === '0.0.0.0') {
    // Even with the opt-in: every interface is broader than the one the tunnel needs, and "it worked"
    // is indistinguishable from "it is now on the guest wifi".
    return 'listen_host 0.0.0.0 binds every interface — name the specific address instead';
  }

  const port = Number(cfg.listen_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'listen_port must be a port number';
  if (port === vitePort) return `listen_port ${port} is the Vite dev server — a separate port is what keeps /api/* unreachable from the tunnel`;
  if (port === ebayPort) return `listen_port ${port} is the eBay notify listener`;

  for (const k of ['webhook_path', 'compliance_path', 'proxy_path']) {
    const p = String(cfg[k] || '');
    if (!p.startsWith('/')) return `${k} must start with /`;
    if (p === '/' || p.startsWith('/api')) return `${k} must not be / or under /api`;
  }
  const paths = [cfg.webhook_path, cfg.compliance_path, cfg.proxy_path];
  if (new Set(paths).size !== paths.length) return 'webhook_path, compliance_path and proxy_path must differ';

  for (const k of ['quiet_ms', 'max_wait_ms', 'min_gap_ms']) {
    const v = cfg.dispatch?.[k];
    if (!Number.isFinite(Number(v)) || Number(v) < 0) return `dispatch.${k} must be a non-negative number`;
  }
  if (Number(cfg.dispatch.max_wait_ms) < Number(cfg.dispatch.quiet_ms)) {
    return 'dispatch.max_wait_ms must be at least dispatch.quiet_ms — the ceiling cannot be below the floor';
  }

  if (!['dev', 'live'].includes(cfg.shop)) return "shop must be 'dev' or 'live'";
  if (cfg.enabled && !cfg.expect_shop_domain) {
    // Without it, a delivery from any other store this app is installed on verifies perfectly and is
    // handed to every consumer as if it were ours.
    return 'expect_shop_domain is required when enabled — a valid signature proves Shopify sent it, not that it is our shop';
  }
  return null;
}

// --- consumers ---
//
// A consumer is { name, topics, record(event) -> {stored}, schedule?() }.
//
//   topics    which deliveries it wants. The union drives the subscription set.
//   record    called INSIDE the request, before the ack. Must be fast and must throw if it could not
//             store — a throw becomes a 503 so Shopify retries, which is the whole point.
//   schedule  called AFTER the ack, debounced. Where the slow work goes.
//
// Registration is idempotent by name so a settings-triggered restart cannot double-register.
const _consumers = new Map();

export function registerConsumer(consumer) {
  const name = String(consumer?.name || '').trim();
  if (!name) throw new Error('shopify-hooks: a consumer needs a name');
  if (typeof consumer.record !== 'function') throw new Error(`shopify-hooks: consumer ${name} needs a record()`);
  const topics = Array.isArray(consumer.topics) ? consumer.topics : [];
  const unknown = topics.filter((t) => !KNOWN_TOPICS.includes(t));
  // A typo'd topic would otherwise be a consumer that silently never fires, and nothing anywhere
  // would say so.
  if (unknown.length) throw new Error(`shopify-hooks: consumer ${name} wants unknown topics: ${unknown.join(', ')}`);
  _consumers.set(name, { ...consumer, name, topics });
  return () => _consumers.delete(name);
}

export function registeredConsumers() {
  return [..._consumers.values()].map((c) => ({ name: c.name, topics: c.topics }));
}

/** The union of every consumer's topics — what the subscription-reconciliation job should register. */
export function subscribedTopics() {
  const s = new Set(COMPLIANCE_TOPICS);
  for (const c of _consumers.values()) for (const t of c.topics) s.add(t);
  return [...s].sort();
}

let _proxyHandler = null;
export function registerProxyHandler(fn) { _proxyHandler = typeof fn === 'function' ? fn : null; }

// --- state surfaced at /api/status ---

let _state = {
  listening: false, host: null, port: null, bind_error: null, started_at: null,
  received: 0, unwanted: 0, sig_failures: 0, proxy_calls: 0, proxy_refusals: 0,
  last_event: null, last_refusal: null,
};

export function getShopifyHooksState() {
  const cfg = loadConfig();
  return {
    enabled: cfg.enabled !== false,
    listening: _state.listening,
    host: _state.host, port: _state.port,
    lan_bind: Boolean(_state.host && _state.host !== '127.0.0.1' && _state.host !== '::1'),
    public_endpoint: cfg.public_endpoint || null,
    shop: cfg.shop, expect_shop_domain: cfg.expect_shop_domain || null,
    bind_error: _state.bind_error, started_at: _state.started_at,
    received: _state.received, unwanted: _state.unwanted, sig_failures: _state.sig_failures,
    proxy_calls: _state.proxy_calls, proxy_refusals: _state.proxy_refusals,
    last_event: _state.last_event, last_refusal: _state.last_refusal,
    consumers: registeredConsumers(),
    topics: subscribedTopics(),
    dispatch: { pending: Boolean(_d.timer), in_flight: Boolean(_d.inFlight), runs: _d.runs, last_run: _d.last_run },
  };
}

// A public endpoint's noise must not become the log. First five, then every fiftieth.
let _rejects = 0;
function logRejection(what, reason, extra = '') {
  _rejects++;
  if (_rejects <= 5 || _rejects % 50 === 0) {
    console.warn(`[shopify-hooks] rejected ${what}: ${reason}${extra ? ' — ' + extra : ''} (${_rejects} so far)`);
  }
}

// --- the listener ---

// The signature is over the exact bytes Shopify sent, so the body must never meet a JSON parser
// first. lib/req-body.mjs is deliberately not used: it discards the raw buffer.
function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0; let done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > limit) { done = true; reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

const endNoBody = (res, code) => { res.statusCode = code; res.end(); };
const endJson = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  // Passes through Cloudflare and Shopify; nothing here should ever be cached.
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
};

// --- dispatch (the debounced coalescing worker) ---

let _d = { timer: null, inFlight: null, firstAt: 0, lastAt: 0, lastRunAt: 0, runs: 0, last_run: null };

async function runDispatch({ trigger = 'schedule' } = {}) {
  const due = [..._consumers.values()].filter((c) => typeof c.schedule === 'function');
  if (!due.length) return { ok: true, skipped: 'no_consumers' };
  // One pass at a time. Two overlapping runs would read the same rows and spend the same API calls
  // twice — and, once a projection is armed, would be two writers for one customer.
  if (_d.inFlight) return _d.inFlight;
  const run = (async () => {
    const started = new Date();
    const results = {};
    try {
      for (const c of due) {
        // One consumer's failure must not stop the others: they are independent subsystems that
        // happen to share a doorway.
        try { results[c.name] = await c.schedule({ trigger }); }
        catch (e) { results[c.name] = { ok: false, error: String(e?.message || e) }; }
      }
      _d.last_run = { at: started.toISOString(), trigger, results };
      return _d.last_run;
    } finally { _d.inFlight = null; _d.lastRunAt = Date.now(); _d.runs++; }
  })();
  _d.inFlight = run;
  return run;
}

export function scheduleDispatch() {
  const cfg = loadConfig();
  const k = cfg.dispatch || DEFAULT_CONFIG.dispatch;
  const quiet = Math.max(250, Number(k.quiet_ms) || 5000);
  const maxWait = Math.max(quiet, Number(k.max_wait_ms) || 60000);
  const minGap = Math.max(0, Number(k.min_gap_ms) || 0);

  _d.lastAt = Date.now();
  if (!_d.timer) _d.firstAt = _d.lastAt;
  const waited = _d.lastAt - _d.firstAt;
  const sinceRun = Date.now() - _d.lastRunAt;
  const delay = Math.max(
    waited >= maxWait ? 0 : Math.min(quiet, maxWait - waited),
    minGap - sinceRun,
  );
  clearTimeout(_d.timer);
  _d.timer = setTimeout(() => {
    _d.timer = null;
    runDispatch({ trigger: 'webhook' }).catch((e) => console.warn('[shopify-hooks] dispatch failed —', e?.message || e));
  }, Math.max(0, delay));
  if (_d.timer.unref) _d.timer.unref();
}

// --- request handling ---

async function handleWebhook(env, req, res, cfg, isCompliance) {
  if (req.method !== 'POST') return endNoBody(res, 405);

  let raw;
  try { raw = await readRawBody(req); } catch { return endNoBody(res, 400); }

  const h = readWebhookHeaders(req.headers);
  const secret = env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET;

  const v = verifyWebhookHmac(secret, raw, h.hmac);
  if (!v.ok) {
    _state.sig_failures++;
    _state.last_refusal = { at: new Date().toISOString(), what: 'webhook', reason: v.reason };
    logRejection('webhook', v.reason, h.topic || '');
    return endNoBody(res, 401);
  }

  // A valid signature proves SHOPIFY sent it. It does not prove it is OUR shop: the same app on any
  // other store signs with the same secret.
  const shopProblem = shopDomainProblem(h.shopDomain, cfg.expect_shop_domain);
  if (shopProblem) {
    _state.sig_failures++;
    logRejection('webhook', 'wrong_shop', shopProblem);
    return endNoBody(res, 401);
  }

  if (!h.webhookId) { logRejection('webhook', 'no_webhook_id', h.topic || ''); return endNoBody(res, 400); }
  if (!h.topic) { logRejection('webhook', 'no_topic'); return endNoBody(res, 400); }

  // A compliance topic on the business path, or the reverse, means something is misconfigured. Say so
  // rather than half-handling it.
  const compliance = COMPLIANCE_TOPICS.includes(h.topic);
  if (compliance !== isCompliance) {
    logRejection('webhook', 'wrong_path_for_topic', h.topic);
    return endNoBody(res, 400);
  }

  let body = null;
  try { body = JSON.parse(raw.toString('utf8')); } catch { /* a body we cannot parse is still offered */ }

  const event = {
    webhookId: h.webhookId, topic: h.topic, shopDomain: h.shopDomain,
    apiVersion: h.apiVersion, triggeredAt: h.triggeredAt, body, raw: raw.toString('utf8'),
    compliance,
  };

  // Compliance topics go to EVERY consumer regardless of subscription: a redaction request is not
  // something a consumer gets to opt out of.
  const wanted = [..._consumers.values()].filter((c) => compliance || c.topics.includes(h.topic));
  if (!wanted.length) {
    // Nobody wants it. Record the fact and ack — an unrequested topic arriving means either a
    // subscription exists nobody remembers making, or Shopify added one. Both are worth seeing.
    _state.unwanted++;
    logRejection('webhook', 'no_consumer', h.topic);
    return endNoBody(res, 200);
  }

  let stored = 0;
  try {
    for (const c of wanted) {
      const out = await c.record(event);
      if (out?.stored) stored++;
    }
  } catch (e) {
    // 503, never a silent 200. Shopify retries a 5xx for 48 hours; acking something nobody stored
    // loses it for good.
    console.error('[shopify-hooks] a consumer could not record —', e?.message || e);
    return endNoBody(res, 503);
  }

  _state.received++;
  _state.last_event = { at: new Date().toISOString(), topic: h.topic, id: h.webhookId, consumers: wanted.map((c) => c.name), stored };

  // ACK BEFORE WORKING. A slow ack counts as a delivery failure, and Shopify's window is 5 seconds.
  endNoBody(res, 200);

  if (stored > 0) {
    try { scheduleDispatch(); } catch (e) { console.warn('[shopify-hooks] could not schedule dispatch —', e?.message || e); }
  }
}

async function handleProxy(env, req, res, cfg, url) {
  _state.proxy_calls++;
  const secret = env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET;

  const refuse = (code, reason, message) => {
    _state.proxy_refusals++;
    _state.last_refusal = { at: new Date().toISOString(), what: 'proxy', reason };
    logRejection('proxy', reason);
    return endJson(res, code, { ok: false, reason, message });
  };

  const v = verifyProxySignature(secret, url.searchParams);
  if (!v.ok) return refuse(401, v.reason, 'Could not verify this request.');

  // The docs describe NO replay protection, so a captured URL is valid forever without this.
  const stale = timestampProblem(url.searchParams.get('timestamp'), { maxAgeSec: Number(cfg.proxy_max_age_sec) || 120 });
  if (stale) return refuse(401, 'stale_timestamp', 'That link has expired. Please try again.');

  const prefixNote = pathPrefixProblem(url.searchParams, cfg.proxy_prefix);
  if (prefixNote) console.warn('[shopify-hooks]', prefixNote);   // diagnosis only, never a gate

  // ⚠ NULL MEANS REFUSE, and it never means "fall back to something". Shopify has an open internal
  // investigation (2026-08-04, no fix, no timeline) into this being empty for genuinely logged-in
  // customers on NEW customer accounts, which is what this store uses. So this WILL happen, and the
  // only acceptable outcome is asking them to tap again — never trusting a customer id from the body.
  const customerGid = loggedInCustomerGid(url.searchParams);
  if (!customerGid) {
    return refuse(401, 'not_signed_in', 'We could not tell who you are. Make sure you are signed in, then tap again.');
  }

  if (!_proxyHandler) return endJson(res, 503, { ok: false, reason: 'not_armed', message: 'This is not switched on yet.' });

  let raw = null;
  if (req.method === 'POST') {
    try { raw = await readRawBody(req); } catch { return endNoBody(res, 400); }
  }

  try {
    const out = await _proxyHandler(env, { customerGid, cfg, url, method: req.method, body: raw ? raw.toString('utf8') : null });
    return endJson(res, out?.status || 200, out?.body ?? { ok: true });
  } catch (e) {
    console.error('[shopify-hooks] proxy handler failed —', e?.message || e);
    return endJson(res, 500, { ok: false, reason: 'handler_failed', message: 'Something went wrong on our side.' });
  }
}

async function handleRequest(env, req, res, cfgOverride = null) {
  // The override exists for tests. lib/config-paths.mjs captures CONFIG_DIR at import time, and ESM
  // hoists imports above any env assignment in a test file, so TCG_CONFIG_DIR cannot be redirected
  // from inside one. An explicit seam beats a test that silently reads the real config — which is how
  // the first version of these tests "passed" a wrong-shop assertion for the wrong reason.
  const cfg = cfgOverride || loadConfig();
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return endNoBody(res, 400); }

  if (url.pathname === cfg.webhook_path) return handleWebhook(env, req, res, cfg, false);
  if (url.pathname === cfg.compliance_path) return handleWebhook(env, req, res, cfg, true);
  if (url.pathname === cfg.proxy_path || url.pathname.startsWith(cfg.proxy_path + '/')) {
    return handleProxy(env, req, res, cfg, url);
  }
  // Everything else, including / and anything that looks like an API, is a bare 404 with no body.
  return endNoBody(res, 404);
}

// Exported for the isolation invariant test, which asserts the routing table without binding a port.
export async function __handleRequestForTest(env, req, res, cfg = null) { return handleRequest(env, req, res, cfg); }

// --- lifecycle (stop-then-start singleton on globalThis, mirrors startNotifyListener) ---

let _env = {};

export function startShopifyHooks(env) {
  stopShopifyHooks();
  if (env && typeof env === 'object') _env = env;
  ensureConfigSeeded();
  const cfg = loadConfig();
  _state = { ..._state, listening: false, host: null, port: null, bind_error: null, started_at: null };

  if (!cfg.enabled) { console.log(`[shopify-hooks] disabled (data/${CONFIG_NAME})`); return; }

  const problem = validateShopifyHooksConfig(cfg);
  if (problem) {
    // Refuse to arm rather than listen on something the safety rules forbid.
    _state.bind_error = problem;
    console.warn('[shopify-hooks] not starting —', problem);
    return;
  }
  const secretIssue = secretProblem(_env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET);
  if (secretIssue) {
    // Without this, every genuine delivery 401s and every consumer silently falls behind while its
    // reconcile sweep works unexplainably hard to cover for it.
    _state.bind_error = `SHOPIFY_CLIENT_SECRET ${secretIssue}`;
    console.warn('[shopify-hooks] not starting —', _state.bind_error);
    return;
  }

  const srv = http.createServer((req, res) => {
    handleRequest(_env, req, res).catch((e) => {
      console.error('[shopify-hooks] request failed —', e?.message || e);
      try { endNoBody(res, 500); } catch { /* already sent */ }
    });
  });
  srv.on('error', (e) => {
    // Never take the dev server down with us. A second instance of this repo on the same box is the
    // likely cause — which is exactly what a development worktree is.
    _state.bind_error = String(e?.code || e?.message || e);
    _state.listening = false;
    console.warn(`[shopify-hooks] listen failed (${_state.bind_error}) — webhooks are off, every consumer's reconcile sweep is unaffected`);
    globalThis.__shopifyHooksServer = null;
  });
  srv.listen(cfg.listen_port, cfg.listen_host, () => {
    _state.listening = true;
    _state.host = cfg.listen_host; _state.port = cfg.listen_port;
    _state.started_at = new Date().toISOString();
    const lan = cfg.listen_host !== '127.0.0.1' && cfg.listen_host !== '::1';
    console.log(`[shopify-hooks] listening on ${cfg.listen_host}:${cfg.listen_port}`
      + ` [${cfg.webhook_path} ${cfg.compliance_path} ${cfg.proxy_path}]`
      + ` · shop ${cfg.shop} · consumers ${[..._consumers.keys()].join(',') || '(none)'}`
      + ` · public ${cfg.public_endpoint || '(not set)'}`
      + (lan ? ' · ⚠ LAN BIND (allow_lan_bind)' : ''));
  });
  if (srv.unref) srv.unref();
  globalThis.__shopifyHooksServer = srv;
}

export function stopShopifyHooks() {
  const s = globalThis.__shopifyHooksServer;
  if (s) {
    // closeAllConnections matters: a tunnel holds keep-alive sockets open, and without this close()
    // waits for them and the next start hits EADDRINUSE.
    try { s.closeAllConnections?.(); } catch { /* older node */ }
    try { s.close(); } catch { /* already closing */ }
    globalThis.__shopifyHooksServer = null;
  }
  // A pending dispatch belongs to the listener that scheduled it; leaving it armed across a settings
  // restart would fire against a config that no longer applies.
  if (_d.timer) { clearTimeout(_d.timer); _d.timer = null; }
  _state.listening = false; _state.host = null; _state.port = null; _state.started_at = null;
}

// Tests only — reset the module's process-level state between cases.
export function __resetShopifyHooks() {
  stopShopifyHooks();
  _consumers.clear();
  _proxyHandler = null;
  _state = {
    listening: false, host: null, port: null, bind_error: null, started_at: null,
    received: 0, unwanted: 0, sig_failures: 0, proxy_calls: 0, proxy_refusals: 0,
    last_event: null, last_refusal: null,
  };
  _d = { timer: null, inFlight: null, firstAt: 0, lastAt: 0, lastRunAt: 0, runs: 0, last_run: null };
  _rejects = 0; _env = {};
}
