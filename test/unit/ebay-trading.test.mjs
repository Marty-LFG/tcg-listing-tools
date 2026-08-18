// test/unit/ebay-trading.test.mjs — pure XML parsers + request builders (lib/ebay-trading.mjs).
// No network: only the pure functions are exercised (tradingCall's fetch is not called).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  xmlField, xmlFieldAll, xmlErrors,
  xmlEscape, centsToXmlPrice, xmlMoneyCents, compatLevel, siteId,
  buildTradingBody, buildTradingHeaders,
  buildReviseInventoryStatusInner, buildReviseFixedPriceItemInner,
  buildSendInvoiceInner,
} from '../../lib/ebay-trading.mjs';

describe('XML parsers', () => {
  it('xmlField pulls the first tag, tolerates attributes, does NOT decode entities', () => {
    assert.equal(xmlField('<Ack>Success</Ack>', 'Ack'), 'Success');
    assert.equal(xmlField('<Timestamp foo="1">T</Timestamp>', 'Timestamp'), 'T');
    assert.equal(xmlField('<A>1</A><A>2</A>', 'A'), '1');                 // first match only
    assert.equal(xmlField('<S>A &amp; B</S>', 'S'), 'A &amp; B');         // raw inner text
    assert.equal(xmlField('', 'Ack'), null);
    assert.equal(xmlField(null, 'Ack'), null);
  });
  it('xmlFieldAll returns every occurrence in order', () => {
    assert.deepEqual(xmlFieldAll('<ItemID>1</ItemID><ItemID>2</ItemID>', 'ItemID'), ['1', '2']);
    assert.deepEqual(xmlFieldAll('', 'ItemID'), []);
  });
  it('xmlErrors parses multiple Errors blocks', () => {
    const xml = '<Errors><ErrorCode>21</ErrorCode><SeverityCode>Error</SeverityCode>'
      + '<ShortMessage>Bad</ShortMessage><LongMessage>Bad thing</LongMessage></Errors>'
      + '<Errors><ErrorCode>37</ErrorCode><SeverityCode>Warning</SeverityCode><ShortMessage>Meh</ShortMessage></Errors>';
    const errs = xmlErrors(xml);
    assert.equal(errs.length, 2);
    assert.deepEqual(errs[0], { code: '21', severity: 'Error', shortMessage: 'Bad', longMessage: 'Bad thing' });
    assert.equal(errs[1].code, '37');
    assert.deepEqual(xmlErrors(''), []);
  });
});

