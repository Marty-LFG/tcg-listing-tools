// scripts/check-shopify.mjs — the "S0" Shopify probes from docs/SHOPIFY_CHANNEL_PLAN.md.
//
// DEV STORE ONLY, and structurally so: every call goes through shopifyGraphQL with the default store,
// which resolveShop() resolves to SHOPIFY_DEV_SHOP. There is no --store flag and no live branch in this
// file, so reaching the live store is not a thing an operator can do by mistake here. The one guard
// that is not merely structural — a refusal if the resolved shop equals SHOPIFY_SHOP — is below.
//
// WHY THIS EXISTS. These four answers decide architecture for a cross-channel sync that must never
// oversell a one-of-one card, and three of them are things the documentation is either silent or
// self-contradictory about. A probe that reports a FALSE PASS is much worse than one that fails loudly:
// it would send the Phase 3 delist design the wrong way, and the mistake would not surface until a real
// card double-sold. So every probe reports the RAW EVIDENCE beside its verdict — "it worked" is not
// evidence, the returned values are — and every probe has an explicit SKIP state for "could not run",
// which is a different fact from "ran and the answer is no" (Golden Rule 7).
//
// WHAT IT WRITES. Probes 2 and 3 share one throwaway product on the dev store, created under a
// DETERMINISTIC handle so a crashed run leaves at most one orphan and the next run adopts and deletes
// it rather than accumulating litter. Cleanup runs in a finally. Probes 1 and 4 write nothing.
//
// WHAT IT PRINTS. Nothing that is a credential. The owner pastes this output into a chat, so the token,
// the client id and the client secret must never reach stdout; scope NAMES are printed (they are not
// secret and they are the whole point of probe 1), shop domains and product GIDs are printed.
//
// ⚠ DO NOT ADD THIS TO test/invariants/check-harnesses.test.mjs. Every harness in that list is offline
// and deterministic — stubbed fetch, :memory: DBs, local fixtures — which is what lets `pnpm test` run
// anywhere. This one is a LIVE diagnostic: it needs credentials and a network, and it writes to a real
// store. Putting it in the suite would make the whole suite fail on any machine without a .env, and
// would have every test run create and delete a product on the dev store.
//
// Run:  node --disable-warning=ExperimentalWarning scripts/check-shopify.mjs
//       node --disable-warning=ExperimentalWarning scripts/check-shopify.mjs --keep   (skip cleanup, for debugging)
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { shopifyGraphQL, shopifyToken, resolveShop, API_VERSION, firstErrorText } from '../lib/channels/shopify-admin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv('development', ROOT, '');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');

// The throwaway fixture. Deterministic on purpose (see the header): productSet keys on the handle, so a
// re-run after a crash updates the orphan rather than making a second one, and cleanup deletes it.
const FIXTURE_HANDLE = 'zz-bk-s0-probe-do-not-sell';
const FIXTURE_TAG = 'bk-s0-probe';
const NS = 'bkprobe';   // deliberately NOT bkc — nothing here should touch the real storefront vocabulary

// --- reporting ----------------------------------------------------------------------------------

const results = [];
const record = (probe, verdict, headline, evidence) => {
  results.push({ probe, verdict, headline, evidence: evidence || [] });
  const mark = verdict === 'PASS' ? '  ok  ' : verdict === 'FAIL' ? ' FAIL ' : ' skip ';
  console.log(`\n[${mark}] ${probe} — ${headline}`);
  for (const e of evidence || []) console.log('         ' + e);
};
const line = (s) => console.log(s);
// Every probe body is wrapped in this: a probe that throws is a broken probe, not an architectural
// answer, and it must not take the rest of the run down with it.
async function guard(probe, fn) {
  try { return await fn(); }
  catch (e) { record(probe, 'SKIP', 'the probe itself threw — this is a harness bug, not an answer', [String(e?.message || e)]); return null; }
}

// --- probe 1: connection, scopes, and the shipping location -------------------------------------

const NEEDED_SCOPES = [
  'write_products', 'write_inventory', 'read_locations', 'read_orders',
  'read_publications', 'write_publications', 'write_files', 'write_metaobjects',
];

