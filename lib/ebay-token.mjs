// lib/ebay-token.mjs — eBay OAuth2 client-credentials APP token minting.
//
// Mints + caches the application token (Browse/Taxonomy — public data) and a SEPARATE, isolated
// token scoped for the Marketplace Insights API (true SOLD prices). Extracted verbatim from
// vite.config.js; the ebayProxy middleware there imports both functions. The module-level caches make
// this a process SINGLETON (Node caches modules by URL → one shared instance → no double-mint), so
// import it with the exact same specifier everywhere. Token TTL ~2h, refreshed ~60s early.
//
// DISTINCT from lib/ebay-oauth.mjs, which is the OAuth USER token (Authorization-Code grant) used by
// the repricer. This file is the app/client-credentials token only. (Buffer/fetch are Node globals.)

let ebayTok = { value: '', exp: 0 };
let ebayInsTok = { value: '', exp: 0 };

// #1 cause of a token-mint failure: SANDBOX keys used against the PRODUCTION endpoint (this proxy
// only ever calls production). eBay encodes the environment in the key strings (PRD-/SBX-). Centralised
// here so it is independently testable; used ONLY by ebayToken (the insights path preserves today's
// asymmetry and does not guard).
export function assertNotSandbox(appId, certId) {
  if (/SBX-/.test(appId) || /SBX-/.test(certId)) {
    throw new Error('these look like SANDBOX keys (contain "SBX-") but the proxy calls the PRODUCTION eBay API. ' +
      'Create a *Production* keyset at developer.ebay.com → Application Keys and use the PRD- App ID + Cert ID.');
  }
}

export async function ebayToken(env) {
  if (ebayTok.value && Date.now() < ebayTok.exp) return ebayTok.value;
  // .trim() defends against a trailing space/newline pasted into .env — a stray char in the Basic
  // header is silently rejected by eBay as invalid_client.
  const appId = (env.EBAY_APP_ID || '').trim();
  const certId = (env.EBAY_CERT_ID || '').trim();
  assertNotSandbox(appId, certId);
  const basic = Buffer.from(appId + ':' + certId).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  const text = await r.text();
  if (!r.ok) {
    // eBay returns JSON like {"error":"invalid_client","error_description":"client authentication failed"}.
    let detail = text.slice(0, 300);
    try { const e = JSON.parse(text); detail = [e.error, e.error_description].filter(Boolean).join(': ') || detail; } catch {}
    const hint = (r.status === 400 || r.status === 401)
      ? ' — verify EBAY_APP_ID is the App ID (Client ID) and EBAY_CERT_ID the Cert ID (Client Secret) from your *Production* keyset, with no extra spaces.'
      : '';
    throw new Error('eBay OAuth token mint failed (HTTP ' + r.status + '): ' + detail + hint);
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('eBay OAuth token response was not JSON: ' + text.slice(0, 200)); }
  ebayTok = { value: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 7200) - 60) * 1000 };
  return ebayTok.value;
}

// Separate, isolated token for the Marketplace Insights API (true SOLD prices). It needs the
// `buy.marketplace.insights` scope, granted only to apps approved for that limited-release API. Minted
// on its own so a denial (invalid_scope) can NEVER break the basic Browse/Taxonomy token above — it
// THROWS on failure and ebayProxy turns that into a soft 403 (client falls back to asking prices).
export async function ebayInsightsToken(env) {
  if (ebayInsTok.value && Date.now() < ebayInsTok.exp) return ebayInsTok.value;
  const appId = (env.EBAY_APP_ID || '').trim(), certId = (env.EBAY_CERT_ID || '').trim();
  const basic = Buffer.from(appId + ':' + certId).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope/buy.marketplace.insights'),
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 200);
    try { const e = JSON.parse(text); detail = [e.error, e.error_description].filter(Boolean).join(': ') || detail; } catch {}
    throw new Error('Marketplace Insights scope not granted (' + r.status + '): ' + detail +
      ' — apply for the eBay Buy Marketplace Insights API to enable true sold prices.');
  }
  const j = JSON.parse(text);
  ebayInsTok = { value: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 7200) - 60) * 1000 };
  return ebayInsTok.value;
}

// Test-only: reset both caches so unit tests are deterministic. NEVER called from production code.
export function __resetTokenCaches() { ebayTok = { value: '', exp: 0 }; ebayInsTok = { value: '', exp: 0 }; }
