// test/unit/shopify-admin.test.mjs — the Shopify Admin GraphQL transport (lib/channels/shopify-admin.mjs).
// Offline: every test drives a stub fetch. The four properties that matter are the four the module's
// header calls out — HTTP 200 with errors is NOT ok, money never touches a float, the token is cached
// and the cost bucket paces the throttle — plus the store default, which is a safety rail.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  shopifyGraphQL, shopifyToken, resolveShop, moneyToCents, centsToMoney,
  collectUserErrors, graphqlErrors, firstErrorText, waitForBucket,
  API_VERSION, ShopifyNotConfigured, _clearTokenCache, _resetThrottle,
} from '../../lib/channels/shopify-admin.mjs';

const ENV = {
  SHOPIFY_SHOP: 'binderskeepers-live',
  SHOPIFY_DEV_SHOP: 'binderskeepers-dev',
  SHOPIFY_CLIENT_ID: 'client-id',
  SHOPIFY_CLIENT_SECRET: 'client-secret',
};

// A stub fetch that answers the token endpoint and then a scripted list of GraphQL responses.
function stubFetch(responses, { onToken } = {}) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/admin/oauth/access_token')) {
      if (onToken) onToken(url, init);
      return mkResponse(200, JSON.stringify({ access_token: 'tok-' + calls.length, scope: 'write_products', expires_in: 86399 }));
    }
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === 'function' ? r() : r;
  };
  fn.calls = calls;
  return fn;
}
function mkResponse(status, body, headers = {}) {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null }, text: async () => body };
}
const gql = (data, extra = {}) => mkResponse(200, JSON.stringify({ data, ...extra }));

beforeEach(() => { _clearTokenCache(); _resetThrottle(); });

describe('money never touches a float (GR3)', () => {
  it('parses decimal strings to integer cents', () => {
    assert.equal(moneyToCents('42.50'), 4250);
    assert.equal(moneyToCents('1234.00'), 123400);
    assert.equal(moneyToCents('42.5'), 4250);       // Shopify sometimes trims the trailing zero
    assert.equal(moneyToCents('42'), 4200);         // …and sometimes the point entirely
    assert.equal(moneyToCents('0.99'), 99);
    assert.equal(moneyToCents('-5.25'), -525);
  });
  it('survives the values a float would round wrong', () => {
    // 0.1+0.2 territory. Each of these is exact through the string path and lossy through parseFloat.
    assert.equal(moneyToCents('0.10'), 10);
    assert.equal(moneyToCents('0.29'), 29);
    assert.equal(moneyToCents('1.005'), 101);       // >2dp rounds rather than truncating to 100
    assert.equal(moneyToCents('8.26'), 826);        // the tracked-band postage figure
  });
  it('returns null for a non-value rather than 0 — a missing price is not a free card', () => {
    for (const v of [null, undefined, '', 'abc', {}]) assert.equal(moneyToCents(v), null);
  });
  it('round-trips through centsToMoney', () => {
    for (const c of [0, 99, 100, 4250, 123400, -525]) {
      assert.equal(moneyToCents(centsToMoney(c)), c, 'round trip failed for ' + c);
    }
    assert.equal(centsToMoney(4250), '42.50');
    assert.equal(centsToMoney(5), '0.05');
  });
});

describe('HTTP 200 with errors is NOT ok', () => {
  it('a populated userErrors array fails the call', async () => {
    const fetchImpl = stubFetch([gql({
      productSet: { product: { id: 'gid://shopify/Product/1' }, userErrors: [{ field: ['input', 'handle'], message: 'Handle already in use', code: 'TAKEN' }] },
    })]);
    const res = await shopifyGraphQL(ENV, 'mutation{}', {}, { fetchImpl });
    assert.equal(res.httpStatus, 200);
    assert.equal(res.ok, false, 'a 200 carrying userErrors must not read as success');
    assert.equal(res.userErrors.length, 1);
    assert.equal(res.userErrors[0].code, 'TAKEN');
    assert.equal(res.userErrors[0].mutation, 'productSet');
    assert.match(firstErrorText(res), /Handle already in use/);
  });

  it('finds userErrors nested below the top level, not just on the first field', async () => {
    const fetchImpl = stubFetch([gql({
      productSet: {
        product: {
          id: 'gid://1',
          media: { nodes: [{ mediaUserErrors: [{ field: ['file'], message: 'unsupported', code: 'INVALID' }] }] },
        },
        userErrors: [],
      },
    })]);
    const res = await shopifyGraphQL(ENV, 'mutation{}', {}, { fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.userErrors.length, 1);
    assert.equal(res.userErrors[0].message, 'unsupported');
  });

  it('a top-level GraphQL error fails the call', async () => {
    const fetchImpl = stubFetch([mkResponse(200, JSON.stringify({
      errors: [{ message: 'Field does not exist', path: ['productSet', 'nope'], extensions: { code: 'undefinedField' } }],
    }))]);
    const res = await shopifyGraphQL(ENV, 'mutation{}', {}, { fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].code, 'undefinedField');
  });

  it('a clean mutation is ok', async () => {
    const fetchImpl = stubFetch([gql({ productSet: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } })]);
    const res = await shopifyGraphQL(ENV, 'mutation{}', {}, { fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.userErrors.length, 0);
    assert.equal(res.data.productSet.product.id, 'gid://shopify/Product/1');
  });

  it('collectUserErrors is bounded and safe on odd payloads', () => {
    assert.deepEqual(collectUserErrors(null), []);
    assert.deepEqual(collectUserErrors({ a: { b: { c: {} } } }), []);
    assert.deepEqual(graphqlErrors(null), []);
  });
});

describe('the token', () => {
  it('is minted once and reused', async () => {
    let tokenCalls = 0;
    const fetchImpl = stubFetch([gql({ shop: { name: 'BK' } })], { onToken: () => { tokenCalls++; } });
    await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl });
    await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl });
    assert.equal(tokenCalls, 1, 'the second call must reuse the cached token');
  });

  it('is a client-credentials grant and never puts the secret on the GraphQL request', async () => {
    const fetchImpl = stubFetch([gql({ shop: { name: 'BK' } })]);
    await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl });
    const [tokenCall, gqlCall] = fetchImpl.calls;
    assert.match(tokenCall.init.body, /grant_type=client_credentials/);
    assert.equal(gqlCall.init.headers['X-Shopify-Access-Token'], 'tok-1');
    const serialised = JSON.stringify(gqlCall);
    assert.ok(!serialised.includes('client-secret'), 'the client secret must never reach the API call');
  });

  it('refuses clearly when credentials are missing, as data not an exception', async () => {
    const res = await shopifyGraphQL({ SHOPIFY_DEV_SHOP: 'x' }, '{ shop { name } }', {}, { fetchImpl: stubFetch([]) });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].code, 'not_configured');
    assert.equal(res.httpStatus, 0, 'nothing was sent');
  });

  it('throws ShopifyNotConfigured from the token helper itself', async () => {
    await assert.rejects(() => shopifyToken({}, { store: 'dev', fetchImpl: stubFetch([]) }), ShopifyNotConfigured);
  });
});

