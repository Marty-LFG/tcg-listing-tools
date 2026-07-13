// lib/bricklink.mjs — BrickLink OAuth 1.0a request signing (HMAC-SHA1).
//
// BrickLink authenticates EVERY request with a per-request signature (consumer key/secret +
// token/secret), so it needs a signing helper rather than a static header. Extracted verbatim from
// vite.config.js; the bricklinkProxy middleware there imports bricklinkAuthHeader. The dev server's
// outbound IP must also be registered in the BrickLink API console. Pure crypto — no vite/network.
import crypto from 'node:crypto';

// RFC-3986 percent-encoding (OAuth uses the stricter set — also encode ! * ' ( )).
export function pctEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// The OAuth 1.0a signature base string: METHOD & pct(scheme://host/path) & pct(sorted params).
// `oauthParams` is every oauth_* param EXCEPT oauth_signature, merged with the URL query params.
// Pure + deterministic — the unit harness pins it against a known fixture.
export function oauthBaseString(method, urlObj, oauthParams) {
  const params = [];
  for (const [k, v] of urlObj.searchParams) params.push([k, v]);
  for (const k in oauthParams) params.push([k, oauthParams[k]]);
  const baseParams = params
    .map(([k, v]) => [pctEncode(k), pctEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => k + '=' + v).join('&');
  const baseUrl = urlObj.origin + urlObj.pathname;
  return method.toUpperCase() + '&' + pctEncode(baseUrl) + '&' + pctEncode(baseParams);
}

// Build the `Authorization: OAuth ...` header for a BrickLink request. `opts.timestamp`/`opts.nonce`
// (and `opts.now`) are injectable ONLY for deterministic tests — production callers pass none, so the
// output is byte-identical to the previous inline implementation.
export function bricklinkAuthHeader(method, urlObj, cred, opts = {}) {
  const oauth = {
    oauth_consumer_key: cred.consumerKey,
    oauth_token: cred.token,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: opts.timestamp ?? Math.floor((opts.now ?? Date.now()) / 1000).toString(),
    oauth_nonce: opts.nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
  const base = oauthBaseString(method, urlObj, oauth);
  const signingKey = pctEncode(cred.consumerSecret) + '&' + pctEncode(cred.tokenSecret);
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).map(k => pctEncode(k) + '="' + pctEncode(oauth[k]) + '"').join(', ');
}
