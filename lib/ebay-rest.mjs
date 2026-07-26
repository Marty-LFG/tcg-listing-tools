// lib/ebay-rest.mjs — the ONE authenticated JSON transport for eBay's REST Sell APIs
// (Account, Inventory, Media, Metadata). The REST twin of tradingCall() in lib/ebay-trading.mjs:
// it mints/reuses the OAuth USER token via getUserAccessToken() (lib/ebay-oauth.mjs — the single
// user-token acquirer for the repo), sets the standard Sell-API headers, throttles + retries
// transient failures, and returns a uniform { httpStatus, ok, json, text, errors } shape.
//
// Sell APIs are user-token only (createOrReplaceInventoryItem / createOffer / publishOffer,
// optInToProgram, createFulfillmentPolicy, …). Taxonomy is the exception — it takes the
// client-credentials APP token — so it stays on the /api/ebay proxy path, not here.
//
// Zero dependencies (global fetch). Errors are surfaced as data, never thrown for a non-2xx, so
// callers can degrade gracefully (Golden Rule 7). getUserAccessToken throws { code:'not_connected' }
// when the seller hasn't consented; callers translate that into a 409/'connect eBay first'.
import { getUserAccessToken } from './ebay-oauth.mjs';

const API_BASE = 'https://api.ebay.com';
export const DEFAULT_MARKETPLACE = 'EBAY_AU';
export const DEFAULT_CONTENT_LANGUAGE = 'en-AU';

// --- throttle: one serialized promise chain, ~120ms between outbound calls + light jitter, so a
// burst of writes never trips eBay's short-window rate limits. Mirrors lib/pricecharting.mjs. ---
let _chain = Promise.resolve();
let _last = 0;
const MIN_GAP_MS = 120;
function throttle() {
  _chain = _chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - _last)) + Math.floor(Math.random() * 60);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    _last = Date.now();
  });
  return _chain;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull eBay's structured error/warning array out of a REST error body. Both v1 (Account/Inventory)
// and the Media API return { errors:[{errorId,message,longMessage,parameters:[…]}], warnings:[…] }.
export function restErrors(json) {
  const out = [];
  for (const key of ['errors', 'warnings']) {
    const arr = json && Array.isArray(json[key]) ? json[key] : [];
    for (const e of arr) {
      out.push({
        severity: key === 'warnings' ? 'warning' : 'error',
        id: e.errorId, message: e.longMessage || e.message,
        parameters: (e.parameters || []).map((p) => (p.name ? `${p.name}=${p.value}` : p.value)).filter(Boolean),
      });
    }
  }
  return out;
}
// A short human summary of an error body, for logs/UI. Never includes tokens. Joins EVERY error, not
// just errors[0]: eBay pairs a generic wrapper (e.g. [25001] "Core Inventory Service internal error")
// with the specific error naming the offending field, and reporting only the first threw away the one
// worth reading — which is exactly how a live publish failure came back undiagnosable (2026-07-26).
export function firstErrorText(json) {
  const all = restErrors(json);
  const errs = all.filter((x) => x.severity === 'error');
  const rows = (errs.length ? errs : all).map((e) =>
    [e.id != null ? `[${e.id}]` : '', e.message, e.parameters.length ? `(${e.parameters.join(', ')})` : '']
      .filter(Boolean).join(' '));
  return rows.length ? rows.join(' · ') : null;
}

// ebayRest(env, method, path, opts) — path is relative to api.ebay.com (e.g.
// '/sell/account/v1/program/opt_in') or an absolute https URL (e.g. the Media API on apim.ebay.com).
// opts: { body, headers, marketplaceId, contentLanguage, token, retries, timeoutMs, form }.
//  - body: a JSON-serialisable object (sent as application/json) — omit for GET/DELETE.
//  - form: a FormData (multipart) — used by the Media API binary upload; overrides body.
//  - token: override the user token (tests). Otherwise minted via getUserAccessToken.
export async function ebayRest(env, method, path, opts = {}) {
  const {
    body, form, headers: extraHeaders = {}, marketplaceId = DEFAULT_MARKETPLACE,
    contentLanguage = DEFAULT_CONTENT_LANGUAGE, retries = 3, timeoutMs = 30000,
  } = opts;
  const url = /^https?:\/\//.test(path) ? path : API_BASE + path;
  const token = opts.token || await getUserAccessToken(env);

  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
    'Accept-Language': contentLanguage,
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    ...extraHeaders,
  };
  let payload;
  if (form) {
    payload = form;                                   // fetch sets multipart Content-Type + boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Language'] = contentLanguage;    // required by Inventory/Account write calls
    payload = JSON.stringify(body);
  }

  let attempt = 0;
  for (;;) {
    attempt++;
    await throttle();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r, text;
    try {
      r = await fetch(url, { method, headers, body: payload, signal: ac.signal });
      text = await r.text();
    } catch (e) {
      clearTimeout(timer);
      if (attempt <= retries) { await sleep(300 * attempt); continue; }   // network blip / timeout
      return { httpStatus: 0, ok: false, json: null, text: '', requestId: null, attempts: attempt, errors: [{ severity: 'error', message: 'network: ' + (e?.message || e), parameters: [] }] };
    }
    clearTimeout(timer);

    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { /* 201/204 or an HTML error page */ } }

    // eBay's request trace id. It is the only handle eBay Developer Support can trace a SYSTEM-category
    // failure (25001) by, and we were dropping it. Logged per ATTEMPT — inside the retry branch below —
    // so a burst of four retries reads as four lines, not one. Never log `headers`: it holds the Bearer.
    const rid = r.headers.get('rlogid') || r.headers.get('x-ebay-c-request-id') || null;
    if (!r.ok) {
      console.warn('[ebay-rest]', method, url.replace(API_BASE, ''), r.status, 'attempt=' + attempt, 'rid=' + (rid || '-'), '<-', (text || '').slice(0, 1200));
      if (env && env.EBAY_DEBUG && payload && !form) console.warn('[ebay-rest] request body ->', String(payload).slice(0, 4000));
    }

    // Retry transient statuses (429 rate limit, 5xx) with backoff; honour Retry-After when present.
    if ((r.status === 429 || r.status >= 500) && attempt <= retries) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * attempt);
      continue;
    }

    return {
      httpStatus: r.status,
      ok: r.ok,
      json,
      text,
      location: r.headers.get('location') || null,   // create* calls return the new id here
      requestId: rid,                                // eBay rlogid — quote this when raising a case
      attempts: attempt,
      errors: json ? restErrors(json) : (r.ok ? [] : [{ severity: 'error', message: 'HTTP ' + r.status, parameters: [] }]),
    };
  }
}

// Convenience wrappers.
export const ebayGet = (env, path, opts) => ebayRest(env, 'GET', path, opts);
export const ebayPost = (env, path, body, opts) => ebayRest(env, 'POST', path, { ...opts, body });
export const ebayPut = (env, path, body, opts) => ebayRest(env, 'PUT', path, { ...opts, body });
export const ebayDelete = (env, path, opts) => ebayRest(env, 'DELETE', path, opts);
