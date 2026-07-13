// test/unit/ebay-trading.test.mjs — pure XML parsers + request builders (lib/ebay-trading.mjs).
// No network: only the pure functions are exercised (tradingCall's fetch is not called).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  xmlField, xmlFieldAll, xmlErrors,
  xmlEscape, centsToXmlPrice, compatLevel, siteId,
  buildTradingBody, buildTradingHeaders,
  buildReviseInventoryStatusInner, buildReviseFixedPriceItemInner,
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
