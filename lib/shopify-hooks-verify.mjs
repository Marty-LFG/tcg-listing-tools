// lib/shopify-hooks-verify.mjs — the crypto half of Shopify webhook ingestion, kept deliberately apart
// from lib/keepers-hooks.mjs so it can be reasoned about and tested with no server, no database and no
// network. Everything here is pure. Zero dependencies beyond node:crypto.
//
// Same split, and the same reasoning, as lib/ebay-notify-verify.mjs — but the scheme itself is much
// smaller. There is no challenge handshake, no key fetch, no key cache, no ECDSA. One HMAC.
//
// THIS IS NOT THE SAME SCHEME AS THE APP PROXY, and confusing the two is the whole reason they live in
// separate files:
//
//   webhooks    HMAC-SHA256 over the RAW REQUEST BODY BYTES  -> base64 -> X-Shopify-Hmac-SHA256
//   app proxy   HMAC-SHA256 over SORTED QUERY PARAMETERS     -> hex    -> ?signature=
//
// Both are keyed on the same app client secret. A function that verified one where the other was meant
// would reject every genuine request, which is survivable — but the reverse mistake, sharing a
// "verify" helper that silently accepts either construction, is not. Hence two modules, no shared code.
import crypto from 'node:crypto';

// The header Shopify signs with. Case-insensitive in HTTP; node lowercases incoming header names.
export const HMAC_HEADER = 'x-shopify-hmac-sha256';

/**
 * secretProblem(secret)
 *
 * Checked when the listener ARMS, not when Shopify calls. A missing or obviously wrong secret should be
 * a refusal to start with a reason on it, rather than an endpoint that quietly 401s every genuine
 * webhook for months while the ledger silently falls behind — which is exactly the failure the
 * reconcile sweep would then paper over without anyone learning why it was working so hard.
 *
 * Returns a human-readable problem string, or null when the secret is usable.
 */
export function secretProblem(secret) {
  const s = String(secret ?? '');
  if (!s) return 'not set — SHOPIFY_CLIENT_SECRET is missing from .env';
  if (/\s/.test(s)) return 'contains whitespace — check for a stray newline or quote in .env';
  if (s.length < 16) return `implausibly short (${s.length} chars) — this is the app client secret, not the client id`;
  return null;
}

/**
 * verifyWebhookHmac(secret, rawBody, headerValue)
 *
 * rawBody MUST be the exact bytes Shopify sent — a Buffer, or a string that has not been through
 * JSON.parse and re-stringify. Round-tripping the body through an object reorders keys, changes number
 * formatting and drops insignificant whitespace, all of which are invisible in the parsed data and
 * fatal to the signature. This is why lib/keepers-hooks.mjs reads the body itself rather than using
 * lib/req-body.mjs, which discards the raw buffer.
 *
 * Returns { ok, reason } and NEVER throws: every input here is attacker-controlled.
 */
export function verifyWebhookHmac(secret, rawBody, headerValue) {
  try {
    if (secretProblem(secret)) return { ok: false, reason: 'secret_unusable' };
    if (rawBody === null || rawBody === undefined) return { ok: false, reason: 'no_body' };

    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    // An empty body is not a valid webhook. Refuse rather than verify the HMAC of nothing, which is a
    // perfectly computable value that an attacker can also compute.
    if (body.length === 0) return { ok: false, reason: 'empty_body' };

    const provided = String(headerValue ?? '').trim();
    if (!provided) return { ok: false, reason: 'no_signature' };

    const expected = crypto.createHmac('sha256', String(secret)).update(body).digest();

    // Decode the claimed signature rather than comparing base64 text. Base64 has more than one
    // encoding for the same bytes (padding, and non-canonical trailing bits), so a text comparison can
    // reject a genuine signature that merely arrived spelled differently.
    let claimed;
    try { claimed = Buffer.from(provided, 'base64'); }
    catch { return { ok: false, reason: 'signature_not_base64' }; }

    // timingSafeEqual throws on a length mismatch, which would itself be a timing signal and a crash.
    // Check the length first and fail closed.
    if (claimed.length !== expected.length) return { ok: false, reason: 'signature_wrong_length' };
    if (!crypto.timingSafeEqual(claimed, expected)) return { ok: false, reason: 'signature_mismatch' };

    return { ok: true, reason: null };
  } catch {
    // Any unexpected throw is a rejection, never an acceptance.
    return { ok: false, reason: 'verify_threw' };
  }
}

/**
 * readWebhookHeaders(headers)
 *
 * Pulls the five headers the ingest path actually reasons about. Returns strings or null; validates
 * nothing beyond presence, because the caller records the event before deciding what to do with it.
 *
 * webhookId is the DEDUPE KEY and it is the primary key of keepers_webhooks — Shopify delivers
 * at-least-once, so the same event arrives more than once as a matter of course rather than as a fault.
 *
 * triggeredAt is SHOPIFY'S CLOCK, and it is the only usable ordering signal: delivery is explicitly
 * unordered, so arrival order means nothing. (Same note as notify_events.event_date carries for eBay.)
 */
export function readWebhookHeaders(headers) {
  const h = headers || {};
  const get = (name) => {
    const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
    if (v === undefined || v === null) return null;
    const s = Array.isArray(v) ? v[0] : v;
    const t = String(s).trim();
    return t === '' ? null : t;
  };
  return {
    webhookId: get('x-shopify-webhook-id'),
    topic: get('x-shopify-topic'),
    shopDomain: get('x-shopify-shop-domain'),
    triggeredAt: get('x-shopify-triggered-at'),
    apiVersion: get('x-shopify-api-version'),
    hmac: get(HMAC_HEADER),
  };
}

/**
 * shopDomainProblem(shopDomain, expectedShop)
 *
 * A valid signature proves the request came from Shopify. It does NOT prove it came from OUR shop —
 * the same app installed on any other store signs with the same client secret. Without this check, a
 * webhook from an unrelated store the app is installed on would be ingested as if it were ours.
 *
 * Cheap, and the failure it prevents is a ledger quietly accruing XP for strangers' orders.
 */
export function shopDomainProblem(shopDomain, expectedShop) {
  const got = String(shopDomain ?? '').trim().toLowerCase();
  const want = String(expectedShop ?? '').trim().toLowerCase();
  if (!want) return 'no expected shop configured';
  if (!got) return 'no shop domain on the request';
  const norm = (s) => (s.endsWith('.myshopify.com') ? s : `${s}.myshopify.com`);
  return norm(got) === norm(want) ? null : `shop mismatch: ${got} is not ${norm(want)}`;
}
