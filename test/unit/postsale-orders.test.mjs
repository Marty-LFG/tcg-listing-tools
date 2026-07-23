// test/unit/postsale-orders.test.mjs — pure parsers/builders for eBay GetOrders (post-sale ingest).
// Offline: exercises lib/ebay-trading.mjs against a captured GetOrders XML fixture. The live call is
// covered by the manual smoke + the DIAG-gated /api/postsale/poll/orders trigger.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrders, buildGetOrdersInner, xmlAmount, decodeEntities,
  buildAddMemberMessageAAQToPartnerInner, parseMemberMessages, buildGetMemberMessagesInner,
  buildCompleteSaleInner } from '../../lib/ebay-trading.mjs';
import { matchLineItem, buildPickSheet, PICK_UNSORTED, skuGroupLabel } from '../../lib/postsale.mjs';

// Two orders: #1 PAID (multi-line, one card title with an &), #2 UNPAID (no PaidTime).
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages><TotalNumberOfEntries>2</TotalNumberOfEntries></PaginationResult>
  <HasMoreOrders>false</HasMoreOrders>
  <OrderArray>
    <Order>
      <OrderID>14-14908-12300</OrderID>
      <SalesRecordNumber>873</SalesRecordNumber>
      <OrderStatus>Completed</OrderStatus>
      <CheckoutStatus>
        <Status>Complete</Status>
        <eBayPaymentStatus>NoPaymentFailure</eBayPaymentStatus>
        <PaymentMethod>CreditCard</PaymentMethod>
      </CheckoutStatus>
      <ShippingAddress>
        <Name>Amy Catwiz</Name>
        <Street1>12 Example St</Street1>
        <Street2>Unit 3</Street2>
        <CityName>Sydney</CityName>
        <StateOrProvince>NSW</StateOrProvince>
        <PostalCode>2000</PostalCode>
        <Country>AU</Country>
        <CountryName>Australia</CountryName>
        <Phone>+61 400 000 000</Phone>
      </ShippingAddress>
      <ShippingServiceSelected>
        <ShippingService>AU_Regular</ShippingService>
        <ShippingServiceCost currencyID="AUD">3.50</ShippingServiceCost>
      </ShippingServiceSelected>
      <Subtotal currencyID="AUD">42.00</Subtotal>
      <Total currencyID="AUD">45.50</Total>
      <TransactionArray>
        <Transaction>
          <TransactionID>1122334455</TransactionID>
          <Item><ItemID>296123456789</ItemID><SKU>BK-PKM-000042</SKU><Title>Pokemon Flygon ex 222/191 SV</Title></Item>
          <QuantityPurchased>1</QuantityPurchased>
          <TransactionPrice currencyID="AUD">30.00</TransactionPrice>
          <BuyerCheckoutMessage>Please pack with extra care &amp; a top loader, thanks!</BuyerCheckoutMessage>
          <OrderLineItemID>296123456789-1122334455</OrderLineItemID>
        </Transaction>
        <Transaction>
          <TransactionID>1122334466</TransactionID>
          <Item><ItemID>296987654321</ItemID><SKU>BK-PKM-000043</SKU><Title>Scarlet &amp; Violet Gardevoir ex 245/091</Title></Item>
          <QuantityPurchased>2</QuantityPurchased>
          <TransactionPrice currencyID="AUD">6.00</TransactionPrice>
          <OrderLineItemID>296987654321-1122334466</OrderLineItemID>
        </Transaction>
      </TransactionArray>
      <BuyerUserID>amycatwiz</BuyerUserID>
      <PaidTime>2026-07-19T01:53:00.000Z</PaidTime>
      <CreatedTime>2026-07-19T01:50:00.000Z</CreatedTime>
    </Order>
    <Order>
      <OrderID>14-14908-99999</OrderID>
      <OrderStatus>Active</OrderStatus>
      <CheckoutStatus>
        <Status>Incomplete</Status>
        <eBayPaymentStatus>NoPaymentFailure</eBayPaymentStatus>
      </CheckoutStatus>
      <ShippingAddress>
        <Name>Bob Buyer</Name>
        <Street1>9 Other Rd</Street1>
        <CityName>Perth</CityName>
        <StateOrProvince>WA</StateOrProvince>
        <PostalCode>6000</PostalCode>
        <Country>AU</Country>
        <CountryName>Australia</CountryName>
      </ShippingAddress>
      <Subtotal currencyID="AUD">10.00</Subtotal>
      <Total currencyID="AUD">12.00</Total>
      <TransactionArray>
        <Transaction>
          <TransactionID>2233445566</TransactionID>
          <Item><ItemID>296111222333</ItemID><SKU>BK-SLD-PKM-000009</SKU><Title>Pokemon Booster Box</Title></Item>
          <QuantityPurchased>1</QuantityPurchased>
          <TransactionPrice currencyID="AUD">10.00</TransactionPrice>
          <OrderLineItemID>296111222333-2233445566</OrderLineItemID>
        </Transaction>
      </TransactionArray>
      <BuyerUserID>bobbuyer</BuyerUserID>
      <CreatedTime>2026-07-19T02:10:00.000Z</CreatedTime>
    </Order>
  </OrderArray>
