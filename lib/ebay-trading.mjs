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

// --- GetOrders (post-sale automation) ---
// Reads the seller's orders. Time-windowed by ModTime (the poll cursor — catches payment/ship
// state changes, not just new orders) OR CreateTime; eBay requires the From+To pair together and
// caps the window (30 days ModTime / 90 days CreateTime). Paid gate is the PRESENCE of PaidTime
// (docs: an unpaid order/line omits it) — OrderStatus/CheckoutStatus alone don't prove payment.

// Decode the XML entities eBay escapes in text values (card titles/addresses often carry & and ').
export function decodeEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');   // ampersand last so it doesn't double-decode
}
// xmlField + entity-decode, for human-facing strings (titles, names, addresses).
export function xmlText(xml, tag) { const v = xmlField(xml, tag); return v == null ? null : decodeEntities(v); }

// Extract a currencyID-attributed money node as integer cents (GR3). eBay Price nodes look like
// <Total currencyID="AUD">12.50</Total>. Returns { cents, currency } ({cents:null} when absent).
export function xmlAmount(xml, tag) {
  const m = xml && xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
  if (!m) return { cents: null, currency: null };
  const n = parseFloat(m[1]);
  const cur = (m[0].match(/currencyID="([^"]*)"/) || [])[1] || null;
  return { cents: Number.isFinite(n) ? Math.round(n * 100) : null, currency: cur };
}

export function buildGetOrdersInner({ modTimeFrom, modTimeTo, createTimeFrom, createTimeTo,
  page = 1, entriesPerPage = 100, orderStatus = 'Completed' } = {}) {
  const parts = ['<OrderRole>Seller</OrderRole>'];
  if (orderStatus) parts.push(`<OrderStatus>${xmlEscape(orderStatus)}</OrderStatus>`);
  if (modTimeFrom) parts.push(`<ModTimeFrom>${xmlEscape(modTimeFrom)}</ModTimeFrom>`);
  if (modTimeTo) parts.push(`<ModTimeTo>${xmlEscape(modTimeTo)}</ModTimeTo>`);
  if (createTimeFrom) parts.push(`<CreateTimeFrom>${xmlEscape(createTimeFrom)}</CreateTimeFrom>`);
  if (createTimeTo) parts.push(`<CreateTimeTo>${xmlEscape(createTimeTo)}</CreateTimeTo>`);
  parts.push(`<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`);
  parts.push('<DetailLevel>ReturnAll</DetailLevel>');
  return parts.join('');
}

// Parse a GetOrders response into plain objects. Pure (testable against a captured XML fixture).
// Order-level scalars are read from the order block with its <TransactionArray> spliced out, so a
// same-named line-item field (ItemID/SKU/Title) never shadows an order-level one.
export function parseOrders(xml) {
  const hasMore = /<HasMoreOrders>true<\/HasMoreOrders>/i.test(xml || '');
  const orders = xmlFieldAll(xml || '', 'Order').map((ob) => {
    const txArr = xmlField(ob, 'TransactionArray') || '';
    const head = ob.replace(/<TransactionArray>[\s\S]*?<\/TransactionArray>/, '');
    const co = xmlField(head, 'CheckoutStatus') || '';
    const addr = xmlField(head, 'ShippingAddress') || '';
    const shipSel = xmlField(head, 'ShippingServiceSelected') || '';
    const total = xmlAmount(head, 'Total');
    const subtotal = xmlAmount(head, 'Subtotal');
    const shipCost = xmlAmount(shipSel, 'ShippingServiceCost');
    const paidTime = xmlField(head, 'PaidTime');
    const items = xmlFieldAll(txArr, 'Transaction').map((tb) => {
      const item = xmlField(tb, 'Item') || '';
      const price = xmlAmount(tb, 'TransactionPrice');
      return {
        orderLineItemId: xmlField(tb, 'OrderLineItemID'),
        transactionId: xmlField(tb, 'TransactionID'),
        itemId: xmlField(item, 'ItemID'),
        sku: xmlText(item, 'SKU'),
        title: xmlText(item, 'Title'),
        quantity: parseInt(xmlField(tb, 'QuantityPurchased') || '1', 10) || 1,
        unitPriceCents: price.cents,
      };
    });
    return {
      orderId: xmlField(head, 'OrderID'),
      buyerUsername: xmlField(head, 'BuyerUserID'),
      orderStatus: xmlField(head, 'OrderStatus'),
      checkoutStatus: xmlField(co, 'Status'),
      paidStatus: xmlField(co, 'eBayPaymentStatus'),
      createdTime: xmlField(head, 'CreatedTime'),
      paidTime,
      shippedTime: xmlField(head, 'ShippedTime'),
      currency: total.currency || subtotal.currency || 'AUD',
      totalCents: total.cents,
      subtotalCents: subtotal.cents,
      shippingCents: shipCost.cents,
      shipService: xmlField(shipSel, 'ShippingService'),
      paid: !!paidTime,          // presence of PaidTime is the reliable paid gate
      ship: {
        name: xmlText(addr, 'Name'),
        street1: xmlText(addr, 'Street1'),
        street2: xmlText(addr, 'Street2'),
        city: xmlText(addr, 'CityName'),
        state: xmlText(addr, 'StateOrProvince'),
        postal: xmlField(addr, 'PostalCode'),
        country: xmlField(addr, 'Country'),
        countryName: xmlText(addr, 'CountryName'),
        phone: xmlField(addr, 'Phone'),
      },
      items,
    };
  });
  return { orders, hasMore };
}

