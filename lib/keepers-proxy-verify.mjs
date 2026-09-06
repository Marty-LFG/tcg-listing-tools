// lib/keepers-proxy-verify.mjs — the crypto half of Shopify App Proxy requests. Pure, offline,
// zero dependencies beyond node:crypto. Kept apart from the webhook verifier ON PURPOSE.
//
// An app proxy is how a Liquid page on the storefront reaches this server at all: the customer's
// browser calls https://binderskeepers.cards/apps/keepers/..., Shopify forwards it here with a
// signature and (usually — see below) the logged-in customer's id. It is the only authenticated
// storefront -> our-server path available on Basic, and it is what makes the QR show check-in possible.
//
// THE SCHEME IS NOT THE WEBHOOK SCHEME. Read this before touching anything here:
//
//   webhooks    HMAC-SHA256 over the RAW BODY BYTES          -> BASE64 -> X-Shopify-Hmac-SHA256
//   app proxy   HMAC-SHA256 over SORTED QUERY PARAMETERS     -> HEX    -> ?signature=
//
// Same secret, different construction, different encoding. They are in separate files with no shared
// helper so that a "verify" function can never be pointed at the wrong one.
//
// FOUR WAYS THE SIGNED STRING IS GOT WRONG, all of which produce a valid-looking hex digest that
// simply does not match, with no diagnostic:
//
//   1. Values are URL-DECODED before signing. path_prefix arrives as %2Fapps%2Fkeepers and is signed
//      as /apps/keepers. Naive raw-query-string splitting signs the encoded form.
//   2. Repeated keys join with a COMMA: extra=1&extra=2 signs as `extra=1,2`.
//   3. An empty logged_in_customer_id is INCLUDED as `logged_in_customer_id=`, never dropped.
//   4. The sorted `key=value` pairs are concatenated with NO DELIMITER. Not '&'. Not anything.
//
// Shopify also warns not to assume the documented parameter list is exhaustive, so this builds the
// signed string from whatever actually arrived rather than from a hardcoded allowlist.
//
// AND THE PART THAT IS NOT CRYPTOGRAPHY: a valid signature proves SHOPIFY sent the request. It does
// not prove the request is fresh, and it does not prove the caller owns the customer id in it. The
// docs describe no replay protection at all, which is why timestampProblem() exists and why the
// caller must treat logged_in_customer_id as the only identity signal and never trust a customer id
// supplied in the body.
import crypto from 'node:crypto';

/**
 * buildSignedString(query)
 *
 * Accepts a URLSearchParams, a raw query string, or a plain object of key -> string | string[].
 * Returns the exact string Shopify HMACs.
 *
 * Exported separately from the verify so it can be asserted against Shopify's own published worked
 * examples. That matters more than it looks: their published SIGNATURES are not reproducible (the
 * examples carry a redacted `{shop}` placeholder, so the string that was actually signed is not the
 * string printed), but their published SIGNED STRINGS are literal. So the construction — which is the
 * half that is easy to get wrong — can be tested against Shopify's own output, while the HMAC half is
 * tested with locally generated vectors.
 */
export function buildSignedString(query) {
  const params = toSearchParams(query);
  const grouped = new Map();
  for (const [key, value] of params) {
    if (key === 'signature') continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  const parts = [];
  for (const [key, values] of grouped) parts.push(`${key}=${values.join(',')}`);
  // Lexicographic sort of the whole `key=value` string, matching the reference implementation's
  // `.sort` over the assembled pairs — NOT a sort of the keys alone. For the ASCII parameter names
  // Shopify sends the two agree, but they are not the same operation and the reference is the one to
  // follow.
  parts.sort();
  return parts.join('');
}

function toSearchParams(query) {
  if (query instanceof URLSearchParams) return query;
  if (typeof query === 'string') return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (query && typeof query === 'object') {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const one of v) p.append(k, String(one));
      else if (v !== undefined && v !== null) p.append(k, String(v));
      else p.append(k, '');
    }
    return p;
  }
  return new URLSearchParams();
}

/**
 * verifyProxySignature(secret, query)
 *
 * Returns { ok, reason } and never throws. Fails closed on everything.
 */
