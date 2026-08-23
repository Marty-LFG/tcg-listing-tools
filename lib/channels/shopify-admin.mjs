// lib/channels/shopify-admin.mjs — the ONE authenticated transport for the Shopify Admin GraphQL API.
// The Shopify twin of lib/ebay-rest.mjs, and deliberately the same shape: it mints/reuses the access
// token, throttles + retries transient failures, and returns a uniform
// { httpStatus, ok, json, data, userErrors, errors, cost, attempts } — never throwing on a non-2xx, so
// callers degrade gracefully (Golden Rule 7).
//
// THREE THINGS DIFFER FROM eBAY, AND ALL THREE HAVE BITTEN REAL INTEGRATIONS:
//
//   1. GraphQL answers HTTP 200 WITH ERRORS. A mutation that changed nothing still returns 200 with a
//      populated `userErrors` array. Code that checks only the status code records product ids for
//      products it never wrote, and the logs look clean. So `ok` here means "HTTP ok AND no GraphQL
//      errors AND no userErrors anywhere in the payload" — see collectUserErrors.
//   2. The rate limit is a COST BUCKET, not a request count. Every response carries
//      extensions.cost.throttleStatus, so the throttle paces itself off what the bucket actually says
//      rather than off a hardcoded gap. Shopify's own documented per-tier bucket sizes are inconsistent
//      with its example payload, so nothing here is hardcoded — we read the real numbers.
//   3. Money arrives as a DECIMAL STRING. Golden Rule 3 is integer cents, and parseFloat on "0.1"-class
//      values is exactly how one-cent drift gets into a reconcile. moneyToCents parses the string.
//
// The token is a client-credentials grant: no redirect flow, ~24h lifetime, and it only works when the
// app and the store are in the same Shopify organization. It is the SAME custom app that ../bk-shopify
// uses, so the credentials are one pair shared by both repos.
//
// Zero dependencies (global fetch). Secrets never leave the server and never reach a log line.

const TOKEN_TTL_BUFFER_MS = 60_000;     // re-mint a minute early rather than racing the expiry

// PINNED, deliberately. Shopify FALLS FORWARD silently when a version retires — a stale pin does not
// 404, it quietly starts answering as a newer version, which is a breaking change with no signal. The
// response header is checked against this on every call so the day it happens is the day we hear about
// it. 2026-07 is stable until 2027-07-16.
export const API_VERSION = '2026-07';

// --- errors -------------------------------------------------------------------------------------

// GraphQL transport-level errors (bad query, throttled, internal) live at the top level.
export function graphqlErrors(json) {
  const arr = json && Array.isArray(json.errors) ? json.errors : [];
  return arr.map((e) => ({
    severity: 'error',
    code: e?.extensions?.code || null,
    message: e?.message || String(e),
    parameters: e?.path ? [e.path.join('.')] : [],
  }));
}

// Per-mutation failures live INSIDE data, one `userErrors` array per mutation field, and a request may
// carry several mutations. Walk the payload rather than making every call site remember its own path —
// forgetting one is silent, and silent is the whole problem this function exists for.
export function collectUserErrors(data, maxDepth = 6) {
  const out = [];
  const walk = (node, depth, path) => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return;
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, depth + 1, path)); return; }
    for (const [k, v] of Object.entries(node)) {
      // Shopify names these userErrors on most mutations, but a few legacy ones use a bare
      // `errors`/`mediaUserErrors` field of the same shape. Match the shape, not just the name.
      if ((k === 'userErrors' || k === 'mediaUserErrors') && Array.isArray(v)) {
        for (const e of v) {
          out.push({
            severity: 'error',
            code: e?.code || null,
            message: e?.message || String(e),
            parameters: Array.isArray(e?.field) ? [e.field.join('.')] : (e?.field ? [String(e.field)] : []),
            mutation: path || null,
          });
        }
      } else {
        walk(v, depth + 1, path ? path + '.' + k : k);
      }
    }
  };
  walk(data, 0, '');
  return out;
}

// A short human summary for logs and UI. Never includes a token. Joins EVERY error rather than the
// first, for the same reason lib/ebay-rest.mjs does: the specific one is rarely the first one.
export function firstErrorText(res) {
  const all = [...(res?.errors || []), ...(res?.userErrors || [])];
  const rows = all.map((e) => [
    e.code ? `[${e.code}]` : '',
    e.mutation ? `${e.mutation}:` : '',
    e.message,
    e.parameters && e.parameters.length ? `(${e.parameters.join(', ')})` : '',
  ].filter(Boolean).join(' '));
  return rows.length ? rows.join(' · ') : null;
}

// --- money --------------------------------------------------------------------------------------