async function probeConnection() {
  // Not-configured is a legitimate state with an obvious remedy, NOT a harness bug — resolveShop
  // throws ShopifyNotConfigured, and letting guard() catch it would report it as one.
  let devShop;
  try { devShop = resolveShop(env, 'dev'); }
  catch (e) {
    record('1 connection', 'SKIP', 'no dev store configured on this machine', [
      String(e?.message || e),
      'this harness is meant to run where the credentials live (ALCSERVER), not on a dev box',
    ]);
    return null;
  }
  // Belt and braces over the structural guarantee in the header. If the two are ever configured the
  // same, everything below would be writing to the live store.
  let liveShop = null;
  try { liveShop = (env.SHOPIFY_SHOP || '').trim() ? resolveShop(env, 'live') : null; } catch { /* live unset is fine */ }
  if (liveShop && devShop === liveShop) {
    record('1 connection', 'SKIP', 'SHOPIFY_DEV_SHOP and SHOPIFY_SHOP resolve to the SAME store — refusing to write', [`both resolve to ${devShop}`]);
    return null;
  }

  let tok;
  try { tok = await shopifyToken(env, { store: 'dev' }); }
  catch (e) { record('1 connection', 'SKIP', 'could not mint a token', [String(e?.message || e)]); return null; }

  const granted = new Set(String(tok.scope || '').split(/[\s,]+/).filter(Boolean));
  const missing = NEEDED_SCOPES.filter((s) => !granted.has(s));

  const shopQ = await shopifyGraphQL(env, '{ shop { name myshopifyDomain plan { displayName } } }', {}, { estimate: 5 });
  if (!shopQ.ok) {
    record('1 connection', 'FAIL', 'token minted but the shop query failed', [firstErrorText(shopQ) || `HTTP ${shopQ.httpStatus}`]);
    return null;
  }
  const shop = shopQ.data.shop;

  const locQ = await shopifyGraphQL(env,
    '{ locations(first: 20) { nodes { id name isActive fulfillsOnlineOrders shipsInventory } } }', {}, { estimate: 10 });
  const locs = locQ.ok ? locQ.data.locations.nodes : [];
  // NEVER locations[0]: a dev store's first location ships with shipsInventory:false, and stock placed
  // there reads as in-stock through the API while the storefront says "Unavailable".
  const shipping = locs.find((l) => l.isActive && l.fulfillsOnlineOrders && l.shipsInventory) || null;

  const ev = [
    `store        ${shop.myshopifyDomain}  (${shop.name}, plan ${shop.plan?.displayName || '?'})`,
    `api version  pinned ${API_VERSION}`,
    `scopes       ${granted.size} granted`,
    `  needed     ${NEEDED_SCOPES.map((s) => (granted.has(s) ? '+' : '-') + s).join('  ')}`,
    `locations    ${locs.length} total`,
  ];
  for (const l of locs) {
    ev.push(`  ${l.shipsInventory && l.isActive && l.fulfillsOnlineOrders ? '>' : ' '} ${l.name}  active=${l.isActive} online=${l.fulfillsOnlineOrders} ships=${l.shipsInventory}`);
  }
  ev.push(shipping ? `qualifying   ${shipping.name}` : 'qualifying   NONE — no location satisfies active && fulfillsOnlineOrders && shipsInventory');

  if (missing.length) {
    record('1 connection', 'FAIL', `connected, but ${missing.length} required scope(s) are NOT granted`, [...ev, `MISSING      ${missing.join(', ')}`]);
  } else if (!shipping) {
    record('1 connection', 'FAIL', 'connected with every scope, but no location can hold sellable stock', ev);
  } else {
    record('1 connection', 'PASS', 'connected, all required scopes granted, a shipping location exists', ev);
  }
  return { shop, shipping, missing, granted };
}

// --- the shared fixture -------------------------------------------------------------------------

const PRODUCT_SET = `
mutation Probe($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
  productSet(identifier: $identifier, input: $input, synchronous: true) {
    product {
      id handle tags
      metafields(first: 20) { nodes { namespace key value } }
      variants(first: 1) { nodes { id sku inventoryItem { id } } }
    }
    userErrors { field message code }
  }
}`;

function fixtureInput({ metafields, tags }) {
  return {
    handle: FIXTURE_HANDLE,
    title: 'BK S0 probe — do not sell',
    status: 'DRAFT',                     // DRAFT, so it can never be bought even if publishing misfires
    tags,
    productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
    variants: [{
      optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      sku: 'BK-S0-PROBE',
      price: '1.00',
      inventoryPolicy: 'DENY',
      inventoryItem: { tracked: true },
    }],
    metafields,
  };
}

