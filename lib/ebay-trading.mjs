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

function compatLevel(env) { return trim(env.EBAY_COMPAT_LEVEL) || '1409'; }
function siteId(env) {
  if (trim(env.EBAY_SITEID)) return trim(env.EBAY_SITEID);
  return trim(env.EBAY_MARKETPLACE) === 'EBAY_AU' || !trim(env.EBAY_MARKETPLACE) ? '15' : '0';
}

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

// Core call. `innerXml` is the body between <CallNameRequest> and </CallNameRequest> (no
// RequesterCredentials). Returns { httpStatus, ok, ack, errors, xml }.
export async function tradingCall(env, callName, innerXml = '', { token } = {}) {
  const tok = token || await getUserAccessToken(env);
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    innerXml +
    `</${callName}Request>`;
  const headers = {
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-COMPATIBILITY-LEVEL': compatLevel(env),
    'X-EBAY-API-SITEID': siteId(env),
    'X-EBAY-API-IAF-TOKEN': tok,
    'Content-Type': 'text/xml',
  };
  // Some accounts still require the app-identity headers alongside IAF; include them only if a
  // Dev ID is configured (IAF alone is normally sufficient).
  if (trim(env.EBAY_DEV_ID)) {
    headers['X-EBAY-API-DEV-NAME'] = trim(env.EBAY_DEV_ID);
    headers['X-EBAY-API-APP-NAME'] = trim(env.EBAY_APP_ID);
    headers['X-EBAY-API-CERT-NAME'] = trim(env.EBAY_CERT_ID);
  }
  const r = await fetch(TRADING_URL, { method: 'POST', headers, body });
  const xml = await r.text();
  const ack = xmlField(xml, 'Ack');
  return { httpStatus: r.status, ok: r.ok && (ack === 'Success' || ack === 'Warning'), ack, errors: xmlErrors(xml), xml };
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