// Shopify MoneyV2 amounts are decimal STRINGS ("42.50", "1234.00", sometimes "42.5" or "42").
// Golden Rule 3: integer cents, parsed from the string. parseFloat is banned here — binary floats
// turn a run of prices into one-cent reconcile drift, and the drift only shows up in aggregate.
export function moneyToCents(amount) {
  if (amount == null || amount === '') return null;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * 100);          // tolerated for a literal in a test fixture, not for API data
  }
  const s = String(amount).trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] || '0';
  const frac = (m[3] || '').padEnd(2, '0');
  // More than two decimal places is not a Shopify money value; round rather than silently truncate.
  const cents = frac.length > 2
    ? Math.round(Number(frac.slice(0, 2)) + Number(frac[2]) / 10)
    : Number(frac);
  return sign * (Number(whole) * 100 + cents);
}

// The inverse, at the one edge that needs it: Shopify price inputs are decimal strings.
export function centsToMoney(cents) {
  if (cents == null || !Number.isFinite(cents)) return null;
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(Math.round(cents));
  return sign + Math.floor(n / 100) + '.' + String(n % 100).padStart(2, '0');
}

// --- token --------------------------------------------------------------------------------------

// One cached token per shop domain. Client credentials, so re-minting is a single POST with no user
// interaction — but it is still a network call on a rate-limited endpoint, so it is cached to expiry.
const _tokens = new Map();   // shop -> { token, expiresAt, scope }

export class ShopifyNotConfigured extends Error {
  constructor(message) { super(message); this.name = 'ShopifyNotConfigured'; this.code = 'not_configured'; }
}

// Which store a call is for. Defaults to 'dev' ON PURPOSE: bk-shopify's engineering rule is that
// nothing destructive touches the live store until it has passed on dev, and a default that has to be
// overridden to reach production is the cheapest possible enforcement of it.
export function resolveShop(env = {}, store = 'dev') {
  const which = String(store || 'dev').toLowerCase();
  const raw = which === 'live' ? env.SHOPIFY_SHOP : env.SHOPIFY_DEV_SHOP;
  if (!raw) {
    throw new ShopifyNotConfigured(
      `no ${which} store configured — set ${which === 'live' ? 'SHOPIFY_SHOP' : 'SHOPIFY_DEV_SHOP'} in .env`);
  }
  // Accept a bare subdomain or a full domain; store the full one.
  const host = String(raw).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host.includes('.') ? host : host + '.myshopify.com';
}

export async function shopifyToken(env = {}, { store = 'dev', force = false, fetchImpl } = {}) {
  const shop = resolveShop(env, store);
  const cached = _tokens.get(shop);
  if (!force && cached && cached.expiresAt - TOKEN_TTL_BUFFER_MS > Date.now()) return cached;

  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new ShopifyNotConfigured('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set in .env');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.SHOPIFY_CLIENT_ID,
    client_secret: env.SHOPIFY_CLIENT_SECRET,
  });
  const r = await doFetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an HTML error page */ }
  if (!r.ok || !json?.access_token) {
    // shop_not_permitted almost always means the store is not in the app's Dev Dashboard organization.
    // Say so, because the raw message does not. NEVER include the body if it might echo the secret.
    const hint = json?.error === 'shop_not_permitted'
      ? ' — the store is not in this app\'s Dev Dashboard organization'
      : '';
    throw new ShopifyNotConfigured(`token mint failed for ${shop}: HTTP ${r.status} ${json?.error || ''}${hint}`);
  }
  const entry = {
    token: json.access_token,
    scope: json.scope || '',
    // expires_in is documented as always 86399. Trust the response, fall back to 24h.
    expiresAt: Date.now() + (Number(json.expires_in) || 86399) * 1000,
    shop,
  };
  _tokens.set(shop, entry);
  return entry;
}

// Test seam / credential rotation.
export function _clearTokenCache() { _tokens.clear(); }

// --- throttle -----------------------------------------------------------------------------------
//
// Serialized chain like lib/ebay-rest.mjs, but the wait is derived from Shopify's own cost bucket
// rather than a fixed gap. After each response we know currentlyAvailable and restoreRate; if the
// bucket is running low we wait for it to refill enough to cover the next call, keeping headroom so a
// webhook-driven delist never queues behind a bulk publish run.
const MIN_GAP_MS = 50;
const HEADROOM_POINTS = 100;          // never spend the bucket below this
let _chain = Promise.resolve();
let _last = 0;
let _bucket = null;                   // { available, restoreRate, at } — per process, one shop in practice

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function noteCost(cost) {
  const t = cost && cost.throttleStatus;
  if (!t) return;
  _bucket = {
    available: Number(t.currentlyAvailable),
    maximum: Number(t.maximumAvailable),
    restoreRate: Number(t.restoreRate) || 50,
    at: Date.now(),
  };
}

// How long to wait before spending `estimate` more points, given what the bucket last said.
export function waitForBucket(bucket, estimate, now = Date.now()) {
  if (!bucket || !Number.isFinite(bucket.available)) return 0;
  const restored = bucket.available + ((now - bucket.at) / 1000) * bucket.restoreRate;
  const want = estimate + HEADROOM_POINTS;
  if (restored >= want) return 0;
  return Math.ceil(((want - restored) / bucket.restoreRate) * 1000);
}