const mf = (key, value) => ({ namespace: NS, key, value, type: 'single_line_text_field' });

async function deleteFixture(id) {
  if (!id) return null;
  return shopifyGraphQL(env,
    'mutation D($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }',
    { input: { id } }, { estimate: 10 });
}

async function findFixture() {
  const q = await shopifyGraphQL(env,
    'query F($h: String!) { productByIdentifier(identifier: { handle: $h }) { id handle } }',
    { h: FIXTURE_HANDLE }, { estimate: 5 });
  return q.ok ? (q.data.productByIdentifier || null) : null;
}

// --- probe 2: does productSet DELETE what a later call omits? -----------------------------------

async function probeProductSetReplace() {
  // Create with THREE metafields and THREE tags.
  const first = await shopifyGraphQL(env, PRODUCT_SET, {
    identifier: { handle: FIXTURE_HANDLE },
    input: fixtureInput({
      metafields: [mf('alpha', 'a'), mf('beta', 'b'), mf('gamma', 'c')],
      tags: [FIXTURE_TAG, 'probe-tag-two', 'probe-tag-three'],
    }),
  }, { estimate: 30 });

  if (!first.ok) {
    record('2 productSet replace', 'SKIP', 'could not create the fixture, so the semantics were never tested',
      [firstErrorText(first) || `HTTP ${first.httpStatus}`]);
    return null;
  }
  const p0 = first.data.productSet.product;
  const before = {
    mf: p0.metafields.nodes.filter((m) => m.namespace === NS).map((m) => m.key).sort(),
    tags: [...p0.tags].sort(),
  };

  // Second call on the SAME identifier, carrying ONE metafield and ONE tag. Every other field is
  // repeated verbatim so the only variable is the two list fields.
  const second = await shopifyGraphQL(env, PRODUCT_SET, {
    identifier: { handle: FIXTURE_HANDLE },
    input: fixtureInput({ metafields: [mf('alpha', 'a')], tags: [FIXTURE_TAG] }),
  }, { estimate: 30 });

  if (!second.ok) {
    record('2 productSet replace', 'SKIP', 'the second productSet call failed, so nothing was learned',
      [firstErrorText(second) || `HTTP ${second.httpStatus}`, `created: ${p0.id}`]);
    return p0;
  }
  const p1 = second.data.productSet.product;
  const after = {
    mf: p1.metafields.nodes.filter((m) => m.namespace === NS).map((m) => m.key).sort(),
    tags: [...p1.tags].sort(),
  };

  const ev = [
    `before  metafields[${NS}]: ${before.mf.join(', ') || '(none)'}`,
    `        tags:              ${before.tags.join(', ') || '(none)'}`,
    `after   metafields[${NS}]: ${after.mf.join(', ') || '(none)'}`,
    `        tags:              ${after.tags.join(', ') || '(none)'}`,
  ];

  // The probe is only meaningful if the FIRST call actually wrote all three of each. Without this the
  // "after" state could look like a replace when in truth nothing was ever written.
  if (before.mf.length !== 3 || before.tags.length !== 3) {
    record('2 productSet replace', 'SKIP', 'the setup did not take — cannot distinguish a replace from a write that never happened', ev);
    return p1;
  }

  const mfReplaced = after.mf.length === 1 && after.mf[0] === 'alpha';
  const tagsReplaced = after.tags.length === 1 && after.tags[0] === FIXTURE_TAG;

  if (mfReplaced && tagsReplaced) {
    record('2 productSet replace', 'PASS', 'CONFIRMED: omitted metafields and tags are DELETED — every publish must send complete state', ev);
  } else if (!mfReplaced && !tagsReplaced) {
    record('2 productSet replace', 'FAIL', 'omitted entries SURVIVED — productSet merged rather than replaced. The plan assumes replace; re-check before building on it', ev);
  } else {
    record('2 productSet replace', 'FAIL', `MIXED: metafields ${mfReplaced ? 'replaced' : 'merged'}, tags ${tagsReplaced ? 'replaced' : 'merged'} — the two list fields do not behave alike`, ev);
  }
  return p1;
}

// --- probe 3: is changeFromQuantity really a compare-and-swap? ----------------------------------

const SET_QTY = `
mutation SetQty($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { changes { name delta quantityAfterChange } }
    userErrors { field message code }
  }
}`;

