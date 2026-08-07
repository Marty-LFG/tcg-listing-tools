// lib/ebay-oauth.mjs — eBay USER-token OAuth (Authorization Code grant) for the store repricer.
//
// This is a DIFFERENT token from the client-credentials application token in vite.config.js.
// That app token authorizes public/Browse data; reading OUR OWN listings and REVISING prices
// needs a user token — i.e. the seller must consent once in a browser. We then hold an ~18-month
// refresh token and mint 2-hour access tokens headlessly forever after.
//
// Flow (documented low-infrastructure path — no public callback needed):
//   1. buildConsentUrl()  -> open in a browser, log in as the seller, Agree.
//   2. eBay redirects to the RuName's accept page with ?code=... in the address bar.
//   3. operator pastes that code -> exchangeCode() -> saveConsent() stores the refresh token.
//   4. getUserAccessToken() thereafter returns a live access token, refreshing as needed.
//
// The refresh token is the crown jewel, so it's stored ENCRYPTED at rest (AES-256-GCM, key derived
// from EBAY_CERT_ID) in data/ebay-oauth.json — stealing that file without .env is useless. This is the
// SHARED eBay user-token store for the repo: it occupies the slot the bulk tool's Phase-2 Sell-API
// reserves (see AGENTS.md §14/§15), so both should use THIS module rather than mint a second token. A
// pasted EBAY_REFRESH_TOKEN env var is honoured as a fallback source (no consent flow needed then).
// Secrets never reach the browser (Golden Rule 2): the Cert ID is used only server-side for the
// Basic-auth token exchange; only the (public) App ID appears in the consent URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOKEN_STORE_PATH = path.join(ROOT, 'data', 'ebay-oauth.json');

const AUTHORIZE_URL = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// Requested up front (all at once) so adding a capability later doesn't force a re-consent — the
// consent is a manual browser step, so a second one is the expensive mistake here, not a scope we
// asked for and never used. Editing this list is safe: the refresh sends the STORED grant, so a
// seller who consented before an entry existed keeps working and simply shows needs_reconsent.
//
// sell.inventory covers GetMyeBaySelling / Revise* / Best-Offer thresholds; sell.account covers
// business-policy reads. Base scope is always included.
//
// The push-notification block was read from eBay's own registry rather than transcribed from the
// docs — GET /commerce/notification/v1/topic returns an authorizationScopes array per topic, and
// this is the deduplicated union across the topics we intend to subscribe to (2026-08-05):
//   ORDER_CONFIRMATION           -> sell.fulfillment + sell.fulfillment.readonly
//   NEW_MESSAGE / BUYER_QUESTION -> commerce.message
//   ORDER_CANCELLATION_ACTIVITY  -> sell.cancellation + .read
//   ORDER_RETURN_ACTIVITY        -> sell.return + .read
//   ORDER_INQUIRY_ACTIVITY       -> sell.inquiry + .read
//   ITEM_MARKED_SHIPPED          -> commerce.shipping
//   FEEDBACK_RECEIVED / _LEFT    -> nothing beyond api_scope
//   MARKETPLACE_ACCOUNT_DELETION -> nothing beyond api_scope
// eBay lists both the write and .read/.readonly variant for each; which it actually enforces is not
// documented, and an unused scope costs nothing, so ask for both.
//
// sell.finances and commerce.notification.subscription are not needed by any topic. They are here
// because the browser is open anyway: finances fills the fee_transactions table that has sat empty,
// and the notification-subscription scope is the documented fallback if createSubscription turns out
// to refuse the application token for seller-data topics. Finding that out after the consent would
// mean doing the whole manual dance twice.
//
// NOT LISTED, and deliberately so — this keyset is not ENTITLED to them, and eBay rejects the whole
// consent URL with `invalid_scope` if any one is present, which takes down every other scope with it:
//
//     sell.cancellation      sell.cancellation.read     -> ORDER_CANCELLATION_ACTIVITY
//     sell.return            sell.return.read           -> ORDER_RETURN_ACTIVITY
//     sell.inquiry           sell.inquiry.read          -> ORDER_INQUIRY_ACTIVITY
//
// These are eBay's Post-Order scopes and are approval-gated per keyset, not merely un-asked-for.
// Verified 2026-08-07 by probing auth2.ebay.com/oauth2/authorize one scope at a time, with a
// deliberately fake scope as a negative control and the three already-granted scopes as positive
// ones — the six above refuse, the nine below pass, and the nine pass together.
//
// Losing them costs less than it sounds. Cancellations are already handled end to end by the poll
// (refreshOrder -> holdMoves -> settleHolds, with the restock and the pinned Telegram card), so the
// only thing the topic would have bought is latency: the in-poll by-id sweep finds a cancellation
// within sweep_interval_min rather than within seconds. Returns and inquiries have no consumer yet
// either way. If eBay ever grants Post-Order access, add them back here and re-consent.
export const CONSENT_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.message',
  'https://api.ebay.com/oauth/api_scope/commerce.shipping',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
];