describe('value formatting', () => {
  it('xmlEscape escapes the five XML entities', () => {
    assert.equal(xmlEscape(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
    assert.equal(xmlEscape(null), '');
  });
  it('centsToXmlPrice renders integer cents as a dotted decimal (GR3)', () => {
    assert.equal(centsToXmlPrice(1849), '18.49');
    assert.equal(centsToXmlPrice(500), '5.00');
    assert.equal(centsToXmlPrice(0), '0.00');
    assert.equal(centsToXmlPrice(199999), '1999.99');
  });
});

describe('request builders', () => {
  it('buildTradingBody wraps innerXml in the call envelope', () => {
    const b = buildTradingBody('GetUser', '<DetailLevel>ReturnSummary</DetailLevel>');
    assert.ok(b.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">'));
    assert.ok(b.endsWith('<DetailLevel>ReturnSummary</DetailLevel></GetUserRequest>'));
    assert.ok(!/RequesterCredentials/.test(b), 'no RequesterCredentials — IAF token authenticates');
  });
  it('buildTradingHeaders sets AU site 15, compat level, and the IAF token (not Authorization)', () => {
    const h = buildTradingHeaders({ EBAY_MARKETPLACE: 'EBAY_AU' }, 'ReviseInventoryStatus', 'TOK123');
    assert.equal(h['X-EBAY-API-SITEID'], '15');
    assert.equal(h['X-EBAY-API-CALL-NAME'], 'ReviseInventoryStatus');
    assert.equal(h['X-EBAY-API-COMPATIBILITY-LEVEL'], '1409');
    assert.equal(h['X-EBAY-API-IAF-TOKEN'], 'TOK123');
    assert.equal(h['Content-Type'], 'text/xml');
    assert.equal(h.Authorization, undefined);
    assert.equal(h['X-EBAY-API-DEV-NAME'], undefined, 'no app-identity headers without EBAY_DEV_ID');
  });
  it('buildTradingHeaders adds app-identity headers only when EBAY_DEV_ID is set', () => {
    const h = buildTradingHeaders({ EBAY_DEV_ID: 'dev', EBAY_APP_ID: 'app', EBAY_CERT_ID: 'cert' }, 'GetUser', 'T');
    assert.equal(h['X-EBAY-API-DEV-NAME'], 'dev');
    assert.equal(h['X-EBAY-API-APP-NAME'], 'app');
    assert.equal(h['X-EBAY-API-CERT-NAME'], 'cert');
  });
  it('siteId / compatLevel honor overrides', () => {
    assert.equal(siteId({}), '15');                          // default AU
    assert.equal(siteId({ EBAY_MARKETPLACE: 'EBAY_US' }), '0');
    assert.equal(siteId({ EBAY_SITEID: '3' }), '3');         // explicit wins
    assert.equal(compatLevel({}), '1409');
    assert.equal(compatLevel({ EBAY_COMPAT_LEVEL: '1234' }), '1234');
  });
});

describe('Phase-4 price-write inner builders (pure)', () => {
  it('ReviseInventoryStatus: ItemID + StartPrice from cents', () => {
    assert.equal(buildReviseInventoryStatusInner({ itemId: '123456789012', priceCents: 1849 }),
      '<InventoryStatus><ItemID>123456789012</ItemID><StartPrice>18.49</StartPrice></InventoryStatus>');
  });
  it('ReviseFixedPriceItem: ItemID + StartPrice from cents', () => {
    assert.equal(buildReviseFixedPriceItemInner({ itemId: '999', priceCents: 500 }),
      '<Item><ItemID>999</ItemID><StartPrice>5.00</StartPrice></Item>');
  });
  it('itemId is XML-escaped (defense against a hostile/odd ItemID)', () => {
    assert.match(buildReviseInventoryStatusInner({ itemId: 'a&b', priceCents: 100 }), /<ItemID>a&amp;b<\/ItemID>/);
  });
});

// The distinction this function exists for is absent-vs-zero, and it is a money one. The parse used
// to be `Number(String(s ?? '').replace(/[^0-9.]/g,''))`, and Number('') is 0 — so a GetItem that
// carried no ShippingServiceCost reported FREE POSTAGE. Free postage is exactly what lets the
// repricer treat a delivered comp as a list price, so an absent element was silently licensing the
// one comparison the repricer must never make.
describe('xmlMoneyCents — an absent money element is unknown, not zero', () => {
  it('reads a real amount, ignoring the currencyID attribute value', () => {
    assert.equal(xmlMoneyCents('8.00'), 800);
    assert.equal(xmlMoneyCents(xmlField('<P currencyID="AUD">12.34</P>', 'P')), 1234);
    assert.equal(xmlMoneyCents('0.00'), 0, 'an explicit zero IS zero');
  });
  it('returns null for anything with no digits in it', () => {
    for (const v of [null, undefined, '', '   ', '.', 'AUD']) {
      assert.equal(xmlMoneyCents(v), null, JSON.stringify(v) + ' must be unknown, not 0');
    }
  });
  it('returns null when the element is missing entirely', () => {
    // xmlField returns null for a tag that is not there; that null must survive the money parse.
    assert.equal(xmlMoneyCents(xmlField('<ShippingDetails></ShippingDetails>', 'ShippingServiceCost')), null);
  });
  it('rounds to whole cents (GR3)', () => {
    assert.equal(xmlMoneyCents('2.985'), 299);
    assert.equal(xmlMoneyCents('19.99'), 1999);
  });
});

// --- SendInvoice: the only call in the repo that changes what a buyer is asked to pay -------------
describe('centsToXmlPrice — negatives, which SendInvoice depends on entirely', () => {
  it('renders a negative as a negative', () => {
    // A discount reaches eBay as a NEGATIVE AdjustmentAmount. If this ever rendered unsigned, every
    // deal would bill the buyer extra for asking for one.
    assert.equal(centsToXmlPrice(-500), '-5.00');
    assert.equal(centsToXmlPrice(-1), '-0.01');
    assert.equal(centsToXmlPrice(-50), '-0.50');
    assert.equal(centsToXmlPrice(-1520), '-15.20');
    assert.equal(centsToXmlPrice('-500'), '-5.00');
  });

  it('PINS the two poison inputs, so the guard against them cannot be softened', () => {
    // null renders as a silent A$0.00 — an invoice with no discount on it, which looks like success.
    assert.equal(centsToXmlPrice(null), '0.00');
    // undefined renders as the literal string "NaN", which is invalid XML.
    assert.equal(centsToXmlPrice(undefined), 'NaN');
    // Neither may reach the wire, so buildSendInvoiceInner refuses both rather than testing truthiness
    // (a `!x` test would also reject a legitimate 0).
  });
});

describe('buildSendInvoiceInner', () => {
  const base = { orderId: '12-34-56', currency: 'AUD', shippingService: 'AU_Regular', shippingCostCents: 826, messageId: 'deal-1' };

  it('THE ONE THAT MATTERS: a discount is emitted NEGATIVE', () => {
    const xml = buildSendInvoiceInner({ ...base, discountCents: 1500 });
    assert.ok(xml.includes('<AdjustmentAmount currencyID="AUD">-15.00</AdjustmentAmount>'));
    assert.ok(!xml.includes('>15.00<'), 'an unsigned figure here is a surcharge, not a discount');
  });

  it('emits the WSDL sequence, not the doc page order', () => {
    // The reference page lists fields alphabetically, which puts AdjustmentAmount FIRST. The schema
    // puts it LAST. XML in doc order is rejected.
    const xml = buildSendInvoiceInner({ ...base, discountCents: 1500, checkoutInstructions: 'note' });
    const at = (t) => xml.indexOf(t);
    assert.ok(at('<MessageID>') < at('<WarningLevel>'));
    assert.ok(at('<WarningLevel>') < at('<OrderID>'));
    assert.ok(at('<OrderID>') < at('<ShippingServiceOptions>'));
    assert.ok(at('<ShippingServiceOptions>') < at('<CheckoutInstructions>'));
    assert.ok(at('<CheckoutInstructions>') < at('<EmailCopyToSeller>'));
    assert.ok(at('<EmailCopyToSeller>') < at('<AdjustmentAmount'));
    assert.ok(at('<ShippingService>') < at('<ShippingServiceCost'));
  });

  it('never wraps the postage in <ShippingDetails>', () => {
    // That wrapper is correct on AddOrder and on a listing, and wrong here — it becomes an unrecognised
    // element, which under the default WarningLevel is accepted with Ack=Success and changes nothing.
    const xml = buildSendInvoiceInner({ ...base, discountCents: 100 });
    assert.ok(!xml.includes('<ShippingDetails>'));
    assert.ok(xml.includes('<ShippingServiceOptions>'));
    assert.ok(xml.includes('<WarningLevel>High</WarningLevel>'), 'High is what makes a wrong element an error');
  });

  it('emits ONE identity and offers no way to send a second', () => {
    // OrderID silently causes OrderLineItemID / ItemID / TransactionID / SKU to be IGNORED, with
    // Ack=Success — so a stale second identifier invoices a scope nobody chose, with no error.
    const xml = buildSendInvoiceInner({ ...base, discountCents: 100, orderLineItemId: 'X-1', itemId: '999', transactionId: '888', sku: 'BK-1' });
    assert.ok(xml.includes('<OrderID>12-34-56</OrderID>'));
    for (const tag of ['<OrderLineItemID>', '<ItemID>', '<TransactionID>', '<SKU>']) {
      assert.ok(!xml.includes(tag), `${tag} must never appear`);
    }
  });

  it('never emits the blocks that do not belong to this call', () => {
    const xml = buildSendInvoiceInner({ ...base, discountCents: 100 });
    for (const tag of ['<SalesTax>', '<PaymentMethods>', '<InternationalShippingServiceOptions>',
      '<ShippingServiceAdditionalCost>', '<PayPalEmailAddress>', '<InsuranceDetails>']) {
      assert.ok(!xml.includes(tag), `${tag} must never appear`);
    }
  });

  it('takes currencyID from the argument rather than hardcoding AUD', () => {
    const xml = buildSendInvoiceInner({ ...base, currency: 'USD', discountCents: 100 });
    assert.ok(xml.includes('<AdjustmentAmount currencyID="USD">'));
    assert.ok(xml.includes('<ShippingServiceCost currencyID="USD">'));
  });

  it('omits optional blocks whole rather than emitting them empty', () => {
    const bare = buildSendInvoiceInner({ orderId: 'A-1' });
    assert.ok(!bare.includes('<ShippingServiceOptions>'));
    assert.ok(!bare.includes('<CheckoutInstructions>'));
    assert.ok(!bare.includes('<AdjustmentAmount'));
    assert.ok(!bare.includes('<MessageID>'));
    assert.ok(bare.includes('<OrderID>A-1</OrderID>'));
  });

  it('refuses the values that would send a silent zero or invalid XML', () => {
    assert.throws(() => buildSendInvoiceInner({ ...base, discountCents: 0 }), /positive magnitude/);
    assert.throws(() => buildSendInvoiceInner({ ...base, discountCents: -100 }), /positive magnitude/);
    assert.throws(() => buildSendInvoiceInner({ ...base, discountCents: 1.5 }), /whole cents/);
    assert.throws(() => buildSendInvoiceInner({ ...base, shippingCostCents: NaN, discountCents: 100 }), /number of cents/);
    assert.throws(() => buildSendInvoiceInner({ orderId: null }), /orderId is required/);
  });

  it('refuses checkout instructions past eBay\'s 500-character cap', () => {
    assert.throws(() => buildSendInvoiceInner({ ...base, discountCents: 100, checkoutInstructions: 'x'.repeat(501) }), /limit is 500/);
    assert.ok(buildSendInvoiceInner({ ...base, discountCents: 100, checkoutInstructions: 'x'.repeat(500) }).includes('<CheckoutInstructions>'));
  });

  it('escapes everything it interpolates', () => {
    const xml = buildSendInvoiceInner({ ...base, discountCents: 100, checkoutInstructions: 'a & b <c> "d"' });
    assert.ok(xml.includes('a &amp; b &lt;c&gt; &quot;d&quot;'));
    assert.ok(!xml.includes('<c>'));
  });
});
