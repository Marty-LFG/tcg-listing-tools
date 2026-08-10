// lib/ebay-notify.mjs — receives eBay's push notifications (Commerce Notification API).
//
// WHY THIS IS NOT A VITE ROUTE. Every other endpoint in this repo is a middleware on the dev server,
// which is bound to the LAN and documented as never-expose-this. eBay's notifications are push-only to
// a public HTTPS endpoint, so something has to be reachable from the internet — and the way to make
// that survivable is to keep the reachable surface as small as it can possibly be. This module runs
// its own node:http server on LOOPBACK, serving two paths and 404ing everything else. A Cloudflare
// tunnel maps only those paths to only that port, so even a misconfigured tunnel cannot reach
// /api/tracker, /api/inventory or anything else the suite exposes.
//
// WHAT A NOTIFICATION IS FOR. It is a TRIGGER, never a source of data. eBay's sale payload carries an
// order id, some line-item ids, and nothing else worth having — no price, no buyer, no address, no
// SKU — so the pipeline re-reads the order from the Trading API by id and the payload is kept purely
// so a delivery can be explained later. That choice is what makes eBay's delivery guarantees
// survivable: at-least-once, unordered, and given up on after three attempts. None of that can
// corrupt anything if the payload is never believed.
//
// Everything degrades quietly (GR7): with the config disabled, or absent, nothing binds and the rest
// of the suite is unaffected. The poll that exists today keeps running either way — push makes it
// faster, the poll is what makes it correct.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile } from './config-paths.mjs';
import crypto from 'node:crypto';
import { verifyNotification, computeChallengeResponse, verificationTokenProblem, keyCacheStats } from './ebay-notify-verify.mjs';
import { openPostsaleDb } from './postsale-db.mjs';
import { reconcile, destinationHealth, testSubscription, getSubscriptions, getTopics } from './ebay-notify-admin.mjs';
import { observeOrderEvents, observationSummary } from './ebay-notify-observe.mjs';
import { reactToOrderEvents } from './ebay-notify-react.mjs';

// DIAG_TOKEN gate. Inlined rather than imported to avoid a lib/status.mjs <-> here import cycle —
// same contract and same timing-safe compare as lib/postsale.mjs and lib/listings.mjs.
function diagOk(env, req, url) {
  const want = (env.DIAG_TOKEN || '').trim();
  if (!want) return { ok: false, code: 503, error: 'diagnostics disabled — set DIAG_TOKEN in .env to enable manual triggers' };
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  const got = ((m && m[1]) || url.searchParams.get('token') || '').trim();
  if (!got) return { ok: false, code: 401, error: 'missing token — pass Authorization: Bearer <DIAG_TOKEN> or ?token=' };
  const a = Buffer.from(got), b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, code: 403, error: 'invalid diagnostics token' };
}

const CONFIG_NAME = 'ebay-notify.config.json';
const EXAMPLE_NAME = 'ebay-notify.config.example.json';
const MAX_BODY_BYTES = 256 * 1024;

// The topics this app knows what to do with. SETTINGS.validate() derives its allowlist from this, so
// the list cannot go stale the way a hand-copied one does (same trick as availableBakes()).
// `action` is what a verified event of that topic will drive once the nudge worker lands; today
// everything is recorded and the order/message ones are marked for their handler.
export const TOPIC_ACTIONS = {
  ORDER_CONFIRMATION: 'order_by_id',
  ORDER_CANCELLATION_ACTIVITY: 'order_by_id',
  ITEM_MARKED_SHIPPED: 'order_by_id',
  NEW_MESSAGE: 'message_poll',
  BUYER_QUESTION: 'message_poll',
  ORDER_RETURN_ACTIVITY: 'record_only',
  ORDER_INQUIRY_ACTIVITY: 'record_only',
  FEEDBACK_RECEIVED: 'record_only',
  FEEDBACK_LEFT: 'record_only',
  MARKETPLACE_ACCOUNT_DELETION: 'account_deletion',
};
export const KNOWN_TOPICS = Object.keys(TOPIC_ACTIONS);