// --- helpers ---
const trim = (s) => (s || '').trim();
export function keysConfigured(env) { return !!(trim(env.EBAY_APP_ID) && trim(env.EBAY_CERT_ID)); }
export function runameConfigured(env) { return !!trim(env.EBAY_RUNAME); }
function basicAuth(env) {
  return 'Basic ' + Buffer.from(trim(env.EBAY_APP_ID) + ':' + trim(env.EBAY_CERT_ID)).toString('base64');
}

// AES-256-GCM with a key derived from EBAY_CERT_ID. Blob = "v1:" + base64(iv|tag|ciphertext).
function keyFrom(env) {
  return crypto.scryptSync(trim(env.EBAY_CERT_ID) || 'tcg-repricer-fallback', 'tcg-repricer-ebay-oauth-v1', 32);
}
export function encryptSecret(env, plaintext) {   // exported for the unit suite

  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(env), iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decryptSecret(env, blob) {        // exported for the unit suite

  if (!blob || !blob.startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(blob.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(env), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; } // wrong key (Cert ID changed) or tampered file
}

// --- token store (data/ebay-user-token.json) ---
function loadTokenStore() {
  try { return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8')); } catch { return null; }
}
function saveTokenStore(store) {
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2));
}
export function deleteTokenStore() {
  try { fs.unlinkSync(TOKEN_STORE_PATH); } catch {}
  _userTok = { value: '', exp: 0 };
}

// --- consent URL ---
export function buildConsentUrl(env, state = '') {
  const p = new URLSearchParams({
    client_id: trim(env.EBAY_APP_ID),
    redirect_uri: trim(env.EBAY_RUNAME), // the RuName, NOT a URL (eBay rejects localhost URLs)
    response_type: 'code',
    scope: CONSENT_SCOPES.join(' '),
    prompt: 'login',
  });
  if (state) p.set('state', state);
  return AUTHORIZE_URL + '?' + p.toString();
}

// --- code -> tokens ---
export async function exchangeCode(env, code) {
  // eBay puts the code in the address bar URL-encoded; decode once so URLSearchParams re-encodes
  // the true value (double-encoding is the classic invalid_grant cause).
  let clean = String(code || '').trim();
  try { clean = decodeURIComponent(clean); } catch {}
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: clean,
    redirect_uri: trim(env.EBAY_RUNAME),
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(env) },
    body: body.toString(),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = {}; }
  if (!r.ok) throw new Error('token exchange failed (HTTP ' + r.status + '): ' + (j.error_description || j.error || text.slice(0, 200)));
  return j; // { access_token, expires_in, refresh_token, refresh_token_expires_in, token_type }
}

// Persist the consent result. Caches the fresh access token in memory too.
export function saveConsent(env, tok) {
  const now = Date.now();
  const store = {
    refresh_token_enc: encryptSecret(env, tok.refresh_token),
    refresh_expires_at: new Date(now + (tok.refresh_token_expires_in || 47304000) * 1000).toISOString(),
    scopes: CONSENT_SCOPES.join(' '),
    obtained_at: new Date(now).toISOString(),
  };
  saveTokenStore(store);
  _userTok = { value: tok.access_token, exp: now + Math.max(0, (tok.expires_in || 7200) - 60) * 1000 };
  return store;
}

