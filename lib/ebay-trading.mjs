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

// An eBay money node ("<X currencyID="AUD">8.00</X>") as integer cents, or NULL when the element was
// not there at all.
//
// The null matters more than the number. This used to be `Number(String(s ?? '').replace(...))`, and
// Number('') is 0 — so a MISSING element parsed as A$0.00 rather than "don't know". That is the exact
// confusion the postage comment below says must never happen: a listing whose GetItem carried no
// ShippingServiceCost reported free postage, and free postage is what lets the repricer treat a
// delivered comp as a list price. It also silently disabled the `CurrentPrice ?? StartPrice` fallback,
// because `0 ?? x` is 0.
export function xmlMoneyCents(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^0-9.]/g, '');
  if (!/\d/.test(cleaned)) return null;              // '', '.', 'AUD' → absent, not zero
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
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
// A boolean eBay flag as true/false, or NULL when the element was absent. Same reasoning as
// xmlMoneyCents: "eBay didn't tell us" is a third state, and collapsing it to false is a lie. It
// matters for BuyerSelectedShipping, where false means "eBay picked the service, ignore the cost"
// and absent means "this response just doesn't carry the flag".
export function xmlBool(xml, tag) {
  const v = xmlField(xml, tag);
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' ? true : (s === 'false' || s === '0' ? false : null);
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
// `availableQty` is the quantity eBay should leave AVAILABLE — eBay re-adds QuantitySold itself
// ("Quantity in the request is the quantity available, and Quantity in the response is quantity
// available plus already sold", ReviseInventoryStatus change log 0695; worked example in KB 1525).
// NEVER pass a total here: on a listing that has sold 7, passing the total oversells by 7.
// Child order is the documented sequence ItemID, Quantity, SKU, StartPrice — the schema is a
// sequence, and this is not the place to test eBay's tolerance. Either field may be omitted, but not
// both. Up to four containers per call; this builds one.
export function buildReviseInventoryStatusInner({ itemId, priceCents, availableQty }) {
  const parts = [`<ItemID>${xmlEscape(String(itemId))}</ItemID>`];
  if (availableQty != null) parts.push(`<Quantity>${Math.max(0, Math.floor(availableQty))}</Quantity>`);
  if (priceCents != null) parts.push(`<StartPrice>${centsToXmlPrice(priceCents)}</StartPrice>`);
  return '<InventoryStatus>' + parts.join('') + '</InventoryStatus>';
}

// What eBay says this listing is doing RIGHT NOW. A revise is computed from these numbers, never from
// our mirror: the mirror is only as fresh as the last import, and a sale between then and now would
// make a quantity write wrong.
export async function getListingState(env, itemId) {
  const res = await tradingCall(env, 'GetItem', `<ItemID>${xmlEscape(String(itemId))}</ItemID>`);
  if (!res.ok) {
    const e = (res.errors && res.errors[0]) || {};
    return { ok: false, error: e.longMessage || e.shortMessage || ('HTTP ' + res.httpStatus) };
  }
  const item = xmlField(res.xml, 'Item') || res.xml || '';
  const selling = xmlField(item, 'SellingStatus') || '';
  const num = (s) => { const n = parseInt(s || '', 10); return Number.isFinite(n) ? n : null; };
  const money = xmlMoneyCents;
  const total = num(xmlField(item, 'Quantity'));
  const sold = num(xmlField(selling, 'QuantitySold')) || 0;

  // --- the fields the repricer needs, and why each one is a refusal rather than a detail ---
  // POSTAGE. Comps are DELIVERED prices (competitor list + competitor postage), while price_cents
  // here is a LIST price. Without our own postage the two cannot be compared, so an unknown stays
  // NULL and is never read as free — reading it as free prices every listing above the market.
  // Calculated postage genuinely has no fixed cost in the listing, hence the explicit null.
  const shipping = xmlField(item, 'ShippingDetails') || '';
  const shipping_type = (xmlText(shipping, 'ShippingType') || '').trim() || null;
  const firstOption = xmlField(shipping, 'ShippingServiceOptions') || '';
  const postage_cents = /calculated/i.test(shipping_type || '') ? null : money(xmlField(firstOption, 'ShippingServiceCost'));
  // BEST OFFER. auto-accept is an ABSOLUTE amount fixed when the listing was created, so raising the
  // list price does not move it — a successful raise silently widens the discount.
  //
  // The two thresholds hang off ListingDetails, NOT BestOfferDetails (which carries only the on/off
  // flag and the offer count), and eBay returns them to the seller only when that automation is
  // actually switched on. Absent therefore reads as "not set" — which is only safe to conclude now
  // that xmlMoneyCents distinguishes an absent element from A$0.00.
  const bestOffer = xmlField(item, 'BestOfferDetails') || '';
  const best_offer_enabled = /true/i.test(xmlText(bestOffer, 'BestOfferEnabled') || '');
  const details = xmlField(item, 'ListingDetails') || '';
  const best_offer_auto_accept_cents = money(xmlField(details, 'BestOfferAutoAcceptPrice'));
  const best_offer_min_cents = money(xmlField(details, 'MinimumBestOfferPrice'));
  // MARKDOWN PROMOTIONS. Under one, StartPrice is the struck-through anchor rather than what the
  // buyer pays, and AU was-pricing rules care about that anchor.
  const discount = xmlField(item, 'DiscountPriceInfo') || '';
  const pricing_treatment = (xmlText(discount, 'PricingTreatment') || '').trim() || null;
  // VARIATIONS. CurrentPrice on a multi-variation listing is the LOWEST variation's, and a revise
  // needs a per-SKU target. Nothing here can express that, so it has to be refused.
  const has_variations = !!xmlField(item, 'Variations');

  return {
    ok: true,
    listing_id: (xmlField(item, 'ItemID') || '').trim() || String(itemId),
    title: xmlText(item, 'Title'),
    sku: (xmlText(item, 'SKU') || '').trim() || null,
    listing_type: (xmlText(item, 'ListingType') || '').trim() || null,
    listing_status: (xmlText(selling, 'ListingStatus') || '').trim() || null,
    price_cents: money(xmlField(selling, 'CurrentPrice')) ?? money(xmlField(item, 'StartPrice')),
    quantity_total: total,                       // eBay's total = available + sold
    sold_qty: sold,
    available_qty: total == null ? null : total - sold,
    postage_cents, shipping_type,
    best_offer_enabled, best_offer_auto_accept_cents, best_offer_min_cents,
    pricing_treatment, has_variations,
  };
}
// ReviseFixedPriceItem is a DELTA call — eBay leaves out what you leave out — which is what makes it
// safe to use for the one thing ReviseInventoryStatus cannot touch: the Best Offer thresholds.
//
// Both thresholds are written under ListingDetails, which is where GetItem reports them. That is the
// documented home for them, but it is also the part of this call the app cannot prove from here, and
// eBay's failure mode for a field it does not want is to ACCEPT the request and ignore the field. A
// silently-ignored threshold is precisely the harm the caller is trying to avoid, so reviseTradingListing
// verifies both numbers on the read-back and reverts the price if the floor did not move with it.
export function buildReviseFixedPriceItemInner({ itemId, priceCents, autoAcceptCents, minOfferCents }) {
  const details = [
    autoAcceptCents == null ? '' : `<BestOfferAutoAcceptPrice>${centsToXmlPrice(autoAcceptCents)}</BestOfferAutoAcceptPrice>`,
    minOfferCents == null ? '' : `<MinimumBestOfferPrice>${centsToXmlPrice(minOfferCents)}</MinimumBestOfferPrice>`,
  ].join('');
  return '<Item>'
    + `<ItemID>${xmlEscape(String(itemId))}</ItemID>`
    + (priceCents == null ? '' : `<StartPrice>${centsToXmlPrice(priceCents)}</StartPrice>`)
    + (details ? `<ListingDetails>${details}</ListingDetails>` : '')
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
  const u = xmlField(res.xml, 'User') || res.xml || '';
  const si = xmlField(u, 'SellerInfo') || '';
  return {
    ...res,
    userId: xmlField(u, 'UserID'),
    email: xmlField(u, 'Email'),
    feedbackScore: xmlField(u, 'FeedbackScore'),
    registrationDate: xmlField(u, 'RegistrationDate'),
    site: xmlField(u, 'Site'),
    // "Is this token's account an eBay Store, and which one" — already in the ReturnSummary payload,
    // we just never read it. Scoped to the <User> block so a nested same-named node can't shadow it.
    // Deliberately NOT ReturnAll: that pulls RegistrationAddress (street + phone) into logs.
    storeOwner: xmlField(si, 'StoreOwner') === 'true',
    storeUrl: xmlText(si, 'StoreURL'),
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

// `orderStatus` defaults to NULL, and omitting the element is eBay's documented default of "All".
//
// It used to default to 'Completed', and that one word was a blind spot: a SPECIFIC OrderStatus filter
// returns ONLY orders in that state, so the moment an order was cancelled it stopped coming back in the
// ModTime window — refreshOrder never saw it again, its stored status stayed 'Completed' forever, and it
// sat in the pack queue with nothing able to remove it. We were filtering out the very transition we
// most needed to hear about. Callers that genuinely want one state can still ask for it.
export function buildGetOrdersInner({ modTimeFrom, modTimeTo, createTimeFrom, createTimeTo,
  page = 1, entriesPerPage = 100, orderStatus = null, orderIds = null } = {}) {
  const parts = ['<OrderRole>Seller</OrderRole>'];
  if (orderIds && orderIds.length) {
    // Populating OrderIDArray makes eBay IGNORE every other filter — the status AND the time window.
    // That is precisely the point of asking this way: a re-read by id cannot be filtered out by the
    // same thing it exists to catch. Sending the other filters anyway would only imply they matter.
    parts.push('<OrderIDArray>'
      + orderIds.map((id) => `<OrderID>${xmlEscape(String(id))}</OrderID>`).join('')
      + '</OrderIDArray>');
  } else {
    if (orderStatus) parts.push(`<OrderStatus>${xmlEscape(orderStatus)}</OrderStatus>`);
    if (modTimeFrom) parts.push(`<ModTimeFrom>${xmlEscape(modTimeFrom)}</ModTimeFrom>`);
    if (modTimeTo) parts.push(`<ModTimeTo>${xmlEscape(modTimeTo)}</ModTimeTo>`);
    if (createTimeFrom) parts.push(`<CreateTimeFrom>${xmlEscape(createTimeFrom)}</CreateTimeFrom>`);
    if (createTimeTo) parts.push(`<CreateTimeTo>${xmlEscape(createTimeTo)}</CreateTimeTo>`);
  }
  parts.push(`<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`);
  parts.push('<DetailLevel>ReturnAll</DetailLevel>');
  return parts.join('');
}

// First shipment tracking number in a set of XML blocks, with its carrier.
//
// This is the whole reason the postage loop closes without a new API or an OAuth scope. eBay AU writes
// ShipmentTrackingDetails onto the order ITSELF the moment a postage label is bought in Seller Hub (and
// flips the order to shipped), and GetOrders already runs at DetailLevel=ReturnAll — so the number is
// sitting in a response we were already making and throwing away. refreshOrder (lib/postsale.mjs) picks
// it up on the next poll of an order we have already ingested.
//
// It lands under the ORDER's ShippingDetails for a whole-order dispatch and under a Transaction's for a
// per-line one, and there is one block per package on a multi-package shipment. Take the first block
// that actually carries a number: an empty ShipmentTrackingDetails is common and means "not yet".
export function firstTracking(blocks) {
  for (const b of blocks) {
    for (const t of xmlFieldAll(b || '', 'ShipmentTrackingDetails')) {
      const n = trim(xmlField(t, 'ShipmentTrackingNumber'));
      if (n) return { number: n, carrier: trim(xmlText(t, 'ShippingCarrierUsed')) || null };
    }
  }
  return { number: null, carrier: null };
}

// Parse a GetOrders response into plain objects. Pure (testable against a captured XML fixture).
// Order-level scalars are read from the order block with its <TransactionArray> spliced out, so a
// same-named line-item field (ItemID/SKU/Title) never shadows an order-level one.
export function parseOrders(xml) {
  const hasMore = /<HasMoreOrders>true<\/HasMoreOrders>/i.test(xml || '');
  const orders = xmlFieldAll(xml || '', 'Order').map((ob) => {
    const txArr = xmlField(ob, 'TransactionArray') || '';
    const head = ob.replace(/<TransactionArray>[\s\S]*?<\/TransactionArray>/, '');
    // CancelDetail is a container that REPEATS field names which also exist at order level
    // (CancelReason, CancelReasonDetails), and xmlField returns the first match in document order — so
    // order-level scalars are read from a copy with the container spliced out. Exactly the defence the
    // TransactionArray splice above gives against a line item shadowing an order field.
    //
    // eBay can send more than one CancelDetail (one per cancellation attempt); the LAST is the most
    // advanced state, which is the one that describes where this order actually ended up.
    const cancelBlocks = xmlFieldAll(head, 'CancelDetail');
    const cancelBlk = cancelBlocks.length ? cancelBlocks[cancelBlocks.length - 1] : '';
    const headNoCancel = head.replace(/<CancelDetail>[\s\S]*?<\/CancelDetail>/g, '');
    const co = xmlField(head, 'CheckoutStatus') || '';
    const addr = xmlField(head, 'ShippingAddress') || '';
    const shipSel = xmlField(head, 'ShippingServiceSelected') || '';
    const shipDet = xmlField(head, 'ShippingDetails') || '';
    // Order → ShippingServiceSelected → ShippingPackageInfo. One block per package; the first carries
    // the dates for a single-parcel order, which is every order this store sends.
    const pkg = xmlField(shipSel, 'ShippingPackageInfo') || xmlField(head, 'ShippingPackageInfo') || '';
    const track = firstTracking([head, txArr]);   // order-level dispatch first, then any single line's
    const total = xmlAmount(head, 'Total');
    const subtotal = xmlAmount(head, 'Subtotal');
    const shipCost = xmlAmount(shipSel, 'ShippingServiceCost');
    const paidTime = xmlField(head, 'PaidTime');
    // Packing-slip extras: SalesRecordNumber (Seller Hub "Sales record #") is order-level; the buyer
    // note (BuyerCheckoutMessage) may sit at order level or on a line — take the first non-empty.
    const buyerNote = xmlText(head, 'BuyerCheckoutMessage')
      || xmlFieldAll(txArr, 'Transaction').map((tb) => xmlText(tb, 'BuyerCheckoutMessage')).find(Boolean)
      || null;
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
      salesRecordNumber: xmlField(head, 'SalesRecordNumber'),
      buyerUsername: xmlField(head, 'BuyerUserID'),
      orderStatus: xmlField(head, 'OrderStatus'),
      checkoutStatus: xmlField(co, 'Status'),
      paidStatus: xmlField(co, 'eBayPaymentStatus'),
      // --- cancellation ---
      // The container is the newer home and eBay has said it plans to deprecate the order-level twins,
      // but which of the two a given account actually receives is not worth betting on: read the
      // container first and fall back, so nothing depends on being right about that timing.
      cancelStatus: xmlField(headNoCancel, 'CancelStatus'),
      cancelReason: xmlField(cancelBlk, 'CancelReason') || xmlField(headNoCancel, 'CancelReason'),
      cancelReasonDetails: xmlText(cancelBlk, 'CancelReasonDetails') || xmlText(headNoCancel, 'CancelReasonDetails'),
      cancelInitiator: xmlField(cancelBlk, 'CancelInitiator'),
      cancelInitiatedAt: xmlField(cancelBlk, 'CancelInitiationDate'),
      cancelCompletedAt: xmlField(cancelBlk, 'CancelCompleteDate'),
      createdTime: xmlField(head, 'CreatedTime'),
      paidTime,
      shippedTime: xmlField(head, 'ShippedTime'),
      currency: total.currency || subtotal.currency || 'AUD',
      totalCents: total.cents,
      subtotalCents: subtotal.cents,
      shippingCents: shipCost.cents,
      shipService: xmlField(shipSel, 'ShippingService'),
      // --- postage: what the buyer chose, and what happened to the parcel afterwards ---
      // ExpeditedService is eBay's own "this is a fast service" flag and is the most trustworthy
      // express signal we get, ahead of any guess made from the service code.
      expedited: xmlBool(shipSel, 'ExpeditedService'),
      // false = the buyer never picked a service and eBay defaulted one, so ShippingServiceSelected
      // and ShippingServiceCost are eBay's values, not a paid-for choice (eBay docs are explicit that
      // an application must ignore them here). classifyPostage refuses to promote a tier on this.
      buyerSelectedShipping: xmlBool(shipDet, 'BuyerSelectedShipping'),
      // eBay's committed dispatch deadline = purchase time + the listing's handling time. Missing it
      // is what damages the late-dispatch metric, so it drives the queue order on the dashboard.
      handleByTime: xmlField(pkg, 'HandleByTime'),
      // Estimated* is eBay's guess pre-dispatch. Scheduled* only starts being returned ONCE the order
      // is marked shipped with tracking, and is the better number from then on — both are kept and the
      // consumer prefers scheduled (see deliveryWindow in lib/postage.mjs).
      etaMin: xmlField(pkg, 'EstimatedDeliveryTimeMin'),
      etaMax: xmlField(pkg, 'EstimatedDeliveryTimeMax'),
      scheduledMin: xmlField(pkg, 'ScheduledDeliveryTimeMin'),
      scheduledMax: xmlField(pkg, 'ScheduledDeliveryTimeMax'),
      deliveredTime: xmlField(pkg, 'ActualDeliveryTime'),
      trackingNumber: track.number,
      carrier: track.carrier,
      buyerNote,
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

// --- CompleteSale (mark an order dispatched — clears "Awaiting postage", shows the buyer dispatch) ---
// The whole order is keyed by OrderID; a single line by OrderLineItemID (or ItemID+TransactionID).
// Untracked letters (the majority for cards) OMIT the Shipment block — set shipped=true with no
// tracking. When tracking is supplied, both a valid eBay ShippingCarrierUsed code AND the number are
// required (alphanumeric tracking only). Works on eBay AU (SiteID 15) — marketplace-agnostic.
export function buildCompleteSaleInner({ orderId, orderLineItemId, itemId, transactionId, shipped = true, tracking, carrier } = {}) {
  const parts = [];
  if (orderId) parts.push(`<OrderID>${xmlEscape(String(orderId))}</OrderID>`);
  else if (orderLineItemId) parts.push(`<OrderLineItemID>${xmlEscape(String(orderLineItemId))}</OrderLineItemID>`);
  else if (itemId && transactionId) {
    parts.push(`<ItemID>${xmlEscape(String(itemId))}</ItemID>`);
    parts.push(`<TransactionID>${xmlEscape(String(transactionId))}</TransactionID>`);
  }
  parts.push(`<Shipped>${shipped ? 'true' : 'false'}</Shipped>`);
  if (tracking && carrier) {
    parts.push('<Shipment><ShipmentTrackingDetails>'
      + `<ShipmentTrackingNumber>${xmlEscape(String(tracking))}</ShipmentTrackingNumber>`
      + `<ShippingCarrierUsed>${xmlEscape(String(carrier))}</ShippingCarrierUsed>`
      + '</ShipmentTrackingDetails></Shipment>');
  }
  return parts.join('');
}
export async function completeSale(env, opts = {}) {
  return tradingCall(env, 'CompleteSale', buildCompleteSaleInner(opts));
}

// --- GetItem (fetch a listing's primary image for the fulfilment dashboard) ---
// OutputSelector trims the response to just the picture block. GalleryURL is the primary thumbnail;
// fall back to the first full PictureURL. Works for the seller's own items incl. recently-ended ones.
// Entity-decoded: an EPS URL carries a query string, so eBay escapes its & as &amp; — pasted into an
// <img src> undecoded that is a broken picture, not a wrong one, which is why it went unnoticed.
export function parseItemImage(xml) {
  const pd = xmlField(xml, 'PictureDetails') || xml || '';
  return xmlText(pd, 'GalleryURL') || xmlText(pd, 'PictureURL') || null;
}
// When an item is relisted, eBay writes the NEW item's id onto the OLD listing so a buyer landing on
// the dead one can follow it forward. That makes it an authoritative old→new pointer from eBay itself:
// one cheap GetItem instead of paging the whole account, and immune to the duplicate-Custom-Label
// problem an auto-relist creates by definition (the relist carries the same SKU as the listing it
// replaced). Only present when the OLD listing is read, and it reflects the LAST relist.
//
// Nested inside ListingDetails, so the container is read first and the scalar out of it — a bare
// xmlField over the whole document takes the first match wherever it happens to sit.
export function parseRelistedItemId(xml) {
  const ld = xmlField(xml || '', 'ListingDetails') || '';
  return trim(xmlField(ld, 'RelistedItemID')) || null;
}

// `selectors` defaults to PictureDetails — what resolveImages has always asked for and all it needs.
// It is a parameter because OutputSelector TRIMS the response: with PictureDetails alone, ListingDetails
// is not in the payload at all, so relistedItemId can only ever be null for the existing callers. That
// is correct for them, and it is why this stays backward compatible. The relist watch asks for the whole
// ListingDetails container rather than a dotted path, so nothing depends on eBay's path-selector rules.
export async function getItem(env, itemId, { selectors = ['PictureDetails'] } = {}) {
  const inner = `<ItemID>${xmlEscape(String(itemId))}</ItemID>`
    + (selectors || []).map((s) => `<OutputSelector>${xmlEscape(s)}</OutputSelector>`).join('');
  const res = await tradingCall(env, 'GetItem', inner);
  return { ...res, imageUrl: parseItemImage(res.xml), relistedItemId: parseRelistedItemId(res.xml) };
}

// --- GetStore (the seller's own storefront departments, for the listing picker) ---
// CategoryStructureOnly strips the theme/logo/header config and returns just the category tree.
// Omitting UserID means "the token's own store". No extra OAuth scope: Trading runs on the IAF token
// we already hold, unlike the REST Sell Stores API which needs a fresh sell.stores consent.
export function buildGetStoreInner({ levelLimit, rootCategoryId } = {}) {
  const parts = ['<CategoryStructureOnly>true</CategoryStructureOnly>'];
  if (rootCategoryId) parts.push(`<RootCategoryID>${xmlEscape(String(rootCategoryId))}</RootCategoryID>`);
  if (levelLimit) parts.push(`<LevelLimit>${xmlEscape(String(levelLimit))}</LevelLimit>`);
  return parts.join('');
}

// Flatten CustomCategories into a pre-order list of { id, name, path, depth, order, leaf }.
// `path` is the slash-joined full path that offer.storeCategoryNames wants ("/Pokemon/Lost Origin");
// `leaf` gates whether an item may actually be filed there — eBay only allows items in terminal
// categories, and filing against a parent silently dumps the listing into "Other".
//
// Deliberately NOT built from xmlField/xmlFieldAll: ChildCategory nests inside itself and eBay emits
// a parent's <Name> AFTER its children, so the non-greedy helpers hand back a DESCENDANT's Name for
// the parent. This is a single-pass stack walk, so a scalar always belongs to the innermost open node
// whatever order the elements arrive in.
export function parseStoreCategories(xml) {
  const scope = xmlField(xml || '', 'CustomCategories');
  if (scope == null) return [];
  const nodes = [], stack = [];
  const re = /<(CustomCategory|ChildCategory)(?:\s[^>]*?)?(\/?)>|<\/(?:CustomCategory|ChildCategory)>|<(CategoryID|Name|Order)(?:\s[^>]*)?>([\s\S]*?)<\/\3>/g;
  let m;
  while ((m = re.exec(scope))) {
    if (m[1]) {
      const parent = stack[stack.length - 1] || null;
      const node = { id: null, name: '', order: null, depth: stack.length + 1, childCount: 0, parent };
      if (parent) parent.childCount++;
      nodes.push(node);                       // pre-order == the storefront's own display order
      if (m[2] !== '/') stack.push(node);     // tolerate a self-closing empty node
    } else if (m[3]) {
      const top = stack[stack.length - 1];
      if (!top) continue;
      if (m[3] === 'CategoryID') top.id = m[4].trim();
      else if (m[3] === 'Name') top.name = decodeEntities(m[4]).trim();
      else if (m[3] === 'Order') { const n = parseInt(m[4], 10); top.order = Number.isFinite(n) ? n : null; }
    } else {
      stack.pop();
    }
  }
  // Paths resolve in a second pass: a parent's Name isn't known until its subtree has closed.
  return nodes.map((n) => {
    n.path = (n.parent && n.parent.path ? n.parent.path : '') + '/' + n.name;
    return { id: n.id, name: n.name, path: n.path, depth: n.depth, order: n.order, leaf: n.childCount === 0 };
  });
}

export async function getStoreCategories(env, opts = {}) {
  const res = await tradingCall(env, 'GetStore', buildGetStoreInner(opts));
  return { ...res, categories: parseStoreCategories(res.xml), storeName: xmlText(res.xml, 'Name') };
}

// --- GetMyeBaySelling: every custom label (SKU) the seller currently has on eBay ---
// Used to seed the AAA-001 stock-label counter (AGENTS.md §16b): those labels predate this tool and
// live only on the seller's listings, so the highest one has to be read back from eBay.
//
// Deliberately scans SOLD and UNSOLD as well as ACTIVE. Labels are never reused, so the highest one
// may well belong to a card that has already sold — seeding from active listings alone would re-issue
// a retired label. eBay's sold/unsold history only reaches back ~90 days, so a label older than that
// and no longer active is invisible; the caller surfaces that rather than pretending otherwise.
export function buildGetMyeBaySellingInner({ page = 1, perPage = 200, lists = ['ActiveList', 'SoldList', 'UnsoldList'] } = {}) {
  const pag = `<Pagination><EntriesPerPage>${Math.min(200, Math.max(1, perPage))}</EntriesPerPage><PageNumber>${Math.max(1, page)}</PageNumber></Pagination>`;
  return lists.map((l) => `<${l}><Include>true</Include>${pag}</${l}>`).join('');
}

// Returns { ok, skus, pages, calls, truncated }. SKUs are collected with xmlFieldAll rather than a
// structured walk on purpose: SoldList nests Item inside OrderTransaction while ActiveList does not,
// and all we need is the set of label strings, whatever depth they arrive at.
export async function getSellerSkus(env, { perPage = 200, maxPages = 25, lists } = {}) {
  const skus = new Set();
  let pages = 1, calls = 0, truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await tradingCall(env, 'GetMyeBaySelling', buildGetMyeBaySellingInner({ page, perPage, lists }));
    calls++;
    if (!res.ok) {
      const e = (res.errors && res.errors[0]) || {};
      return { ok: false, error: e.longMessage || e.shortMessage || ('HTTP ' + res.httpStatus), skus: [...skus], pages, calls, truncated };
    }
    for (const raw of xmlFieldAll(res.xml, 'SKU')) {
      const v = decodeEntities(raw).trim();
      if (v) skus.add(v);
    }
    const totals = xmlFieldAll(res.xml, 'TotalNumberOfPages').map((n) => parseInt(n, 10)).filter(Number.isFinite);
    pages = totals.length ? Math.max(...totals) : 1;
    if (page >= pages) break;
    if (page === maxPages && pages > maxPages) truncated = true;   // no silent caps — the caller reports it
  }
  return { ok: true, skus: [...skus], pages, calls, truncated };
}

// Parse GetMyeBaySelling into one row per listing, tagged with the list it came from. Unlike the
// store-category walker this can use xmlField per block: <Item> never nests inside <Item>, even in
// SoldList where it sits under OrderTransaction/Transaction.
const SELLER_LISTS = [['ActiveList', 'active'], ['SoldList', 'sold'], ['UnsoldList', 'unsold']];
export function parseSellerListings(xml) {
  const out = [];
  for (const [tag, state] of SELLER_LISTS) {
    const block = xmlField(xml || '', tag);
    if (!block) continue;
    for (const m of block.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
      const it = m[1];
      const listingId = (xmlField(it, 'ItemID') || '').trim();
      if (!listingId) continue;
      const selling = xmlField(it, 'SellingStatus') || '';
      // CurrentPrice reflects a revised price; StartPrice is what it opened at.
      const priceRaw = xmlField(selling, 'CurrentPrice') || xmlField(it, 'CurrentPrice') || xmlField(it, 'StartPrice');
      const price = priceRaw != null ? Number(String(priceRaw).replace(/[^0-9.]/g, '')) : null;
      const cur = /currencyID="([A-Z]{3})"/.exec(
        (selling.match(/<CurrentPrice[^>]*>/) || it.match(/<(?:CurrentPrice|StartPrice)[^>]*>/) || [''])[0]) ;
      // Item.Quantity is available PLUS SOLD, not available — "For GetItem and related calls, this is
      // the total of the number of items available for sale plus the quantity already sold"
      // (ItemType). GetMyeBaySelling is a related call. Reading it as available and echoing it back to
      // ReviseInventoryStatus (which wants AVAILABLE) would oversell by exactly the sold count, on
      // every listing that has ever sold. Prefer eBay's own QuantityAvailable; derive it otherwise.
      const qty = parseInt(xmlField(it, 'Quantity') || '', 10);
      const sold = parseInt(xmlField(selling, 'QuantitySold') || '', 10);
      const availRaw = parseInt(xmlField(it, 'QuantityAvailable') || '', 10);
      const available = Number.isFinite(availRaw) ? availRaw
        : Number.isFinite(qty) ? qty - (Number.isFinite(sold) ? sold : 0) : null;
      out.push({
        listing_id: listingId,
        sku: (xmlText(it, 'SKU') || '').trim() || null,
        title: xmlText(it, 'Title') || null,
        price_cents: Number.isFinite(price) ? Math.round(price * 100) : null,
        currency: cur ? cur[1] : 'AUD',
        quantity: Number.isFinite(qty) ? qty : null,          // eBay's TOTAL (available + sold)
        available_qty: available,                              // what a revise call wants back
        sold_qty: Number.isFinite(sold) ? sold : 0,
        // Fixed-price only can be revised by ReviseInventoryStatus; an auction comes back as 'Chinese'.
        listing_type: (xmlText(it, 'ListingType') || '').trim() || null,
        state,
        listing_url: xmlText(it, 'ViewItemURL') || null,
        // The listing's first picture. GetMyeBaySelling returns PictureDetails on most items but not
        // reliably on all of them, so this is the free half — null here means "this scan didn't say",
        // never "this listing has none", and the caller backfills those with GetItem.
        image_url: parseItemImage(it),
      });
    }
  }
  // A listing can appear in more than one list (a multi-quantity listing is active AND has sales).
  // Active wins, because what matters downstream is "is this still buyable".
  const byId = new Map();
  for (const r of out) {
    const prev = byId.get(r.listing_id);
    if (!prev || (r.state === 'active' && prev.state !== 'active')) byId.set(r.listing_id, r);
    else if (prev && r.sold_qty > prev.sold_qty) prev.sold_qty = r.sold_qty;
  }
  return [...byId.values()];
}

// Every listing on the account, paged. Same shape as getSellerSkus, which it supersedes for callers
// that need more than the label.
export async function getSellerListings(env, { perPage = 200, maxPages = 25, lists } = {}) {
  const rows = new Map();
  let pages = 1, calls = 0, truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await tradingCall(env, 'GetMyeBaySelling', buildGetMyeBaySellingInner({ page, perPage, lists }));
    calls++;
    if (!res.ok) {
      const e = (res.errors && res.errors[0]) || {};
      return { ok: false, error: e.longMessage || e.shortMessage || ('HTTP ' + res.httpStatus), listings: [...rows.values()], pages, calls, truncated };
    }
    for (const r of parseSellerListings(res.xml)) {
      const prev = rows.get(r.listing_id);
      if (!prev || (r.state === 'active' && prev.state !== 'active')) rows.set(r.listing_id, r);
    }
    const totals = xmlFieldAll(res.xml, 'TotalNumberOfPages').map((n) => parseInt(n, 10)).filter(Number.isFinite);
    pages = totals.length ? Math.max(...totals) : 1;
    if (page >= pages) break;
    if (page === maxPages && pages > maxPages) truncated = true;
  }
  return { ok: true, listings: [...rows.values()], pages, calls, truncated };
}

// --- item specifics on a hand-made listing (Trading ReviseItem) ---
//
// ItemSpecifics is a COMPLETE REPLACE: "all newly input Item Specifics will replace all existing
// Item Specific values, regardless of if the values changed" (ReviseFixedPriceItem reference). There
// is no documented way to delete one pair. So the only safe shape is read → merge → send the union,
// and a failed read must NEVER be treated as "nothing to preserve" or the seller's own specifics are
// wiped. ReviseItem rather than ReviseFixedPriceItem because only ReviseItem carries VerifyOnly, a
// true dry run that validates without persisting.

// GetItem WITH specifics. Returns { ok, specifics:[{name,value,source}], hadNode } — hadNode false
// means eBay returned no ItemSpecifics node at all, which means the listing genuinely has none.
export async function getItemSpecifics(env, itemId) {
  const inner = `<ItemID>${xmlEscape(String(itemId))}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics>`;
  const res = await tradingCall(env, 'GetItem', inner);
  if (!res.ok) {
    const e = (res.errors && res.errors[0]) || {};
    return { ok: false, error: e.longMessage || e.shortMessage || ('HTTP ' + res.httpStatus) };
  }
  const block = xmlField(res.xml, 'ItemSpecifics');
  const specifics = [];
  if (block != null) {
    for (const m of block.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) {
      const name = decodeEntities(xmlField(m[1], 'Name') || '').trim();
      const values = xmlFieldAll(m[1], 'Value').map((v) => decodeEntities(v).trim()).filter(Boolean);
      // Source is GetItem-output-only per the WSDL and must be stripped before writing back.
      // Source=Product pairs come from an eBay catalog product and should not be altered.
      const source = (xmlField(m[1], 'Source') || '').trim() || null;
      if (name && values.length) specifics.push({ name, values, source });
    }
  }
  return { ok: true, hadNode: block != null, specifics };
}

// Merge OURS over THEIRS by aspect name. Theirs is kept wherever we have nothing to say, which is the
// whole point: a push that only sent our names would delete the rest. Catalog-sourced pairs
// (Source=Product) are preserved verbatim and never overridden.
export function mergeItemSpecifics(theirs, ours, { max = 45 } = {}) {
  const out = [], seen = new Set();
  const push = (name, values, note) => {
    const k = String(name).trim().toLowerCase();
    if (!k || seen.has(k)) return;
    const vs = (Array.isArray(values) ? values : [values]).map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
    if (!vs.length) return;
    seen.add(k); out.push({ name: String(name).trim(), values: vs, ...(note ? { note } : {}) });
  };
  for (const t of theirs || []) if (t.source === 'Product') push(t.name, t.values, 'catalog');   // untouchable first
  for (const [name, v] of Object.entries(ours || {})) push(name, v, 'ours');
  for (const t of theirs || []) push(t.name, t.values, 'theirs');                                // whatever we did not cover
  const kept = out.slice(0, max);
  return { specifics: kept, dropped: out.length - kept.length };
}

export function buildReviseItemInner({ itemId, specifics, verifyOnly = false }) {
  const pairs = (specifics || []).map((s) =>
    '<NameValueList>' + `<Name>${xmlEscape(s.name)}</Name>`
    + s.values.map((v) => `<Value>${xmlEscape(v)}</Value>`).join('') + '</NameValueList>').join('');
  // WSDL sequence inside Item puts ItemID before ItemSpecifics; VerifyOnly is a sibling of Item.
  return '<Item>' + `<ItemID>${xmlEscape(String(itemId))}</ItemID>`
    + (pairs ? '<ItemSpecifics>' + pairs + '</ItemSpecifics>' : '') + '</Item>'
    + (verifyOnly ? '<VerifyOnly>true</VerifyOnly>' : '');
}

export async function reviseItemSpecifics(env, { itemId, specifics, verifyOnly = false }) {
  const res = await tradingCall(env, 'ReviseItem', buildReviseItemInner({ itemId, specifics, verifyOnly }));
  const errs = res.errors || [];
  // 5028 = a value that no longer validates against the category's current aspect metadata. Because
  // ItemSpecifics is all-or-nothing, ONE stale legacy value fails the whole call — name it clearly.
  const stale = errs.find((e) => String(e.code) === '5028');
  return {
    ok: res.ok, ack: res.ack, errors: errs,
    error: res.ok ? null : (stale
      ? 'eBay rejected one of the existing item specifics as no longer valid for this category: ' + (stale.longMessage || stale.shortMessage)
      : ((errs[0] && (errs[0].longMessage || errs[0].shortMessage)) || 'HTTP ' + res.httpStatus)),
    staleValue: !!stale,
  };
}
