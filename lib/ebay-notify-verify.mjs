// lib/ebay-notify-verify.mjs — the crypto half of eBay push notifications, kept deliberately apart
// from lib/ebay-notify.mjs so it can be reasoned about and tested with no server, no database and no
// network. Everything here is pure except the public-key cache and the one fetch behind it.
//
// Two separate handshakes live here, and they are easy to confuse:
//
//   1. The CHALLENGE (a GET, once, when eBay validates the endpoint you registered). eBay sends
//      ?challenge_code=… and expects back the SHA-256 of three strings concatenated in one exact
//      order. Get the order wrong and you produce a perfectly valid-looking hash that eBay rejects
//      with no diagnostic — the destination simply refuses to create.
//
//   2. The SIGNATURE (every POST thereafter). eBay signs the request body with an ECDSA key and
//      names the key in the header; you fetch the public half by id and verify. This is the only
//      thing standing between a public HTTPS endpoint and anyone who finds the URL, so it fails
//      CLOSED everywhere: any doubt at all returns not-ok rather than assuming good faith.
//
// Zero dependencies (node:crypto + global fetch via lib/ebay-rest.mjs).
import crypto from 'node:crypto';
import { ebayGet, firstErrorText } from './ebay-rest.mjs';
import { ebayToken } from './ebay-token.mjs';

// --- 1. the challenge handshake ---

/**
 * computeChallengeResponse(challengeCode, verificationToken, endpoint)
 *
 * THE ORDER OF THESE THREE IS LOAD-BEARING and is the single most common way this is got wrong:
 * hashing the same three strings in any other order yields a hash that looks entirely legitimate and
 * that eBay will not accept. `endpoint` is the exact public HTTPS URL as registered — same scheme,
 * same case, no trailing slash — not the loopback address this process actually listens on.
 */
export function computeChallengeResponse(challengeCode, verificationToken, endpoint) {
  return crypto.createHash('sha256')
    .update(String(challengeCode ?? ''))
    .update(String(verificationToken ?? ''))
    .update(String(endpoint ?? ''))
    .digest('hex');
}

// eBay's own constraint on the verification token: 32-80 chars, letters/digits/_/- only. Checked when
// the listener arms rather than when eBay calls, so a bad token is a refusal to start with a clear
// reason instead of a challenge that mysteriously fails months later.
const TOKEN_RE = /^[A-Za-z0-9_-]{32,80}$/;
export function verificationTokenProblem(token) {
  const t = String(token ?? '');
  if (!t) return 'not set';
  if (!TOKEN_RE.test(t)) return 'must be 32-80 characters of A-Z a-z 0-9 _ - only (eBay rejects anything else)';
  return null;
}

// --- 2. signature verification ---

/**
 * The X-EBAY-SIGNATURE header is base64 of a small JSON object. We need `kid` (which public key) and
 * `signature` (base64, DER-encoded ECDSA). `alg`/`digest` are advisory — eBay's own SDK ignores them
 * and hardcodes ECDSA-SHA1 — but they are read here so that a future rotation to SHA-256 is a loud
 * failure rather than a silent one that rejects every genuine notification.
 *
 * Returns null (never throws) on anything malformed: this parses attacker-controlled input.
 */
