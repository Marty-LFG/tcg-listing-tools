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
// from EBAY_CERT_ID) in data/ebay-user-token.json — stealing that file without .env is useless.
// Secrets never reach the browser (Golden Rule 2): the Cert ID is used only server-side for the
// Basic-auth token exchange; only the (public) App ID appears in the consent URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOKEN_STORE_PATH = path.join(ROOT, 'data', 'ebay-user-token.json');

const AUTHORIZE_URL = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// Requested up front (all at once) so adding a capability later doesn't force a re-consent.
// sell.inventory covers GetMyeBaySelling / Revise* / Best-Offer thresholds; sell.account covers
// business-policy reads. Base scope is always included.
export const CONSENT_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
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
function encryptSecret(env, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(env), iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(env, blob) {
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

async function refreshAccessToken(env, refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: CONSENT_SCOPES.join(' '),
  });
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
  const rt = store && decryptSecret(env, store.refresh_token_enc);
  if (!rt) { const e = new Error('eBay account not connected — complete the consent flow first'); e.code = 'not_connected'; throw e; }
  const j = await refreshAccessToken(env, rt);
  _userTok = { value: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 7200) - 60) * 1000 };
  return _userTok.value;
}

// Non-secret status for the UI/health checks — never returns any token material.
export function oauthStatus(env) {
  const store = loadTokenStore();
  const connected = !!(store && decryptSecret(env, store.refresh_token_enc));
  return {
    keys_configured: keysConfigured(env),
    runame_configured: runameConfigured(env),
    connected,
    scopes: store ? store.scopes : null,
    obtained_at: store ? store.obtained_at : null,
    refresh_expires_at: store ? store.refresh_expires_at : null,
    access_token_cached: !!(_userTok.value && Date.now() < _userTok.exp),
  };
}