export const DEFAULT_CONFIG = {
  enabled: false,
  listen_host: '127.0.0.1',
  listen_port: 5274,
  path: '/ebay/notifications',
  account_deletion_path: '/ebay/account-deletion',
  public_endpoint: '',
  destination_name: 'tcg-tools-prod',
  // Where eBay emails you when it marks the destination down. Not optional decoration: until an app
  // config exists, eBay's subscription endpoints refuse to answer at all (error 195003).
  alert_email: '',
  topics: ['ORDER_CONFIRMATION'],
  retain_days: 30,
  alerts: true,
  // What a verified notification is allowed to DO.
  //   poll    — run the scheduled order poll NOW. This is not a second pipeline: it calls the same
  //             runOrderPoll the ten-minute timer calls, so every alert, stock move, draft and dedupe
  //             is the code that already carries this store, minutes earlier. lib/ebay-notify-react.mjs.
  //   observe — read the order back from eBay and write down what was true. Nothing is ingested,
  //             messaged, dispatched or restocked; the existing poll keeps doing all the real work.
  //             This is what made the soak meaningful: it measured how far ahead of the poll push
  //             actually is, on real sales, while changing nothing.
  //   off     — receive and record the notification, look at nothing.
  //
  // `poll` is the default precisely because the listener is not. `enabled: false` above means nothing
  // reaches this setting without somebody deliberately putting the endpoint on the internet, and
  // having done that, waiting up to ten minutes for the Telegram alert is not what they asked for.
  // Observe stays the way to measure before trusting, and it is what earned this default: six of six
  // real notifications arrived ahead of the poll, a median of 364 seconds.
  react: { mode: 'poll', quiet_ms: 5000, max_wait_ms: 60000, min_gap_ms: 5000 },
};
export const REACT_MODES = ['off', 'observe', 'poll'];