export function parseSignatureHeader(header) {
  try {
    const raw = Buffer.from(String(header || ''), 'base64').toString('utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    if (!j.kid || !j.signature) return null;
    return { kid: String(j.kid), signature: String(j.signature), alg: j.alg || null, digest: j.digest || null };
  } catch { return null; }
}

// eBay returns the public key as bare base64 SPKI, sometimes already carrying the PEM markers but
// with no line breaks. Node needs real PEM, so normalise either shape into one.
export function toPem(key) {
  const s = String(key || '').trim();
  if (!s) return null;
  const body = s.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  if (!body) return null;
  return '-----BEGIN PUBLIC KEY-----\n' + (body.match(/.{1,64}/g) || []).join('\n') + '\n-----END PUBLIC KEY-----\n';
}

// digest name -> node hash. Unknown values throw rather than defaulting, because silently picking the
// wrong hash rejects every real notification and looks identical to an attack.
function hashFor(digest) {
  const d = String(digest || 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (d === 'SHA1') return 'sha1';
  if (d === 'SHA256') return 'sha256';
  if (d === 'SHA512') return 'sha512';
  throw new Error('unsupported signature digest: ' + digest);
}

// --- 3. the public-key cache ---
//
// The Notification API allowance is 10,000 calls a day and getPublicKey draws on it, so this cache is
// not an optimisation — without it, anyone who finds the endpoint can spend the day's quota by POSTing
// garbage key ids. Three defences, in order of how much they matter:
//
//   NEGATIVE cache: a kid that failed to resolve is remembered for 10 minutes. This is the one that
//     stops the attack above, because an attacker picks kids that do not exist.
//   POSITIVE cache: never expires. A key id names an immutable key, so there is nothing to refresh;
//     bounded at 32 entries so a flood of valid-looking ids still cannot grow it without limit.
//   HOURLY CEILING: a hard cap on fetches per clock hour. Past it we fail closed. Real traffic uses
//     one or two kids, so any number near this ceiling is already an incident.
const MAX_KEYS = 32;
const NEG_TTL_MS = 10 * 60_000;
const MAX_FETCHES_PER_HOUR = 20;

const _keys = new Map();      // kid -> { pem, algorithm, digest }
const _neg = new Map();       // kid -> { at, reason }
let _window = { hour: -1, n: 0 };

export function __resetKeyCache() {            // test seam, mirrors __resetTokenCaches()
  _keys.clear(); _neg.clear(); _window = { hour: -1, n: 0 };
}
export function keyCacheStats() {
  return { cached: _keys.size, negative: _neg.size, fetches_this_hour: _window.n };
}

function hourNow(now) { return Math.floor(now / 3_600_000); }
function takeFetchSlot(now) {
  const h = hourNow(now);
  if (_window.hour !== h) _window = { hour: h, n: 0 };
  if (_window.n >= MAX_FETCHES_PER_HOUR) return false;
  _window.n++;
  return true;
}

/**
 * Fetch (and cache) one of eBay's notification public keys by id.
 * Uses the APPLICATION token, not the user token — this endpoint is app-scoped, and ebayRest would
 * otherwise mint a user token and fail on a box that has never consented.
 */
export async function getPublicKey(env, kid, { now = Date.now() } = {}) {
  const hit = _keys.get(kid);
  if (hit) return hit;
  const neg = _neg.get(kid);
  if (neg && (now - neg.at) < NEG_TTL_MS) return null;
  if (!takeFetchSlot(now)) {
    console.warn('[ebay-notify] public-key fetch ceiling hit (' + MAX_FETCHES_PER_HOUR + '/h) — refusing until the hour rolls');
    return null;
  }
  let r;
  try {
    const tok = await ebayToken(env);
    r = await ebayGet(env, '/commerce/notification/v1/public_key/' + encodeURIComponent(kid), { token: tok });
  } catch (e) {
    _neg.set(kid, { at: now, reason: String(e?.message || e) });
    return null;
  }
  if (!r || !r.ok || !r.json || !r.json.key) {
    _neg.set(kid, { at: now, reason: (r && firstErrorText(r.json)) || ('http ' + (r && r.httpStatus)) });
    return null;
  }
  const pem = toPem(r.json.key);
  if (!pem) { _neg.set(kid, { at: now, reason: 'unusable key material' }); return null; }
  if (_keys.size >= MAX_KEYS) _keys.delete(_keys.keys().next().value);   // evict oldest
  const rec = { pem, algorithm: r.json.algorithm || null, digest: r.json.digest || null };
  _keys.set(kid, rec);
  _neg.delete(kid);
  return rec;
}

/**
 * verifyNotification(env, header, rawBody, opts) -> { ok, reason }
 *
 * `rawBody` must be the EXACT bytes eBay sent. eBay's own Node SDK re-serialises the parsed body with
 * JSON.stringify and verifies against that, which only works while their serialisation happens to
 * round-trip; any non-ASCII escaping or number formatting difference breaks it. Verifying the bytes we
 * actually received is both simpler and strictly correct, which is why the listener reads the body as
 * a Buffer and never lets a JSON body-parser near it first.
 *
 * fetchKey is injectable so the unit suite can drive this with a locally generated keypair — it never
 * needs eBay, and it stays valid whichever digest eBay turns out to be using.
 */
export async function verifyNotification(env, header, rawBody, { fetchKey = getPublicKey, now = Date.now() } = {}) {
  const sig = parseSignatureHeader(header);
  if (!sig) return { ok: false, reason: 'bad_header' };
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return { ok: false, reason: 'empty_body' };

  let key;
  try { key = await fetchKey(env, sig.kid, { now }); }
  catch (e) { return { ok: false, reason: 'key_fetch_failed:' + String(e?.message || e) }; }
  if (!key || !key.pem) return { ok: false, reason: 'no_key' };

  let hash;
  try { hash = hashFor(sig.digest || key.digest); }
  catch (e) { return { ok: false, reason: String(e?.message || e) }; }

  try {
    const ok = crypto.verify(hash, rawBody, { key: key.pem, dsaEncoding: 'der' }, Buffer.from(sig.signature, 'base64'));
    return ok ? { ok: true, reason: null, kid: sig.kid } : { ok: false, reason: 'bad_signature' };
  } catch (e) {
    // A malformed signature makes OpenSSL throw rather than return false. Same outcome either way.
    return { ok: false, reason: 'verify_error:' + String(e?.code || e?.message || e) };
  }
}