/**
 * Mint an access token from the refresh token.
 *
 * `grantedScopes` is what the seller ACTUALLY consented to, read back from the token store — it is
 * deliberately NOT CONSENT_SCOPES. OAuth (RFC 6749 §6) requires a refresh request's scope to be a
 * subset of the original grant, so sending CONSENT_SCOPES here meant that adding one entry to that
 * constant instantly invalidated the live token: every refresh came back `invalid_scope`, and since
 * the user token is what the repricer, listings publish/revise, order polling and member messages all
 * run on, a one-line edit took the whole store offline about two hours later, when the cached access
 * token expired. CONSENT_SCOPES now means only "what the NEXT consent asks for" and is safe to edit.
 *
 * Pass null when the granted set is unknown (a hand-pasted EBAY_REFRESH_TOKEN, or a store written
 * before scopes were recorded). Omitting `scope` is the spec's own answer for that case — the token
 * comes back with exactly the scope originally granted — and guessing is the failure this function
 * exists to avoid.
 */
async function refreshAccessToken(env, refreshToken, grantedScopes = null) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (grantedScopes) body.set('scope', grantedScopes);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(env) },
    body: body.toString(),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = {}; }
  if (!r.ok) throw new Error('token refresh failed (HTTP ' + r.status + '): ' + (j.error_description || j.error || text.slice(0, 200)));
  return j; // { access_token, expires_in }
}

// In-memory access-token cache (mirrors ebayTok in vite.config.js). Refreshed ~60s early.
let _userTok = { value: '', exp: 0 };

// Returns a live user access token, refreshing from the stored refresh token as needed.
// Throws { code:'not_connected' } if the seller hasn't consented yet.
export async function getUserAccessToken(env) {
  if (_userTok.value && Date.now() < _userTok.exp) return _userTok.value;
  const store = loadTokenStore();
  // Prefer the consent-flow refresh token (encrypted store); fall back to a pasted EBAY_REFRESH_TOKEN.
  const fromStore = store && decryptSecret(env, store.refresh_token_enc);
  const rt = fromStore || trim(env.EBAY_REFRESH_TOKEN) || null;
  if (!rt) { const e = new Error('eBay account not connected — run the consent flow, or set EBAY_REFRESH_TOKEN in .env'); e.code = 'not_connected'; throw e; }
  // Only the store knows what was granted, and only for the token the store holds. A pasted
  // EBAY_REFRESH_TOKEN carries no scope record, so ask for nothing and take the original grant.
  const granted = (fromStore && trim(store.scopes)) || null;
  const j = await refreshAccessToken(env, rt, granted);
  _userTok = { value: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 7200) - 60) * 1000 };
  return _userTok.value;
}

// Which of the scopes we would ask for today are missing from what the seller actually granted.
// Pure + exported so the settings card, /api/status and the unit suite all read the same answer.
export function missingScopes(grantedScopeString) {
  const granted = new Set(String(grantedScopeString || '').split(/\s+/).filter(Boolean));
  return CONSENT_SCOPES.filter((s) => !granted.has(s));
}

// Non-secret status for the UI/health checks — never returns any token material.
export function oauthStatus(env) {
  const store = loadTokenStore();
  const storeConnected = !!(store && decryptSecret(env, store.refresh_token_enc));
  const envToken = !!trim(env.EBAY_REFRESH_TOKEN);
  // A capability added to CONSENT_SCOPES does NOT reach a seller who consented before it existed —
  // the stored grant is fixed until they re-consent. Nothing breaks quietly (the refresh above asks
  // for the stored set, so the token keeps working); the new capability simply fails when it is first
  // used. Surfacing it here is what turns that into a banner instead of a mystery.
  const scopes_missing = storeConnected ? missingScopes(store.scopes) : [];
  return {
    keys_configured: keysConfigured(env),
    runame_configured: runameConfigured(env),
    connected: storeConnected || envToken,
    token_source: storeConnected ? 'consent' : envToken ? 'env' : null,
    scopes: store ? store.scopes : (envToken ? '(from EBAY_REFRESH_TOKEN)' : null),
    obtained_at: store ? store.obtained_at : null,
    refresh_expires_at: store ? store.refresh_expires_at : null,
    access_token_cached: !!(_userTok.value && Date.now() < _userTok.exp),
    scopes_missing,
    needs_reconsent: scopes_missing.length > 0,
  };
}