// The seed always comes from the repo's own data/, never from TCG_CONFIG_DIR — the example is tracked
// source, the live file is server-owned (see config-paths.mjs).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function ensureConfigSeeded() {
  const live = configFile(CONFIG_NAME);
  if (fs.existsSync(live)) return;
  try {
    const seed = path.join(ROOT, 'data', EXAMPLE_NAME);
    if (fs.existsSync(seed)) { fs.copyFileSync(seed, live); return; }
  } catch { /* fall through to the built-in default */ }
  try { fs.writeFileSync(live, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n'); } catch { /* read-only fs: DEFAULT_CONFIG still applies */ }
}

export function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configFile(CONFIG_NAME), 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

// --- state surfaced at /api/status ---
let _state = {
  listening: false, host: null, port: null, path: null, bind_error: null,
  received: 0, duplicates: 0, sig_failures: 0, challenges: 0, last_event: null, started_at: null,
};
export function getNotifyState() {
  const cfg = loadConfig();
  return {
    enabled: cfg.enabled !== false,
    listening: _state.listening,
    host: _state.host, port: _state.port, path: _state.path,
    public_endpoint: cfg.public_endpoint || null,
    bind_error: _state.bind_error,
    topics: cfg.topics || [],
    received: _state.received, duplicates: _state.duplicates,
    sig_failures: _state.sig_failures, challenges: _state.challenges,
    last_event: _state.last_event, started_at: _state.started_at,
    keys: keyCacheStats(),
    // What a notification is allowed to do, and what it has actually done. `poll` runs the real order
    // poll early; `observe` is READ-ONLY — orders are read back from eBay and written down, never
    // ingested or acted on.
    react: { mode: cfg.react?.mode || DEFAULT_CONFIG.react.mode, ...getReactState() },
  };
}

// --- persistence ---

// Best-effort subject id, purely so a row is recognisable in the UI. Never used to drive anything —
// the handler re-reads from eBay by id rather than trusting a field out of the payload.
export function refIdFor(topic, data) {
  const d = data || {};
  return String(
    d.order?.orderId ?? d.orderId ?? d.orderCancellation?.cancellationId ?? d.orderReturn?.returnId
    ?? d.orderInquiry?.inquiryId ?? d.messageId ?? d.feedbackDetail?.feedbackId ?? d.itemId ?? '',
  ) || null;
}

/**
 * Record one verified notification. Returns { stored, duplicate, action }.
 * The ON CONFLICT is the dedupe: eBay retries up to three times, and the safety poll re-reads windows
 * a notification already covered, so a redelivery has to change nothing.
 */
export function recordEvent(db, envelope, { postsaleEnabled = true } = {}) {
  const meta = envelope?.metadata || {};
  const note = envelope?.notification || {};
  const topic = String(meta.topic || '');
  const id = String(note.notificationId || '');
  if (!id || !topic) return { stored: false, duplicate: false, action: null, error: 'malformed envelope' };

  const known = Object.prototype.hasOwnProperty.call(TOPIC_ACTIONS, topic);
  // A topic we never asked for still gets written down rather than dropped: if it is arriving, either
  // a subscription exists that nobody remembers making, or eBay added one — both worth seeing.
  let action = known ? TOPIC_ACTIONS[topic] : 'ignored';
  let status = 'received';
  if (!known) status = 'ignored';
  else if (!postsaleEnabled && (action === 'order_by_id' || action === 'message_poll')) {
    // Receipt and acting on it are separately gated on purpose. With the pipeline off, events still
    // land — visible, countable, replayable — which is what makes a soak-before-arming possible.
    status = 'skipped'; action = 'postsale_disabled';
  }

  const r = db.prepare(`INSERT INTO notify_events
      (notification_id, topic, schema_version, event_date, publish_date, publish_attempt_count, ref_id, status, action, payload)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(notification_id) DO NOTHING`)
    .run(id, topic, meta.schemaVersion ?? null, note.eventDate ?? null, note.publishDate ?? null,
      Number(note.publishAttemptCount ?? 0) || 0, refIdFor(topic, note.data), status, action,
      JSON.stringify(envelope).slice(0, 20000));

  const stored = (r.changes || 0) > 0;
  return { stored, duplicate: !stored, action, topic, notificationId: id };
}

// Prune handled rows past their retention. `payload` is the bulky column and the only reason this
// table grows; the row itself is cheap, so only fully-settled ones go.
export function pruneEvents(db, retainDays = 30) {
  try {
    const r = db.prepare(`DELETE FROM notify_events
      WHERE status IN ('handled','ignored','skipped')
        AND received_at < datetime('now', ?)`).run('-' + Math.max(1, retainDays) + ' days');
    return r.changes || 0;
  } catch { return 0; }
}

// --- the listener ---

// The signature is over the exact bytes eBay sent, so the body must never meet a JSON parser first.
// lib/req-body.mjs is deliberately not used here: it discards the raw buffer.
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

/**
 * The challenge handshake. eBay GETs ?challenge_code=… once, when the destination is created, and
 * expects a JSON body it can hash-match. Built with JSON.stringify rather than string concatenation
 * because eBay's own docs warn that a stray BOM makes the body invalid JSON and the validation then
 * fails with nothing to look at.
 */
export function handleChallenge(res, { challengeCode, verificationToken, endpoint }) {
  if (!challengeCode) return endNoBody(res, 400);
  const body = JSON.stringify({ challengeResponse: computeChallengeResponse(challengeCode, verificationToken, endpoint) });
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

// Look the shared secret up by NAME rather than inlining a ternary over the two env values — the
// no-secrets invariant reads `_TOKEN : env.SOMETHING_LONG` as a credential assignment, and it is
// right to: that shape is what a hardcoded key looks like.
const TOKEN_VARS = { notify: 'EBAY_NOTIFY_VERIFICATION_TOKEN', deletion: 'EBAY_NOTIFY_DELETION_TOKEN' };
function tokenFor(env, which) {
  return String(env[TOKEN_VARS[which] || TOKEN_VARS.notify] || '').trim();
}
// The endpoint string that goes into the challenge hash must be the PUBLIC url exactly as registered,
// not the loopback address this process is actually bound to.
function endpointFor(cfg, which) {
  const base = String(cfg.public_endpoint || '').replace(/\/+$/, '');
  if (!base) return '';
  if (which !== 'deletion') return base;
  try { const u = new URL(base); u.pathname = cfg.account_deletion_path; return u.toString().replace(/\/+$/, ''); }
  catch { return ''; }
}

async function handleRequest(env, req, res) {
  const cfg = loadConfig();
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return endNoBody(res, 400); }
  const p = url.pathname.replace(/\/+$/, '') || '/';

  const which = p === cfg.path ? 'notify' : p === cfg.account_deletion_path ? 'deletion' : null;
  // Anything else gets a bare 404 — no body, no hint that this port serves anything at all.
  if (!which) return endNoBody(res, 404);

  if (req.method === 'GET') {
    _state.challenges++;
    return handleChallenge(res, {
      challengeCode: url.searchParams.get('challenge_code'),
      verificationToken: tokenFor(env, which),
      endpoint: endpointFor(cfg, which),
    });
  }
  if (req.method !== 'POST') return endNoBody(res, 405);

  let raw;
  try { raw = await readRawBody(req); } catch { return endNoBody(res, 400); }

  const v = await verifyNotification(env, req.headers['x-ebay-signature'], raw);
  if (!v.ok) {
    _state.sig_failures++;
    // Rate-limited: a public endpoint attracts noise and this must not become the log.
    if (_state.sig_failures <= 5 || _state.sig_failures % 50 === 0) {
      console.warn('[ebay-notify] rejected an unverified POST (' + v.reason + ') — total ' + _state.sig_failures);
    }
    return endNoBody(res, 412);
  }

  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch { return endNoBody(res, 400); }

  let db;
  try { db = openPostsaleDb(); }
  catch (e) {
    // 503, not 204: eBay retries a 5xx, and silently acking something we could not store would lose
    // it for good.
    console.error('[ebay-notify] cannot open the postsale db —', e?.message || e);
    return endNoBody(res, 503);
  }

  let out;
  try {
    const { loadConfig: loadPostsale } = await import('./postsale.mjs');
    out = recordEvent(db, envelope, { postsaleEnabled: loadPostsale().enabled !== false });
  } catch (e) {
    console.error('[ebay-notify] could not record an event —', e?.message || e);
    return endNoBody(res, 503);
  }

  _state.received++;
  if (out.duplicate) _state.duplicates++;
  if (out.stored) {
    _state.last_event = { at: new Date().toISOString(), topic: out.topic, notification_id: out.notificationId, action: out.action };
  }
  // Ack FIRST. eBay's ack window is short and a slow one counts as a delivery failure, which is how a
  // destination ends up marked down. Anything further happens after this returns.
  endNoBody(res, 204);
  // Only a genuinely new order event is worth a look — a redelivery has already been reacted to, and
  // scheduling on it would spend an API call to re-learn the same thing.
  if (out.stored && out.action === 'order_by_id') {
    try { scheduleReact(); } catch (e) { console.warn('[ebay-notify] could not schedule a react pass —', e?.message || e); }
  }
  return undefined;
}

// --- the react worker ---
//
// Debounced rather than immediate, for the same reason the poll is windowed: five buyers checking out
// at once should cost one GetOrders call, not five. Coalescing is safe here precisely because what
// runs at the end asks eBay about a SET of orders — in observe mode a batch of ids, in poll mode a
// time window that covers all of them. Waiting a moment only makes the batch bigger.
//
// The three knobs are a floor, a ceiling and a gap: quiet_ms collapses a burst, max_wait_ms
// guarantees a run under sustained traffic (otherwise a steady stream would defer forever), and
// min_gap_ms stops a notification storm spending the Trading API's daily budget.
let _react = { timer: null, firstAt: 0, lastAt: 0, lastRunAt: 0, runs: 0, inFlight: null, last_run: null };

export function getReactState() {
  return { runs: _react.runs, pending: !!_react.timer, last_run: _react.last_run };
}

/**
 * One debounced pass, doing whatever the configured mode allows. The mode is read here rather than
 * captured at schedule time so that turning push down in settings takes effect on the pass already
 * armed, not the one after it.
 */
export async function runReactPass({ trigger = 'schedule' } = {}) {
  const cfg = loadConfig();
  const mode = cfg.react?.mode || DEFAULT_CONFIG.react.mode;
  if (mode === 'off') return { ok: true, skipped: 'react_off' };
  if (!_db) return { ok: false, error: 'no database' };
  // One pass at a time. Both modes stamp the rows they read and then spend eBay calls on them, so two
  // overlapping runs would read the same rows and pay twice.
  if (_react.inFlight) return _react.inFlight;
  const run = (async () => {
    const started = new Date();
    try {
      const r = mode === 'poll'
        ? await reactToOrderEvents(_env, _db, { retryDelayMs: cfg.react?.min_gap_ms ?? DEFAULT_CONFIG.react.min_gap_ms })
        : await observeOrderEvents(_env, _db, {});
      _react.last_run = { at: started.toISOString(), trigger, mode, ...r };
      return r;
    } catch (e) {
      _react.last_run = { at: started.toISOString(), trigger, mode, ok: false, error: String(e?.message || e) };
      return _react.last_run;
    } finally { _react.inFlight = null; _react.lastRunAt = Date.now(); _react.runs++; }
  })();
  _react.inFlight = run;
  const out = await run;
  // An order eBay announced but has not returned yet gets another look rather than waiting out the
  // schedule. The retry budget lives in the react pass (MAX_ATTEMPTS) and the spacing in min_gap_ms,
  // so a payload that will never resolve — eBay's own test notification is one — cannot spin here.
  if (out?.retrying) {
    try { scheduleReact(); } catch (e) { console.warn('[ebay-notify] could not re-arm a react pass —', e?.message || e); }
  }
  return out;
}

function scheduleReact() {
  const cfg = loadConfig();
  if ((cfg.react?.mode || DEFAULT_CONFIG.react.mode) === 'off') return;
  const k = cfg.react || {};
  const quiet = Math.max(250, k.quiet_ms ?? 5000);
  const maxWait = Math.max(quiet, k.max_wait_ms ?? 60000);
  const minGap = Math.max(0, k.min_gap_ms ?? 5000);

  _react.lastAt = Date.now();
  if (!_react.timer) _react.firstAt = _react.lastAt;
  const waited = _react.lastAt - _react.firstAt;
  const sinceRun = Date.now() - _react.lastRunAt;
  const delay = Math.max(
    waited >= maxWait ? 0 : Math.min(quiet, maxWait - waited),
    minGap - sinceRun,
  );
  clearTimeout(_react.timer);
  _react.timer = setTimeout(() => {
    _react.timer = null;
    runReactPass({ trigger: 'notification' }).catch((e) => console.warn('[ebay-notify] react pass failed —', e?.message || e));
  }, Math.max(0, delay));
  if (_react.timer.unref) _react.timer.unref();
}

// --- lifecycle (stop-then-start singleton on globalThis, mirrors startPostsaleJobs) ---
let _env = {};
let _db = null;
export function startNotifyListener(env, db) {
  stopNotifyListener();
  if (env && typeof env === 'object') _env = env;
  // Remembered like startPostsaleJobs does, so a settings-triggered restart (which has no server
  // context) can re-arm without one. Opened lazily rather than eagerly: a box with no postsale db yet
  // should still be able to receive and record.
  if (db) _db = db;
  if (!_db) { try { _db = openPostsaleDb(); } catch { _db = null; } }
  ensureConfigSeeded();
  const cfg = loadConfig();
  _state = { ...(_state), listening: false, host: null, port: null, path: null, bind_error: null, started_at: null };
  if (!cfg.enabled) { console.log('[ebay-notify] disabled (data/' + CONFIG_NAME + ')'); return; }

  const problem = verificationTokenProblem(tokenFor(_env, 'notify'));
  if (problem) {
    // Refuse to arm rather than answer challenges with a hash eBay will reject.
    _state.bind_error = 'EBAY_NOTIFY_VERIFICATION_TOKEN ' + problem;
    console.warn('[ebay-notify] not starting — ' + _state.bind_error);
    return;
  }

  const srv = http.createServer((req, res) => {
    handleRequest(_env, req, res).catch((e) => {
      console.error('[ebay-notify] request failed —', e?.message || e);
      try { endNoBody(res, 500); } catch { /* already sent */ }
    });
  });
  srv.on('error', (e) => {
    // Never take the dev server down with us (GR7). A second instance of this repo on the same box is
    // the likely cause, and the poll covers everything the listener would have accelerated.
    _state.bind_error = String(e?.code || e?.message || e);
    _state.listening = false;
    console.warn('[ebay-notify] listen failed (' + _state.bind_error + ') — push is off, polling is unaffected');
    globalThis.__ebayNotifyServer = null;
  });
  srv.listen(cfg.listen_port, cfg.listen_host, () => {
    _state.listening = true;
    _state.host = cfg.listen_host; _state.port = cfg.listen_port; _state.path = cfg.path;
    _state.started_at = new Date().toISOString();
    console.log('[ebay-notify] listening on ' + cfg.listen_host + ':' + cfg.listen_port + cfg.path
      + ' · public ' + (cfg.public_endpoint || '(not set)'));
  });
  if (srv.unref) srv.unref();
  globalThis.__ebayNotifyServer = srv;
}

export function stopNotifyListener() {
  const s = globalThis.__ebayNotifyServer;
  if (s) {
    // closeAllConnections matters: a tunnel holds keep-alive sockets open, and without this close()
    // waits for them and the next start hits EADDRINUSE.
    try { s.closeAllConnections?.(); } catch { /* older node */ }
    try { s.close(); } catch { /* already closing */ }
    globalThis.__ebayNotifyServer = null;
  }
  // A pending react pass belongs to the listener that scheduled it. Leaving it armed across a
  // settings restart would fire against a config that no longer applies.
  if (_react.timer) { clearTimeout(_react.timer); _react.timer = null; }
  _state.listening = false; _state.host = null; _state.port = null; _state.path = null; _state.started_at = null;
}

// --- vite plugin: the LAN-side control surface (status only; the listener is the loopback server) ---
export function ebayNotifyPlugin(env) {
  return {
    name: 'ebay-notify',
    configureServer(server) {
      startNotifyListener(env);
      server.middlewares.use('/api/ebay-notify', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const send = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };

        if (p === '/state' && req.method === 'GET') return send(200, getNotifyState());
        if (p === '/config' && req.method === 'GET') {
          const cfg = loadConfig();
          return send(200, {
            config: cfg,
            state: getNotifyState(),
            // Whether the shared secrets exist — never their values (GR2).
            tokens: {
              notify: verificationTokenProblem(tokenFor(env, 'notify')) === null,
              deletion: verificationTokenProblem(tokenFor(env, 'deletion')) === null,
            },
            known_topics: KNOWN_TOPICS,
          });
        }
        // A loopback round-trip against our own listener: proves it is bound, routing, and hashing
        // the challenge correctly, without touching eBay. 503 (not 404) when it is down, because
        // /api/status treats a 404 as ok and a dead listener would read green.
        if (p === '/self-test' && req.method === 'GET') {
          const st = getNotifyState();
          if (!st.listening) return send(503, { ok: false, error: 'not_listening', bind_error: st.bind_error });
          const code = 'self-test-' + Math.random().toString(36).slice(2, 10);
          const cfg = loadConfig();
          try {
            const r = await fetch('http://' + cfg.listen_host + ':' + cfg.listen_port + cfg.path + '?challenge_code=' + encodeURIComponent(code));
            const j = await r.json();
            const expected = computeChallengeResponse(code, tokenFor(env, 'notify'), endpointFor(cfg, 'notify'));
            const ok = r.status === 200 && j && j.challengeResponse === expected;
            return send(ok ? 200 : 503, { ok, http: r.status, matched: ok });
          } catch (e) { return send(503, { ok: false, error: String(e?.message || e) }); }
        }

        // GET /observations — how far ahead of the poll push actually is. Pure read, and the whole
        // point of running in observe mode: the decision to let notifications drive the pipeline
        // should rest on this rather than on hope.
        if (p === '/observations' && req.method === 'GET') {
          const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
          try { return send(200, observationSummary(openPostsaleDb(), { days })); }
          catch (e) { return send(503, { error: String(e?.message || e) }); }
        }

        // --- eBay-side subscription management. Everything below needs the diagnostics token. ---

        // POST /react — run the debounced pass now instead of waiting it out. What that DOES depends
        // on the configured mode, and the difference matters: in `observe` it re-reads orders from
        // eBay and records what it found, ingesting nothing; in `poll` it runs the real order poll,
        // which adopts orders, alerts and moves stock exactly as the scheduled one does.
        // /observe is the old name for this route, kept because it is in the runbook and in muscle
        // memory — it is the same pass either way, and the mode is what decides.
        if ((p === '/react' || p === '/observe') && req.method === 'POST') {
          const auth = diagOk(env, req, url); if (!auth.ok) return send(auth.code, { error: auth.error });
          try { return send(200, await runReactPass({ trigger: 'manual' })); }
          catch (e) { return send(502, { error: String(e?.message || e) }); }
        }


        // POST /reconcile           -> show what WOULD change (default; touches nothing)
        // POST /reconcile?apply=1   -> actually create/enable/disable
        //
        // Dry-run by default and deliberately not automatic: eBay validates the endpoint the moment a
        // destination is created and DISABLES it if the challenge fails, so registering as a side
        // effect of a boot or a settings save is exactly the wrong shape.
        if (p === '/reconcile' && req.method === 'POST') {
          const auth = diagOk(env, req, url); if (!auth.ok) return send(auth.code, { error: auth.error });
          const cfg = loadConfig();
          const apply = url.searchParams.get('apply') === '1';
          if (apply && !cfg.enabled) return send(409, { error: 'listener_disabled', detail: 'enable the listener before registering the endpoint with eBay — a destination whose endpoint does not answer gets disabled' });
          if (apply && !getNotifyState().listening) return send(409, { error: 'not_listening', detail: 'the listener is not bound; eBay would fail the challenge and disable the destination' });
          try { return send(200, await reconcile(env, cfg, { apply })); }
          catch (e) { return send(502, { error: String(e?.message || e) }); }
        }

        // POST /test?subscription=<id>  -> ask eBay to send a REAL signed notification to us.
        // The only true end-to-end proof, and it needs no sale.
        if (p === '/test' && req.method === 'POST') {
          const auth = diagOk(env, req, url); if (!auth.ok) return send(auth.code, { error: auth.error });
          let id = url.searchParams.get('subscription');
          if (!id) {
            const subs = await getSubscriptions(env);
            if (!subs.ok) return send(502, { error: subs.error });
            const cfg = loadConfig();
            const first = subs.items.find((s) => (cfg.topics || []).includes(s.topicId));
            if (!first) return send(409, { error: 'no_subscription', detail: 'nothing subscribed yet — run POST /reconcile?apply=1 first' });
            id = first.subscriptionId;
          }
          const r = await testSubscription(env, id);
          // eBay answers 202 Accepted; the notification itself arrives at the listener moments later.
          return send(r.ok ? 200 : 502, {
            ok: r.ok, subscription: id, http: r.httpStatus, used_token: r.usedToken,
            detail: r.ok ? 'eBay accepted the test — watch jobs.ebay_notify.last_event' : (r.json || r.error),
          });
        }

        // GET /destination — is eBay still willing to deliver to us?
        if (p === '/destination' && req.method === 'GET') {
          const auth = diagOk(env, req, url); if (!auth.ok) return send(auth.code, { error: auth.error });
          try { return send(200, await destinationHealth(env, loadConfig())); }
          catch (e) { return send(502, { error: String(e?.message || e) }); }
        }

        // GET /topics — eBay's registry, with the scopes each topic needs. Read this rather than
        // trusting the docs; it is what settled which scopes this keyset could actually ask for.
        if (p === '/topics' && req.method === 'GET') {
          const auth = diagOk(env, req, url); if (!auth.ok) return send(auth.code, { error: auth.error });
          const r = await getTopics(env);
          if (!r.ok) return send(502, { error: r.error });
          const want = url.searchParams.get('mine') === '1' ? new Set(loadConfig().topics || []) : null;
          return send(200, {
            count: r.items.length,
            topics: r.items.filter((t) => !want || want.has(t.topicId)).map((t) => ({
              topicId: t.topicId, scopes: t.authorizationScopes || [], filterable: t.filterable,
              payloads: (t.supportedPayloads || []).map((x) => `${x.schemaVersion}/${x.format}/${x.deliveryProtocol}`),
            })),
          });
        }

        return send(404, { error: 'unknown route' });
      });
    },
  };
}