const setQty = (inventoryItemId, locationId, quantity, changeFromQuantity) => shopifyGraphQL(env, SET_QTY, {
  input: {
    name: 'available',
    reason: 'correction',
    referenceDocumentUri: 'gid://tcg-listing-tools/S0Probe/changefrom',
    quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity }],
  },
  // A FRESH key per attempt. Reusing one would make the second call a replay of the first, and a replay
  // that "succeeds" is exactly how this probe would report a false PASS.
  key: crypto.randomUUID(),
}, { estimate: 20 });

async function probeChangeFromQuantity(product, shipping) {
  if (!shipping) { record('3 changeFromQuantity CAS', 'SKIP', 'no qualifying shipping location (probe 1)'); return; }
  if (!product) { record('3 changeFromQuantity CAS', 'SKIP', 'no fixture product (probe 2)'); return; }

  const invItem = product.variants?.nodes?.[0]?.inventoryItem?.id;
  if (!invItem) { record('3 changeFromQuantity CAS', 'SKIP', 'the fixture has no inventory item'); return; }

  // Stock it at the qualifying location. inventoryActivate is the only call that can attach an item to
  // a location it is not yet stocked at, and it too requires @idempotent.
  const act = await shopifyGraphQL(env, `
    mutation A($inventoryItemId: ID!, $locationId: ID!, $key: String!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: 5) @idempotent(key: $key) {
        inventoryLevel { id quantities(names: ["available"]) { name quantity } }
        userErrors { field message }
      }
    }`, { inventoryItemId: invItem, locationId: shipping.id, key: crypto.randomUUID() }, { estimate: 20 });

  // Already-active is fine — read the current figure instead of assuming 5.
  const read = await shopifyGraphQL(env, `
    query R($id: ID!) {
      inventoryItem(id: $id) {
        inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { name quantity } } }
      }
    }`, { id: invItem }, { estimate: 10 });
  if (!read.ok) {
    record('3 changeFromQuantity CAS', 'SKIP', 'could not read the current quantity',
      [firstErrorText(read) || `HTTP ${read.httpStatus}`, act.ok ? '' : 'activate: ' + (firstErrorText(act) || '')].filter(Boolean));
    return;
  }
  const level = read.data.inventoryItem?.inventoryLevels?.nodes?.find((n) => n.location.id === shipping.id);
  const current = level?.quantities?.find((q) => q.name === 'available')?.quantity;
  if (!Number.isFinite(current)) {
    record('3 changeFromQuantity CAS', 'SKIP', 'the fixture is not stocked at the qualifying location', [`activate ok=${act.ok}`]);
    return;
  }

  // (a) a CORRECT changeFromQuantity must succeed.
  const good = await setQty(invItem, shipping.id, current + 1, current);
  // (b) the NOW-STALE original must be refused. This is the assertion the whole probe exists for.
  const stale = await setQty(invItem, shipping.id, current + 2, current);

  const staleCodes = (stale.userErrors || []).map((e) => e.code).filter(Boolean);
  const ev = [
    `available before   ${current}`,
    `(a) correct changeFromQuantity=${current} -> ok=${good.ok}` + (good.ok ? '' : '  ' + (firstErrorText(good) || '')),
    `(b) STALE  changeFromQuantity=${current} -> ok=${stale.ok}  codes=[${staleCodes.join(', ') || 'none'}]`,
    `    ${stale.ok ? 'NO REFUSAL — the stale write was accepted' : (firstErrorText(stale) || '')}`,
  ];

  if (!good.ok) {
    record('3 changeFromQuantity CAS', 'SKIP', 'the CORRECT write failed, so the stale case proves nothing', ev);
    return;
  }
  if (stale.ok) {
    // The dangerous outcome, and the reason this probe is written the way it is.
    record('3 changeFromQuantity CAS', 'FAIL', 'NOT a compare-and-swap here — a stale changeFromQuantity was ACCEPTED. The simultaneous-purchase race has no defence; do not build on it', ev);
    return;
  }
  const named = staleCodes.includes('CHANGE_FROM_QUANTITY_STALE');
  record('3 changeFromQuantity CAS', named ? 'PASS' : 'FAIL',
    named
      ? 'CONFIRMED: a stale changeFromQuantity is refused with CHANGE_FROM_QUANTITY_STALE — the race has a real defence'
      : 'the stale write was refused, but NOT with CHANGE_FROM_QUANTITY_STALE — the refusal may be unrelated, so this does not prove a CAS',
    ev);
}