// Thin wrapper over tradingCall. One page; the caller loops pages while `hasMore`.
export async function getOrders(env, opts = {}) {
  const res = await tradingCall(env, 'GetOrders', buildGetOrdersInner(opts));
  const parsed = parseOrders(res.xml);
  return { ...res, orders: parsed.orders, hasMore: parsed.hasMore };
}

// --- AddMemberMessageAAQToPartner (send the buyer a message about their purchased item) ---
// eBay KB 1508: a seller can proactively message a buyer about an order via this call. Body is
// PLAIN TEXT, <= 2000 chars, and MUST NOT contain off-eBay contact info (email/phone/links) — eBay
// may silently drop a violating message, so the caller scrubs first (lib/postsale-llm guardrailScrub).
export function buildAddMemberMessageAAQToPartnerInner({ itemId, recipientId, subject, body, questionType = 'General' }) {
  return `<ItemID>${xmlEscape(String(itemId))}</ItemID>`
    + '<MemberMessage>'
    + `<Subject>${xmlEscape(subject || 'Thanks for your order!')}</Subject>`
    + `<Body>${xmlEscape(String(body || ''))}</Body>`
    + `<QuestionType>${xmlEscape(questionType)}</QuestionType>`
    + `<RecipientID>${xmlEscape(String(recipientId))}</RecipientID>`
    + '</MemberMessage>';
}
export async function sendBuyerMessage(env, { itemId, recipientId, subject, body, questionType = 'General' } = {}) {
  const inner = buildAddMemberMessageAAQToPartnerInner({ itemId, recipientId, subject, body, questionType });
  return tradingCall(env, 'AddMemberMessageAAQToPartner', inner);
}

// --- GetMemberMessages (read buyer-sent messages — reply detection + pre-sale questions) ---
// With MailMessageType=AskSellerQuestion, eBay returns only messages FROM buyers (our replies are not
// echoed). Windowed by StartCreationTime/EndCreationTime (the poll cursor). MessageStatus is
// Answered/Unanswered. Returns { messages:[{messageId,senderId,itemId,subject,body,status,creationTime}] }.
export function buildGetMemberMessagesInner({ mailMessageType = 'AskSellerQuestion', startCreationTime, endCreationTime, itemId, page = 1, entriesPerPage = 100 } = {}) {
  const parts = [`<MailMessageType>${xmlEscape(mailMessageType)}</MailMessageType>`];
  if (itemId) parts.push(`<ItemID>${xmlEscape(String(itemId))}</ItemID>`);
  if (startCreationTime) parts.push(`<StartCreationTime>${xmlEscape(startCreationTime)}</StartCreationTime>`);
  if (endCreationTime) parts.push(`<EndCreationTime>${xmlEscape(endCreationTime)}</EndCreationTime>`);
  parts.push(`<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`);
  return parts.join('');
}
export function parseMemberMessages(xml) {
  const hasMore = /<HasMoreItems>true<\/HasMoreItems>/i.test(xml || '');
  const messages = xmlFieldAll(xml || '', 'MemberMessageExchange').map((ex) => {
    const q = xmlField(ex, 'Question') || ex;
    const item = xmlField(ex, 'Item') || '';
    return {
      messageId: xmlField(q, 'MessageID'),
      senderId: xmlField(q, 'SenderID'),
      recipientId: xmlField(q, 'RecipientID'),
      itemId: xmlField(q, 'ItemID') || xmlField(item, 'ItemID'),
      subject: xmlText(q, 'Subject'),
      body: xmlText(q, 'Body'),
      status: xmlField(ex, 'MessageStatus'),
      creationTime: xmlField(ex, 'CreationDate') || xmlField(q, 'CreationDate'),
    };
  }).filter((m) => m.messageId || m.senderId);
  return { messages, hasMore };
}
export async function getMemberMessages(env, opts = {}) {
  const res = await tradingCall(env, 'GetMemberMessages', buildGetMemberMessagesInner(opts));
  const parsed = parseMemberMessages(res.xml);
  return { ...res, messages: parsed.messages, hasMore: parsed.hasMore };
}
