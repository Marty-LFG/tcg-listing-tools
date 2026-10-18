// test/helpers/channel-stubs.mjs — eBay and Shopify, played offline, for the cross-channel suites.
//
// eBay has no base-URL seam (lib/ebay-rest.mjs and lib/ebay-trading.mjs hard-code api.ebay.com), so it
// is played by replacing globalThis.fetch — the mechanism listings-publish / listings-revise already
// use. Shopify takes an injected fetchImpl, so it is played by a function handed in through the deps.
// Both record every call in order, because the assertion that matters in these suites is usually
// "eBay was asked to do exactly this, and nothing else".
//
// ANYTHING UNSTUBBED FAILS LOUDLY, never falls through to the network. A test that reached a real
// endpoint would be a test that can end a real listing.

export function resp(status, body, headers = {}) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
  };
}

/** A Trading GetItem body. `quantity` is eBay's TOTAL (available + sold). */
export function getItemXml({ itemId = '9001', status = 'Active', type = 'FixedPriceItem', quantity = 1, sold = 0, price = '25.00', sku = '' } = {}) {
  return `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${itemId}</ItemID><Title>Card</Title><SKU>${sku}</SKU>`
    + `<ListingType>${type}</ListingType><Quantity>${quantity}</Quantity>`
    + `<SellingStatus><CurrentPrice currencyID="AUD">${price}</CurrentPrice><QuantitySold>${sold}</QuantitySold>`
    + `<ListingStatus>${status}</ListingStatus></SellingStatus></Item></GetItemResponse>`;
}

/**
 * Install the eBay stub. `trading` maps a call name to (body, n) => xml; `rest` is (method, url, body)
 * => resp|undefined for the Sell APIs. Returns { calls, restore }.
 */
export function installEbayStub({ trading = {}, rest = null } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = opts.method || 'GET';
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    const callName = opts.headers && (opts.headers['X-EBAY-API-CALL-NAME'] || opts.headers['x-ebay-api-call-name']);
    if (callName) {
      const n = calls.filter((c) => c.call === callName).length + 1;
      calls.push({ api: 'trading', call: callName, body: String(opts.body || '') });
      const h = trading[callName];
      if (!h) return resp(200, `<${callName}Response><Ack>Failure</Ack><Errors><ErrorCode>1</ErrorCode><ShortMessage>unstubbed ${callName}</ShortMessage><LongMessage>unstubbed ${callName}</LongMessage><SeverityCode>Error</SeverityCode></Errors></${callName}Response>`);
      return resp(200, typeof h === 'function' ? h(String(opts.body || ''), n) : h);
    }
    let body = null; try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
    calls.push({ api: 'rest', method: m, url: u, body });
    const out = rest ? rest(m, u, body) : undefined;
    if (out) return out;
    return resp(404, { errors: [{ errorId: 1, message: `unstubbed ${m} ${u}` }] });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const levelAt = (locationGid, quantity) => [{ location: { id: locationGid }, quantities: [{ name: 'available', quantity }] }];

/**
 * The Shopify stub, as a fetchImpl. `levels` maps an inventory item gid to its available quantity at
 * `location` (undefined = not stocked). A set lowers/raises that stored number, so a second read sees it.
 * `orders` maps an order gid to the order node an `order(id:)` read returns; `ordersPage` is the poll's
 * page. `fail` makes every inventory call answer HTTP 500.
 */
export function shopifyStub({ location = 'gid://shopify/Location/1', levels = {}, orders = {}, ordersPage = null, fail = false } = {}) {
  const calls = [];
  const state = { levels: { ...levels }, fail };
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/admin/oauth/access_token')) return resp(200, { access_token: 't', scope: 'write_products', expires_in: 86399 });
    const { query: q, variables: v } = JSON.parse(init.body);
    if (q.includes('order(id:')) {
      calls.push({ op: 'order', variables: v });
      const node = orders[v.id];
      return resp(200, { data: { order: typeof node === 'function' ? node() : (node || null) } });
    }
    if (q.includes('orders(query:')) {
      calls.push({ op: 'orders', variables: v });
      const nodes = typeof ordersPage === 'function' ? ordersPage(v) : (ordersPage || []);
      return resp(200, { data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }
    // A refusal Shopify answers at once (a GraphQL error on a 200), rather than a 500 the transport
    // would retry with backoff for several seconds per test.
    if (state.fail && /inventory/i.test(q)) { calls.push({ op: 'fail' }); return resp(200, { errors: [{ message: 'Internal error. Looks like something went wrong on our end.' }] }); }
    if (q.includes('inventoryItem(id:')) {
      calls.push({ op: 'readLevel', variables: v });
      const n = state.levels[v.id];
      return resp(200, { data: { inventoryItem: { inventoryLevels: { nodes: n == null ? [] : levelAt(location, n) } } } });
    }
    if (q.includes('inventorySetQuantities')) {
      calls.push({ op: 'setQty', variables: v });
      const qv = v.input.quantities[0];
      if (state.levels[qv.inventoryItemId] !== qv.changeFromQuantity) {
        return resp(200, { data: { inventorySetQuantities: { userErrors: [{ field: null, message: 'changeFromQuantity is stale', code: 'CHANGE_FROM_QUANTITY_STALE' }] } } });
      }
      state.levels[qv.inventoryItemId] = qv.quantity;
      return resp(200, { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { changes: [] }, userErrors: [] } } });
    }
    if (q.includes('inventoryActivate')) {
      calls.push({ op: 'activate', variables: v });
      state.levels[v.inventoryItemId] = v.available;
      return resp(200, { data: { inventoryActivate: { inventoryLevel: { id: 'gid://shopify/InventoryLevel/1' }, userErrors: [] } } });
    }
    throw new Error('the Shopify stub was asked something the cross-channel paths should never send: ' + q.slice(0, 90));
  };
  return { fn, calls, state, ops: () => calls.map((c) => c.op) };
}

/** A Shopify order node in the shape lib/shopify-stock-orders.mjs asks for. */
export function shopifyOrder({ id = 5001, name = '#1001', financial = 'PAID', cancelledAt = null, test = false, customer = 77, lines = [], updatedAt = '2026-10-18T01:00:00Z' } = {}) {
  return {
    id: `gid://shopify/Order/${id}`, name, createdAt: '2026-10-18T00:59:00Z', processedAt: '2026-10-18T01:00:00Z', updatedAt,
    cancelledAt, test, displayFinancialStatus: financial, currencyCode: 'AUD', sourceName: 'web',
    customer: customer ? { id: `gid://shopify/Customer/${customer}` } : null,
    totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'AUD' } },
    subtotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'AUD' } },
    lineItems: {
      nodes: lines.map((l, i) => ({
        id: `gid://shopify/LineItem/${id}${i}`, sku: l.sku, quantity: l.qty || 1, name: l.name || l.sku,
        discountedTotalSet: { shopMoney: { amount: String(l.total ?? '10.00'), currencyCode: 'AUD' } },
      })),
      pageInfo: { hasNextPage: false },
    },
  };
}

export const EBAY_ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
export const SHOPIFY_ENV = { SHOPIFY_SHOP: 'bk-live-test', SHOPIFY_CLIENT_ID: 'fake-id', SHOPIFY_CLIENT_SECRET: 'fake-secret' };
export const LOC = 'gid://shopify/Location/1';
// The cross-channel switch is OPT-IN (lib/channel-sync.mjs syncArmed): a test that exercises the worker
// says so, exactly as the owner's .env will.
export const ARMED = { CROSS_CHANNEL_SYNC: 'on' };