export function verifyProxySignature(secret, query) {
  try {
    const s = String(secret ?? '');
    if (!s) return { ok: false, reason: 'secret_unusable' };

    const params = toSearchParams(query);
    const provided = params.get('signature');
    if (!provided) return { ok: false, reason: 'no_signature' };
    // Hex, lowercase, 64 chars for SHA-256. Reject early rather than hand junk to Buffer.from, which
    // silently ignores non-hex characters and would happily produce a short buffer.
    if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: 'signature_not_hex' };

    const signed = buildSignedString(params);
    if (!signed) return { ok: false, reason: 'no_parameters' };

    const expected = crypto.createHmac('sha256', s).update(signed, 'utf8').digest();
    const claimed = Buffer.from(provided, 'hex');
    if (claimed.length !== expected.length) return { ok: false, reason: 'signature_wrong_length' };
    if (!crypto.timingSafeEqual(claimed, expected)) return { ok: false, reason: 'signature_mismatch' };

    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'verify_threw' };
  }
}

/**
 * timestampProblem(timestamp, opts)
 *
 * Shopify documents NO replay protection on app proxy requests — a captured URL stays valid forever
 * unless we say otherwise. For a state-changing endpoint (granting XP) that is the difference between
 * one check-in and an unbounded number of them, so freshness is enforced here and idempotency is
 * enforced in the database. Neither alone is enough: freshness without idempotency lets a fast replay
 * through, idempotency without freshness lets last year's URL work today.
 *
 * `timestamp` is SECONDS since epoch, as a string, per the documented parameter.
 *
 * A small future tolerance is allowed because the two clocks are not the same clock; without it a
 * server running a few seconds slow rejects every genuine request, which reads exactly like a broken
 * secret and would send someone looking in entirely the wrong place.
 */
export function timestampProblem(timestamp, { nowMs = Date.now(), maxAgeSec = 120, maxFutureSec = 60 } = {}) {
  const raw = String(timestamp ?? '').trim();
  if (!raw) return 'no timestamp';
  if (!/^\d{1,15}$/.test(raw)) return 'timestamp is not an integer number of seconds';
  const ageSec = Math.floor(nowMs / 1000) - Number(raw);
  if (ageSec > maxAgeSec) return `stale by ${ageSec - maxAgeSec}s (older than ${maxAgeSec}s)`;
  if (ageSec < -maxFutureSec) return `${-ageSec}s in the future (beyond ${maxFutureSec}s of clock skew)`;
  return null;
}

/**
 * loggedInCustomerGid(query)
 *
 * Returns a customer GID, or null when Shopify did not tell us who this is.
 *
 * ⚠ THE RELIABILITY CAVEAT THAT SHAPES EVERY CALLER. Shopify's docs say this parameter carries the
 * logged-in customer. Field reports since late 2024 — and, as of 2026-08-04, an acknowledged Shopify
 * internal investigation with no fix and no timeline — say it is intermittently EMPTY for genuinely
 * logged-in customers, and can go STALE after logout, specifically on NEW customer accounts. This
 * store is on new customer accounts (D-024).
 *
 * The rules that fall out of that, and they are not negotiable:
 *
 *   - null means REFUSE and tell the customer to try again. It never means "fall back to something".
 *   - never accept a customer id from the request body or a form field as a substitute. A valid
 *     signature proves Shopify sent the request; it proves nothing about whose account is in it, and
 *     Shopify's own guidance is that an API server "could trust the session token's sub claim but
 *     could not trust a ?customer_id= query parameter".
 *   - nothing that SPENDS value may be built on this signal. Granting 50 XP can tolerate an occasional
 *     "tap again"; debiting points cannot tolerate crediting the wrong account.
 */
export function loggedInCustomerGid(query) {
  const params = toSearchParams(query);
  const raw = String(params.get('logged_in_customer_id') ?? '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  return `gid://shopify/Customer/${raw}`;
}

/**
 * pathPrefixProblem(query, expectedPrefix)
 *
 * The merchant can rename the proxy subpath per store, and that change takes effect immediately on
 * that store while the app config keeps whatever it was created with. So the request tells us the
 * prefix, and the app must not hardcode it.
 *
 * This is a soft check used for diagnosis only — it must NOT gate the request, because a merchant
 * renaming the path is a legitimate act that would otherwise take the check-in offline with a signature
 * that verified perfectly. Returns a description of the mismatch, or null.
 */
export function pathPrefixProblem(query, expectedPrefix) {
  const got = String(toSearchParams(query).get('path_prefix') ?? '').trim();
  const want = String(expectedPrefix ?? '').trim();
  if (!want || !got) return null;
  return got === want ? null : `path_prefix is ${got}, expected ${want} — the subpath was probably renamed in the store admin`;
}