describe('the store default is a safety rail', () => {
  it('defaults to the DEV store, so reaching live takes an explicit argument', () => {
    assert.equal(resolveShop(ENV), 'binderskeepers-dev.myshopify.com');
    assert.equal(resolveShop(ENV, 'live'), 'binderskeepers-live.myshopify.com');
  });
  it('accepts a bare subdomain or a full domain', () => {
    assert.equal(resolveShop({ SHOPIFY_DEV_SHOP: 'shop.myshopify.com' }), 'shop.myshopify.com');
    assert.equal(resolveShop({ SHOPIFY_DEV_SHOP: 'https://shop.myshopify.com/' }), 'shop.myshopify.com');
  });
  it('names the missing variable rather than failing vaguely', () => {
    assert.throws(() => resolveShop({}, 'live'), /SHOPIFY_SHOP/);
    assert.throws(() => resolveShop({}, 'dev'), /SHOPIFY_DEV_SHOP/);
  });
  it('sends the call to the pinned API version', async () => {
    const fetchImpl = stubFetch([gql({ shop: { name: 'BK' } })]);
    await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl });
    assert.match(fetchImpl.calls[1].url, new RegExp(`/admin/api/${API_VERSION}/graphql\\.json$`));
  });
});

describe('throttle and retry', () => {
  it('retries a THROTTLED 200 and succeeds', async () => {
    let n = 0;
    const fetchImpl = stubFetch([() => {
      n++;
      return n === 1
        ? mkResponse(200, JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), { 'retry-after': '0' })
        : gql({ shop: { name: 'BK' } });
    }]);
    const res = await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl, retries: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 2);
  });

  it('retries a 5xx and gives up cleanly rather than throwing', async () => {
    const fetchImpl = stubFetch([mkResponse(500, 'upstream boom')]);
    const res = await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl, retries: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.httpStatus, 500);
    assert.equal(res.attempts, 2);
  });

  it('surfaces a network failure as data (GR7), never as a throw', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('access_token')) return mkResponse(200, JSON.stringify({ access_token: 't', expires_in: 86399 }));
      throw new Error('ECONNRESET');
    };
    const res = await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl, retries: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].code, 'network');
  });

  it('reads the cost bucket off the response', async () => {
    const fetchImpl = stubFetch([gql({ shop: { name: 'BK' } }, {
      extensions: { cost: { requestedQueryCost: 101, actualQueryCost: 46, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 954, restoreRate: 50 } } },
    })]);
    const res = await shopifyGraphQL(ENV, '{ shop { name } }', {}, { fetchImpl });
    assert.equal(res.cost.actualQueryCost, 46);
    assert.equal(res.cost.throttleStatus.currentlyAvailable, 954);
  });

  it('waitForBucket asks for a refill only when the bucket is genuinely low', () => {
    const at = 1_000_000;
    // Plenty available: no wait.
    assert.equal(waitForBucket({ available: 900, restoreRate: 50, at }, 50, at), 0);
    // Nearly empty: wait for enough to cover the estimate plus headroom.
    const wait = waitForBucket({ available: 0, restoreRate: 50, at }, 50, at);
    assert.ok(wait > 0, 'an empty bucket must produce a wait');
    assert.equal(wait, Math.ceil(((50 + 100) / 50) * 1000));
    // Time already passed counts as restored.
    assert.equal(waitForBucket({ available: 0, restoreRate: 50, at }, 50, at + 3000), 0);
    // No bucket known yet: never block the first call.
    assert.equal(waitForBucket(null, 50, at), 0);
  });
});