// --- probe 4: is buyer PII redacted for this app on this plan? ----------------------------------

async function probeProtectedCustomerData() {
  const q = await shopifyGraphQL(env, `
    {
      orders(first: 5, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id name createdAt
          customer { firstName lastName email }
          shippingAddress { address1 city zip }
        }
      }
    }`, {}, { estimate: 30 });

  // Redaction is an HTTP 200 with nulls PLUS a top-level errors array. Checking ok alone would read that
  // as a clean empty answer, which is the exact misreading this probe exists to prevent.
  const errTxt = (q.errors || []).map((e) => `${e.code || ''} ${e.message}`.trim());
  const scopeish = errTxt.some((t) => /scope|not approved|access denied|protected customer/i.test(t));
  const nodes = q.data?.orders?.nodes || [];

  if (scopeish) {
    record('4 protected customer data', 'SKIP', 'the app is not approved (or lacks the scope) for this data — a permissions answer, not a plan answer', errTxt);
    return;
  }
  if (!q.ok && !nodes.length) {
    record('4 protected customer data', 'SKIP', 'the orders query failed outright', [firstErrorText(q) || `HTTP ${q.httpStatus}`]);
    return;
  }
  if (!nodes.length) {
    record('4 protected customer data', 'SKIP', 'no orders on the DEV store to test with — create one with ../bk-shopify/scripts/place-test-order.ps1 and re-run', errTxt);
    return;
  }

  // Never print a real buyer's details. Presence is the whole question; the value is nobody's business.
  const present = (v) => (v == null ? 'null' : (String(v).trim() === '' ? 'empty' : 'PRESENT'));
  const ev = [];
  let anyPii = false;
  for (const o of nodes) {
    const bits = [
      `customer.firstName=${present(o.customer?.firstName)}`,
      `customer.email=${present(o.customer?.email)}`,
      `shippingAddress.address1=${present(o.shippingAddress?.address1)}`,
    ];
    if (o.customer?.firstName || o.customer?.email || o.shippingAddress?.address1) anyPii = true;
    ev.push(`${o.name}  ${bits.join('  ')}`);
  }
  if (errTxt.length) ev.push(...errTxt.map((t) => 'errors[]: ' + t));

  if (anyPii) {
    record('4 protected customer data', 'PASS', 'buyer PII IS readable by this custom app — bk-shopify D-022 is wrong about redaction on this plan', ev);
  } else {
    record('4 protected customer data', 'PASS', 'buyer PII is REDACTED (200 + nulls) — D-022 is right, and the ledger must tolerate de-identified orders', ev);
  }
}

// --- main ---------------------------------------------------------------------------------------

line('Shopify S0 probes — docs/SHOPIFY_CHANNEL_PLAN.md');
line('DEV STORE ONLY. Probes 1 and 4 write nothing; 2 and 3 share one throwaway DRAFT product.\n');

let fixture = null;
try {
  const conn = await guard('1 connection', probeConnection);
  if (!conn) {
    line('\nprobes 2-4 skipped: no usable connection.');
  } else {
    // Adopt an orphan from a previous crashed run so litter never accumulates.
    const orphan = await findFixture();
    if (orphan) line(`(adopting an orphaned fixture from a previous run: ${orphan.id})`);

    fixture = await guard('2 productSet replace', probeProductSetReplace);
    await guard('3 changeFromQuantity CAS', () => probeChangeFromQuantity(fixture, conn.shipping));
    await guard('4 protected customer data', probeProtectedCustomerData);
  }
} finally {
  // Cleanup runs even when a probe above failed midway — that is the whole point of the finally.
  const id = fixture?.id || (await findFixture().catch(() => null))?.id || null;
  if (id && !KEEP) {
    const del = await deleteFixture(id).catch(() => null);
    line(`\ncleanup: fixture ${id} ${del?.ok ? 'deleted' : 'NOT deleted — remove it by hand'}`);
  } else if (id) {
    line(`\ncleanup: --keep, fixture left in place: ${id}`);
  }
}

line('\n──────── summary ────────');
for (const r of results) line(`${r.verdict.padEnd(4)}  ${r.probe.padEnd(28)} ${r.headline}`);
const failed = results.filter((r) => r.verdict === 'FAIL').length;
const skipped = results.filter((r) => r.verdict === 'SKIP').length;
line(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
line('No credential appears in this output — it is safe to paste verbatim.');
process.exit(failed ? 1 : 0);