function throttle(estimate) {
  _chain = _chain.then(async () => {
    const gap = Math.max(0, MIN_GAP_MS - (Date.now() - _last));
    const bucketWait = waitForBucket(_bucket, estimate);
    const wait = Math.max(gap, bucketWait);
    if (wait) await sleep(wait);
    _last = Date.now();
  });
  return _chain;
}

export function _resetThrottle() { _bucket = null; _last = 0; _chain = Promise.resolve(); }

// --- the call -----------------------------------------------------------------------------------

let _versionWarned = false;

/**
 * shopifyGraphQL(env, query, variables, opts) -> {
 *   ok, httpStatus, json, data, errors, userErrors, cost, attempts, apiVersion, shop
 * }
 *
 * `ok` is HTTP ok AND no top-level GraphQL errors AND no userErrors anywhere in `data`. That is the
 * whole point of this module — see the header.
 *
 * opts: { store, retries, timeoutMs, estimate, token, fetchImpl, headers }
 *  - store:    'dev' (default) | 'live'
 *  - estimate: expected query cost in points, for the throttle. Mutations are 10 minimum.
 */
export async function shopifyGraphQL(env = {}, query, variables = {}, opts = {}) {
  const {
    store = 'dev', retries = 3, timeoutMs = 30_000, estimate = 50, fetchImpl, headers: extraHeaders = {},
  } = opts;
  const doFetch = fetchImpl || globalThis.fetch;

  let tok;
  try {
    tok = opts.token ? { token: opts.token, shop: resolveShop(env, store) } : await shopifyToken(env, { store, fetchImpl: doFetch });
  } catch (e) {
    // not_configured is data, not an exception, so a plugin route can answer 409 rather than 500.
    return {
      ok: false, httpStatus: 0, json: null, data: null, cost: null, attempts: 0,
      apiVersion: API_VERSION, shop: null, userErrors: [],
      errors: [{ severity: 'error', code: e?.code || 'not_configured', message: e?.message || String(e), parameters: [] }],
    };
  }

  const url = `https://${tok.shop}/admin/api/${API_VERSION}/graphql.json`;
  const payload = JSON.stringify({ query, variables });

  let attempt = 0;
  for (;;) {
    attempt++;
    await throttle(estimate);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r, text;
    try {
      r = await doFetch(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': tok.token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: payload,
        signal: ac.signal,
      });
      text = await r.text();
    } catch (e) {
      clearTimeout(timer);
      if (attempt <= retries) { await sleep(300 * attempt); continue; }
      return {
        ok: false, httpStatus: 0, json: null, data: null, cost: null, attempts: attempt,
        apiVersion: API_VERSION, shop: tok.shop, userErrors: [],
        errors: [{ severity: 'error', code: 'network', message: 'network: ' + (e?.message || e), parameters: [] }],
      };
    }
    clearTimeout(timer);

    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { /* an HTML error page or a 5xx */ } }

    // Fall-forward detection. If Shopify answers as a different version than we pinned, the pin has
    // retired and every assumption in shopify-map.mjs is now against an unread changelog. Warn loudly,
    // once, rather than every call.
    const served = r.headers?.get ? r.headers.get('x-shopify-api-version') : null;
    if (served && served !== API_VERSION && !_versionWarned) {
      _versionWarned = true;
      console.warn(`[shopify-admin] API VERSION DRIFT: pinned ${API_VERSION}, server answered ${served}. ` +
        'Shopify falls forward silently when a version retires — re-pin and read the changelog.');
    }

    const cost = json?.extensions?.cost || null;
    noteCost(cost);

    const gqlErrors = graphqlErrors(json);
    const throttled = r.status === 429 || gqlErrors.some((e) => e.code === 'THROTTLED');

    if (throttled && attempt <= retries) {
      // Prefer the bucket's own arithmetic over a flat backoff — it knows how long a refill takes.
      const ra = Number(r.headers?.get ? r.headers.get('retry-after') : NaN);
      const bucketWait = waitForBucket(_bucket, estimate);
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.max(1000, bucketWait || 1000 * attempt));
      continue;
    }
    if (r.status >= 500 && attempt <= retries) { await sleep(400 * attempt); continue; }

    if (!r.ok) {
      console.warn('[shopify-admin]', tok.shop, r.status, 'attempt=' + attempt, '<-', (text || '').slice(0, 1200));
    }

    const data = json?.data ?? null;
    const userErrors = collectUserErrors(data);
    const ok = r.ok && gqlErrors.length === 0 && userErrors.length === 0;
    if (!ok && r.ok) {
      // The dangerous case: HTTP 200 that did not do what was asked. Say so out loud.
      console.warn('[shopify-admin]', tok.shop, '200 but not ok:',
        firstErrorText({ errors: gqlErrors, userErrors }));
    }

    return {
      ok, httpStatus: r.status, json, data,
      errors: gqlErrors, userErrors, cost,
      attempts: attempt, apiVersion: API_VERSION, shop: tok.shop,
    };
  }
}