</GetOrdersResponse>`;

describe('parseOrders', () => {
  const { orders, hasMore } = parseOrders(FIXTURE);

  it('returns both orders and the HasMoreOrders flag', () => {
    assert.equal(orders.length, 2);
    assert.equal(hasMore, false);
  });

  it('extracts order-level fields + money as integer cents (GR3)', () => {
    const o = orders[0];
    assert.equal(o.orderId, '14-14908-12300');
    assert.equal(o.buyerUsername, 'amycatwiz');
    assert.equal(o.orderStatus, 'Completed');
    assert.equal(o.checkoutStatus, 'Complete');
    assert.equal(o.paidStatus, 'NoPaymentFailure');
    assert.equal(o.currency, 'AUD');
    assert.equal(o.totalCents, 4550);
    assert.equal(o.subtotalCents, 4200);
    assert.equal(o.shippingCents, 350);
    assert.equal(o.shipService, 'AU_Regular');
    assert.equal(o.paidTime, '2026-07-19T01:53:00.000Z');
    assert.equal(o.paid, true);
  });

  it('extracts the packing-slip extras: SalesRecordNumber + buyer checkout note (entity-decoded)', () => {
    const o = orders[0];
    assert.equal(o.salesRecordNumber, '873');
    assert.equal(o.buyerNote, 'Please pack with extra care & a top loader, thanks!');
    // order #2 has neither → both null
    assert.equal(orders[1].salesRecordNumber, null);
    assert.equal(orders[1].buyerNote, null);
  });

  it('extracts the shipping address the seller receives (email stays masked)', () => {
    const s = orders[0].ship;
    assert.equal(s.name, 'Amy Catwiz');
    assert.equal(s.street1, '12 Example St');
    assert.equal(s.street2, 'Unit 3');
    assert.equal(s.city, 'Sydney');
    assert.equal(s.state, 'NSW');
    assert.equal(s.postal, '2000');
    assert.equal(s.country, 'AU');
    assert.equal(s.countryName, 'Australia');
    assert.equal(s.phone, '+61 400 000 000');
  });

  it('parses multi-line items with SKU (the reconciliation key) and decodes entities in titles', () => {
    const items = orders[0].items;
    assert.equal(items.length, 2);
    assert.equal(items[0].itemId, '296123456789');
    assert.equal(items[0].sku, 'BK-PKM-000042');
    assert.equal(items[0].title, 'Pokemon Flygon ex 222/191 SV');
    assert.equal(items[0].quantity, 1);
    assert.equal(items[0].unitPriceCents, 3000);
    assert.equal(items[0].transactionId, '1122334455');
    assert.equal(items[0].orderLineItemId, '296123456789-1122334455');
    assert.equal(items[1].sku, 'BK-PKM-000043');
    assert.equal(items[1].title, 'Scarlet & Violet Gardevoir ex 245/091'); // &amp; decoded
    assert.equal(items[1].quantity, 2);
    assert.equal(items[1].unitPriceCents, 600);
  });

  it('treats a missing PaidTime as unpaid (the reliable paid gate)', () => {
    const o = orders[1];
    assert.equal(o.orderId, '14-14908-99999');
    assert.equal(o.buyerUsername, 'bobbuyer');
    assert.equal(o.paid, false);
    assert.equal(o.paidTime, null);
    assert.equal(o.items[0].sku, 'BK-SLD-PKM-000009');
  });
});

describe('buildGetOrdersInner', () => {
  it('windows by ModTime and paginates, defaulting to Completed orders', () => {
    const xml = buildGetOrdersInner({ modTimeFrom: '2026-07-19T00:00:00.000Z', modTimeTo: '2026-07-19T06:00:00.000Z', page: 2, entriesPerPage: 50 });
    assert.match(xml, /<OrderRole>Seller<\/OrderRole>/);
    assert.match(xml, /<OrderStatus>Completed<\/OrderStatus>/);
    assert.match(xml, /<ModTimeFrom>2026-07-19T00:00:00\.000Z<\/ModTimeFrom>/);
    assert.match(xml, /<ModTimeTo>2026-07-19T06:00:00\.000Z<\/ModTimeTo>/);
    assert.match(xml, /<EntriesPerPage>50<\/EntriesPerPage>/);
    assert.match(xml, /<PageNumber>2<\/PageNumber>/);
    assert.doesNotMatch(xml, /CreateTimeFrom/);
  });
});

describe('buildAddMemberMessageAAQToPartnerInner', () => {
  it('builds the member-message XML with an escaped body + the buyer as recipient', () => {
    const xml = buildAddMemberMessageAAQToPartnerInner({ itemId: '296123456789', recipientId: 'amycatwiz', subject: 'Thanks!', body: 'Cheers for grabbing the Flygon & Gardevoir.' });
    assert.match(xml, /<ItemID>296123456789<\/ItemID>/);
    assert.match(xml, /<RecipientID>amycatwiz<\/RecipientID>/);
    assert.match(xml, /<QuestionType>General<\/QuestionType>/);
    assert.match(xml, /<Body>Cheers for grabbing the Flygon &amp; Gardevoir\.<\/Body>/); // & escaped for XML
  });
});

describe('parseMemberMessages', () => {
  const FIX = `<GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
    <Ack>Success</Ack>
    <MemberMessage><MemberMessageExchangeArray>
      <MemberMessageExchange>
        <Question>
          <SenderID>amycatwiz</SenderID><RecipientID>omg.its.alcatrazz</RecipientID>
          <Subject>Re: Thanks for your order!</Subject>
          <Body>Thanks heaps &amp; do you have any Charizards?</Body>
          <MessageType>AskSellerQuestion</MessageType>
          <ItemID>296123456789</ItemID><MessageID>m-1</MessageID>
        </Question>
        <MessageStatus>Unanswered</MessageStatus>
        <CreationDate>2026-07-19T03:00:00.000Z</CreationDate>
        <Item><ItemID>296123456789</ItemID></Item>
      </MemberMessageExchange>
    </MemberMessageExchangeArray></MemberMessage>
  </GetMemberMessagesResponse>`;
  it('extracts a buyer-sent message (sender, item, status, time) for reply detection', () => {
    const { messages } = parseMemberMessages(FIX);
    assert.equal(messages.length, 1);
    const m = messages[0];
    assert.equal(m.senderId, 'amycatwiz');
    assert.equal(m.itemId, '296123456789');
    assert.equal(m.status, 'Unanswered');
    assert.equal(m.creationTime, '2026-07-19T03:00:00.000Z');
    assert.equal(m.messageId, 'm-1');
    assert.equal(m.body, 'Thanks heaps & do you have any Charizards?');
  });
  it('windows GetMemberMessages by creation time', () => {
    const xml = buildGetMemberMessagesInner({ startCreationTime: '2026-07-19T00:00:00.000Z', endCreationTime: '2026-07-19T06:00:00.000Z' });
    assert.match(xml, /<MailMessageType>AskSellerQuestion<\/MailMessageType>/);
    assert.match(xml, /<StartCreationTime>2026-07-19T00:00:00\.000Z<\/StartCreationTime>/);
  });
});

describe('xmlAmount / decodeEntities', () => {
  it('returns null cents for an absent node', () => {
    assert.deepEqual(xmlAmount('<x/>', 'Total'), { cents: null, currency: null });
  });
  it('rounds a dotted decimal to integer cents and reads currencyID', () => {
    assert.deepEqual(xmlAmount('<Total currencyID="AUD">7.05</Total>', 'Total'), { cents: 705, currency: 'AUD' });
  });
  it('decodes the common XML entities', () => {
    assert.equal(decodeEntities('Charizard &amp; Pikachu &#39;GX&#39;'), "Charizard & Pikachu 'GX'");
  });
});

describe('buildCompleteSaleInner', () => {
  it('marks a whole order dispatched by OrderID with no Shipment (untracked letter)', () => {
    const xml = buildCompleteSaleInner({ orderId: '14-14908-12300', shipped: true });
    assert.match(xml, /<OrderID>14-14908-12300<\/OrderID>/);
    assert.match(xml, /<Shipped>true<\/Shipped>/);
    assert.doesNotMatch(xml, /Shipment/);   // untracked → no tracking block
  });
  it('includes the tracking block only when BOTH number + carrier are supplied', () => {
    const xml = buildCompleteSaleInner({ orderId: 'X', tracking: 'AA123', carrier: 'AU_AUSTRALIA_POST' });
    assert.match(xml, /<ShipmentTrackingNumber>AA123<\/ShipmentTrackingNumber>/);
    assert.match(xml, /<ShippingCarrierUsed>AU_AUSTRALIA_POST<\/ShippingCarrierUsed>/);
    // tracking without a carrier must NOT emit a partial Shipment
    assert.doesNotMatch(buildCompleteSaleInner({ orderId: 'X', tracking: 'AA123' }), /Shipment/);
  });
  it('falls back to OrderLineItemID for a single line', () => {
    const xml = buildCompleteSaleInner({ orderLineItemId: '296123456789-1122334455' });
    assert.match(xml, /<OrderLineItemID>296123456789-1122334455<\/OrderLineItemID>/);
    assert.doesNotMatch(xml, /<OrderID>/);
  });
});

describe('matchLineItem (reconcile ladder → inventory location)', () => {
  const lookup = {
    bySku: new Map([['BK-PKM-000042', { kind: 'inventory', id: 7, location: 'Shelf A1', name: 'Flygon ex' }]]),
    byItemId: new Map([['296987654321', { kind: 'sealed', id: 8, location: 'Cage B', name: 'Booster Box' }]]),
    locSort: new Map(),
  };
  it('matches on SKU case-insensitively (primary key)', () => {
    const m = matchLineItem(lookup, { sku: 'bk-pkm-000042', ebay_item_id: '999' });
    assert.equal(m.id, 7); assert.equal(m.method, 'sku'); assert.equal(m.location, 'Shelf A1');
  });
  it('falls back to the eBay item id when the SKU misses', () => {
    const m = matchLineItem(lookup, { sku: 'UNKNOWN', ebay_item_id: '296987654321' });
    assert.equal(m.id, 8); assert.equal(m.method, 'item_id'); assert.equal(m.kind, 'sealed');
  });
  it('returns null for an unmatched line (→ Unsorted bucket)', () => {
    assert.equal(matchLineItem(lookup, { sku: 'nope', ebay_item_id: 'nope' }), null);
    assert.equal(matchLineItem(null, { sku: 'BK-PKM-000042' }), null);   // no inventory DB
  });
});

describe('buildPickSheet (sort + group by location)', () => {
  const rows = [
    { order_id: 'o2', location: null, title: 'Loose card', quantity: 1 },
    { order_id: 'o1', location: 'Shelf B', title: 'Card B', quantity: 2 },
    { order_id: 'o3', location: 'Shelf A', title: 'Card A', quantity: 1 },
    { order_id: 'o4', location: 'Vault', title: 'Card V', quantity: 3 },
  ];
  it('puts sort_order locations first, then alpha, then Unsorted last; sums units', () => {
    const locSort = new Map([['vault', 0]]);   // Vault pinned to the front
    const ps = buildPickSheet(rows, locSort);
    assert.deepEqual(ps.groups.map((g) => g.location), ['Vault', 'Shelf A', 'Shelf B', PICK_UNSORTED]);
    assert.equal(ps.unit_count, 7);
    assert.equal(ps.rows[0].order_id, 'o4');            // Vault row first
    assert.equal(ps.groups[3].items[0].title, 'Loose card');
  });
  it('with no sort_order, locations are alphabetical and Unsorted is last', () => {
    const ps = buildPickSheet(rows, new Map());
    assert.deepEqual(ps.groups.map((g) => g.location), ['Shelf A', 'Shelf B', 'Vault', PICK_UNSORTED]);
  });
});

describe('skuGroupLabel (SKU-prefix bin fallback for the pick sheet)', () => {
  it('strips the trailing number to the prefix bin', () => {
    assert.equal(skuGroupLabel('AAC-012'), 'SKU AAC');
    assert.equal(skuGroupLabel('AAA-073'), 'SKU AAA');
    assert.equal(skuGroupLabel('AAC012'), 'SKU AAC');       // no separator
    assert.equal(skuGroupLabel('AAB-018a'), 'SKU AAB');     // trailing variant letter
  });
  it('handles a prefix-less or empty SKU without throwing', () => {
    assert.equal(skuGroupLabel('12345'), 'SKU 12345');       // all digits → keep as-is
    assert.equal(skuGroupLabel(''), null);
    assert.equal(skuGroupLabel(null), null);
  });
});
