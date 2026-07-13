// lib/ebay-trading.mjs — low-level eBay Trading (Traditional/XML) API caller, signed with the
// OAuth USER token from lib/ebay-oauth.mjs.
//
// Why Trading (not the REST Sell Inventory API): our listings are created MANUALLY in Seller Hub,
// and only the Trading API can read/revise them by legacy ItemID (see AGENTS.md §13). This module
// is the shared transport; Phase 3/4 add the GetMyeBaySelling / ReviseInventoryStatus /
// ReviseFixedPriceItem builders on top. Phase 2 ships only the transport + two smoke calls that
// prove the user token authenticates end-to-end.
//
// OAuth-with-Trading rules (per eBay's "Using OAuth with the traditional APIs"):
//   - token goes in the X-EBAY-API-IAF-TOKEN header (NOT Authorization)
//   - omit <RequesterCredentials> from the XML body entirely
//   - X-EBAY-API-COMPATIBILITY-LEVEL required; X-EBAY-API-SITEID = 15 for eBay AU (EBAY_AU)
// No XML dependency — requests are string-built and responses parsed with focused regex (the fields
// we need are simple scalars). eBay escapes special chars in values, so a full parser isn't needed.
import { getUserAccessToken } from './ebay-oauth.mjs';

const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const trim = (s) => (s || '').trim();

export function compatLevel(env) { return trim(env.EBAY_COMPAT_LEVEL) || '1409'; }
export function siteId(env) {
  if (trim(env.EBAY_SITEID)) return trim(env.EBAY_SITEID);
  return trim(env.EBAY_MARKETPLACE) === 'EBAY_AU' || !trim(env.EBAY_MARKETPLACE) ? '15' : '0';
}

// Escape a value for embedding as text inside a Trading XML node.
export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// GR3: money is integer cents everywhere in the app; eBay's Price nodes want a dotted decimal.
export function centsToXmlPrice(cents) { return (Math.round(+cents) / 100).toFixed(2); }

// Minimal XML scalar extractor: first <tag ...>value</tag> (tag may carry attributes).
export function xmlField(xml, tag) {
  const m = xml && xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1] : null;
}
export function xmlFieldAll(xml, tag) {
  const out = [], re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
  let m; while (xml && (m = re.exec(xml))) out.push(m[1]);
  return out;
}
// Pull all <Errors>…</Errors> blocks (short/long message + code + severity) for diagnostics.
export function xmlErrors(xml) {
  const out = [], re = /<Errors>([\s\S]*?)<\/Errors>/g;
  let m; while (xml && (m = re.exec(xml))) {
    const b = m[1];
    out.push({
      code: xmlField(b, 'ErrorCode'),
      severity: xmlField(b, 'SeverityCode'),
      shortMessage: xmlField(b, 'ShortMessage'),
      longMessage: xmlField(b, 'LongMessage'),
    });
  }
  return out;
}

// The XML request envelope for a Trading call (no RequesterCredentials — the IAF token authenticates).
export function buildTradingBody(callName, innerXml = '') {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    innerXml +
    `</${callName}Request>`;
}
// The Trading request headers: call name, compat level, site 15 (AU), and the OAuth USER token in
// X-EBAY-API-IAF-TOKEN (NOT Authorization). Some accounts also want the app-identity headers — added
// only when EBAY_DEV_ID is configured (IAF alone is normally sufficient).
export function buildTradingHeaders(env, callName, token) {
  const headers = {
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-COMPATIBILITY-LEVEL': compatLevel(env),
    'X-EBAY-API-SITEID': siteId(env),
    'X-EBAY-API-IAF-TOKEN': token,
    'Content-Type': 'text/xml',
  };
  if (trim(env.EBAY_DEV_ID)) {
    headers['X-EBAY-API-DEV-NAME'] = trim(env.EBAY_DEV_ID);
    headers['X-EBAY-API-APP-NAME'] = trim(env.EBAY_APP_ID);
    headers['X-EBAY-API-CERT-NAME'] = trim(env.EBAY_CERT_ID);
  }
  return headers;
}

// Core call. `innerXml` is the body between <CallNameRequest> and </CallNameRequest> (no
// RequesterCredentials). Returns { httpStatus, ok, ack, errors, xml }.
export async function tradingCall(env, callName, innerXml = '', { token } = {}) {
  const tok = token || await getUserAccessToken(env);
  const body = buildTradingBody(callName, innerXml);
  const headers = buildTradingHeaders(env, callName, tok);
  const r = await fetch(TRADING_URL, { method: 'POST', headers, body });
  const xml = await r.text();
  const ack = xmlField(xml, 'Ack');
  return { httpStatus: r.status, ok: r.ok && (ack === 'Success' || ack === 'Warning'), ack, errors: xmlErrors(xml), xml };
}

// --- Phase-4 price-write inner-XML builders (pure; not yet wired to a live call) ---
// ReviseInventoryStatus is the least-invasive price bump (up to 4 items/call); ReviseFixedPriceItem
// carries Best-Offer floor thresholds. Both key off the legacy ItemID and format the new price from
// integer cents (GR3). The up-only guard + Telegram approval live at the repricer layer, not here.
export function buildReviseInventoryStatusInner({ itemId, priceCents }) {
  return '<InventoryStatus>'
    + `<ItemID>${xmlEscape(String(itemId))}</ItemID>`
    + `<StartPrice>${centsToXmlPrice(priceCents)}</StartPrice>`
    + '</InventoryStatus>';
}
export function buildReviseFixedPriceItemInner({ itemId, priceCents }) {
  return '<Item>'
    + `<ItemID>${xmlEscape(String(itemId))}</ItemID>`
    + `<StartPrice>${centsToXmlPrice(priceCents)}</StartPrice>`
    + '</Item>';
}

// --- smoke tests (Phase 2) ---

// GeteBayOfficialTime — cheapest connectivity check (confirms headers/compat/site are accepted).
export async function geteBayOfficialTime(env) {
  const res = await tradingCall(env, 'GeteBayOfficialTime', '');
  return { ...res, timestamp: xmlField(res.xml, 'Timestamp') };
}

// GetUser — confirms the USER token specifically works: returns the authenticated seller's own
// account (UserID/email only come back when you call it for yourself), proving consent succeeded.
export async function getUser(env) {
  const res = await tradingCall(env, 'GetUser', '<DetailLevel>ReturnSummary</DetailLevel>');
  return {
    ...res,
    userId: xmlField(res.xml, 'UserID'),
    email: xmlField(res.xml, 'Email'),
    feedbackScore: xmlField(res.xml, 'FeedbackScore'),
    registrationDate: xmlField(res.xml, 'RegistrationDate'),
    site: xmlField(res.xml, 'Site'),
  };
}
