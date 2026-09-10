// lib/runs-arm.mjs — the positive live-arming guard for Keeper's Runs publishing.
//
// WHY THIS EXISTS, AND WHY IT EXISTS NOW. The plan for this module rested on four barriers between a dev
// run and the real shop, and named the strongest one an ABSENCE: the live `locationGid` and
// `publicationGid` were blank, so `guardPins` refused with a 409 whatever the flags said. Both are now
// populated — and `data/shopify.config.json` still carries the comment "EMPTY UNTIL MEASURED" beside
// them, as does `guardLiveStore`'s docblock in lib/shopify.mjs. The belt is gone and the trousers still
// say it is there.
//
// What remains is `publish.allowLive: false`, and `storeFor()` reads `?store=` straight off the query
// string with no allowlist. So the distance between a URL and a real product on the real shop is one
// boolean. This module replaces that with a positive check: publishing is refused unless every condition
// is affirmatively true, and the store must SAY WHAT IT IS before a byte is written.
//
// THE STORE IS READ FROM CONFIG, NEVER FROM THE REQUEST. That is the single most important line here.
// Everything else is a flag someone could flip; a target taken from a query parameter is a target an
// attacker — or an autocomplete — chooses.

import { saleGate } from './runs-anchor.mjs';

/**
 * Every reason this run may not publish to this store, as DATA rather than a throw.
 *
 * A list, because "you cannot publish" is useless to an operator without which condition is outstanding —
 * the same reasoning `saleGate` returns `{open, reasons}` rather than a boolean.
 */
export function armingState(db, { runsCfg, shopifyCfg, run, store = null } = {}) {
  const reasons = [];
  const fail = (code, message) => reasons.push({ code, message });

  // THE TARGET COMES FROM CONFIG. A caller may ASK for a store, and asking for one that is not the
  // configured target is itself a refusal rather than a redirect.
  const target = runsCfg?.publish?.store ?? 'dev';
  if (store && store !== target) {
    fail('store_mismatch', `this asked to publish to "${store}" but the configured target is "${target}"`);
  }

  if (!runsCfg?.publish?.enabled) {
    fail('runs_disarmed', 'runs publishing is disarmed (runs.config.json publish.enabled)');
  }
  // Deliberately a SEPARATE switch from shopify.publish.enabled, which is already true for singles.
  // Building this module must never silently inherit "armed" from a different lane.
  if (!shopifyCfg?.publish?.enabled) {
    fail('shopify_disarmed', 'Shopify publishing is disarmed (shopify.config.json publish.enabled)');
  }

  if (!run) return { armed: false, target, reasons: [...reasons, { code: 'no_run', message: 'no run given' }] };

  // A dev run can never reach the live shop, and this one is checkable from the identifier: the schema
  // ties `mode` to the DEV- prefix with a CHECK, and the prefix is inside headerDigest, so a dev run's
  // timestamp is self-labelling forever.
  if (run.mode === 'dev' && target === 'live') {
    fail('dev_run_live_store', `run ${run.public_id} is a dev rehearsal and can never publish to the live store`);
  }

  if (target === 'live') {
    if (shopifyCfg?.publish?.allowLive !== true) {
      fail('live_not_allowed', 'the live store is not allowed (shopify.config.json publish.allowLive)');
    }
    if (run.mode !== 'live') {
      fail('run_not_live', `run ${run.public_id} is mode "${run.mode}", not live`);
    }
    // A stub anchor proves nothing. §5.7.7 opens sales on a CONFIRMED Bitcoin timestamp, and a synthetic
    // receipt is not one.
    if (runsCfg?.anchor?.mode === 'stub') {
      fail('stub_anchor', 'the anchor mode is "stub", which proves nothing and cannot back a live sale');
    }
    // The §5.7.7 gate itself, reused rather than restated — it already knows about publication state,
    // the header digest and whether the timestamp confirmed.
    try {
      const gate = saleGate(db, run.id);
      if (!gate.open) for (const r of gate.reasons) fail('sale_gate', r);
    } catch (e) {
      fail('sale_gate', String(e?.message || e));
    }
  }

  return { armed: !reasons.length, target, reasons };
}

/**
 * Ask the STORE what it is.
 *
 * This is the one check with an external anchor. Every other condition derives from the same `.env`
 * through the same function, so together they only prove two variables differ — not that either is
 * right. If the dev shop domain were pointed at production by a typo, every env-derived check would pass
 * happily. `scripts/check-shopify.mjs` already makes exactly this argument before its write probes; this
 * promotes it from a probe into the publish path, which is where the write actually happens.
 */
export async function assertStoreIdentity(env, { store = 'dev', fetchImpl, graphql = null } = {}) {
  const call = graphql || (await import('./channels/shopify-admin.mjs')).shopifyGraphQL;
  const q = await call(env, '{ shop { name myshopifyDomain plan { displayName partnerDevelopment } } }',
    {}, { store, estimate: 5, fetchImpl });
  if (!q?.ok) {
    throw new Error(`could not ask the ${store} store what it is: ${q?.error || `HTTP ${q?.httpStatus}`}`);
  }
  const shop = q.data?.shop;
  const isDev = shop?.plan?.partnerDevelopment === true;
  // The assertion runs BOTH ways. A dev target answering "production" is the disaster; a live target
  // answering "development" means the live credentials are wrong and the publish would go nowhere real,
  // which is worth refusing too rather than reporting success against the wrong shop.
  if (store === 'dev' && !isDev) {
    throw new Error(`the store answering as "dev" is NOT a development store `
      + `(${shop?.myshopifyDomain}, plan ${shop?.plan?.displayName}) — refusing to write to it`);
  }
  if (store === 'live' && isDev) {
    throw new Error(`the store answering as "live" IS a development store `
      + `(${shop?.myshopifyDomain}) — the live credentials are not pointing at production`);
  }
  return { ok: true, store, domain: shop?.myshopifyDomain, plan: shop?.plan?.displayName, partnerDevelopment: isDev };
}

/**
 * The gate a publish route calls. Throws ONE sentence naming the first outstanding condition, and
 * carries the whole list on the error so a route can return all of them.
 *
 * `dryRun` is exempt from the store-identity check ALONE: a dry run returns before the first network
 * call, so there is no store to ask. It is not exempt from anything else.
 */
export async function assertArmed(env, db, {
  run, runsCfg, shopifyCfg, store = null, dryRun = false, fetchImpl, graphql = null,
} = {}) {
  const state = armingState(db, { runsCfg, shopifyCfg, run, store });
  if (!state.armed) {
    const err = new Error(`run ${run?.public_id ?? '?'} is not armed to publish to "${state.target}": `
      + state.reasons.map((r) => r.message).join('; '));
    err.code = 'not_armed';
    err.reasons = state.reasons;
    throw err;
  }
  if (dryRun) return { ...state, identity: null, dryRun: true };
  const identity = await assertStoreIdentity(env, { store: state.target, fetchImpl, graphql });
  return { ...state, identity };
}
