// lib/ebay-notify-admin.mjs — the eBay side of push notifications: destinations and subscriptions.
//
// Separate from lib/ebay-notify.mjs on purpose. That module receives; this one negotiates. It touches
// no database, binds no socket, and holds no state — every function here is a call to eBay plus a
// decision about what to do next, which is what makes the reconciler testable without a server.
//
// TWO THINGS SHAPE EVERYTHING IN HERE.
//
// First, eBay validates a destination the moment you create it: it GETs your endpoint with a
// challenge code and refuses to create the destination if the reply is wrong. A destination that
// fails is DISABLED, not retried. So this never registers anything as a side effect of booting —
// the reconciler is dry-run by default and the only thing that writes is an explicit, token-gated
// call with apply=1.
//
// Second, a subscription is not a thing you delete. eBay reuses ids, and deleting one loses the
// record that it ever existed. Anything no longer wanted is DISABLED.
import { ebayRest, firstErrorText } from './ebay-rest.mjs';
import { ebayToken } from './ebay-token.mjs';

const BASE = '/commerce/notification/v1';

/**
 * One call to the Notification API, trying the APPLICATION token first and falling back to the USER
 * token.
 *
 * eBay's own contract says these endpoints accept either, but warns that a topic whose scopes you
 * lack returns error 195011 — and the seller-data topics are gated on USER scopes, which an
 * application token cannot carry. Rather than guess which endpoint wants which (the docs do not say,
 * and it plainly differs between them), try the cheap one and escalate. `usedToken` comes back on
 * every result so the reconciler can report what actually worked instead of us assuming.
 */
export async function notifyCall(env, method, path, body = null, { userOnly = false } = {}) {
  const attempt = async (which) => {
    const opts = { body: body || undefined };
    if (which === 'app') opts.token = await ebayToken(env);
    const r = await ebayRest(env, method, BASE + path, opts);
    return { ...r, usedToken: which };
  };

  if (!userOnly) {
    let appRes = null;
    try { appRes = await attempt('app'); } catch { /* fall through to the user token */ }
    if (appRes && appRes.ok) return appRes;
    // 195011 is "your authorization does not include the scopes this topic needs" — the documented
    // signal to escalate. 401/403 mean the same thing less specifically.
    const scopeProblem = appRes && (appRes.httpStatus === 401 || appRes.httpStatus === 403
      || /195011/.test(JSON.stringify(appRes.json || {})));
    if (appRes && !scopeProblem) return appRes;   // a real error; escalating would only obscure it
  }
  try { return await attempt('user'); }
  catch (e) {
    // getUserAccessToken throws { code:'not_connected' } before consent.
    return { ok: false, httpStatus: 0, json: null, usedToken: 'user', error: String(e?.message || e), code: e?.code || null };
  }
}

// `call` is injectable throughout so the reconciler's decision-making can be tested without eBay and
// without module mocking (ES module exports are immutable, so mock.method cannot patch them). Same
// seam as sweepOpenOrders' fetchOrders and verifyNotification's fetchKey.
// Follow eBay's `next` links so a long list is not silently truncated at the first page.
async function paged(env, path, key, call = notifyCall) {
  const out = [];
  let p = path + (path.includes('?') ? '&' : '?') + 'limit=100';
  let usedToken = null;
  for (let guard = 0; p && guard < 20; guard++) {
    const r = await call(env, 'GET', p);
    usedToken = r.usedToken;
    if (!r.ok) return { ok: false, error: firstErrorText(r.json) || r.error || ('http ' + r.httpStatus), items: out, usedToken };
    const j = r.json || {};
    out.push(...(j[key] || []));
    p = j.next ? j.next.replace(BASE, '') : null;
  }
  return { ok: true, items: out, usedToken };
}

export const getTopics = (env, call) => paged(env, '/topic', 'topics', call);
export const getDestinations = (env, call) => paged(env, '/destination', 'destinations', call);
export const getSubscriptions = (env, call) => paged(env, '/subscription', 'subscriptions', call);

// The APPLICATION-level notification config: the address eBay emails when it marks a destination
// down. It is not optional decoration — until it exists, the subscription endpoints refuse to answer
// at all with error 195003 ("Please provide configurations required for notifications"), which is a
// confusing way to be told that a prerequisite is missing rather than that a subscription is wrong.
export const getConfig = (env, call = notifyCall) => call(env, 'GET', '/config');
export const updateConfig = (env, alertEmail, call = notifyCall) =>
  call(env, 'PUT', '/config', { alertEmail });

// Endpoint identity, normalised the same way everywhere: it is what eBay actually delivers to and
// what the challenge hash is computed over, so a trailing slash must not read as a different one.
const normEndpoint = (s) => String(s || '').replace(/\/+$/, '');
const sameEndpoint = (a, b) => normEndpoint(a) === normEndpoint(b) && normEndpoint(a) !== '';

/**
 * "The app-level config does not exist yet" — which eBay reports with TWO different error numbers
 * depending on who you ask, and neither of them says so in plain terms:
 *
 *   195026  "Configuration not found."   HTTP 404 — from GET /config itself
 *   195003  "Please provide configurations required for notifications."  HTTP 409 — from every OTHER
 *           endpoint that needs it, most usefully GET /subscription
 *
 * Checking only 195003 is what made the first two live dry runs fail in a confusing way: getConfig
 * came back 195026, was not recognised as "missing", so nothing was planned to fix it, and then
 * getSubscriptions failed with 195003 and had no explanation attached. Matched by number rather than
 * message text so a wording change cannot turn a known prerequisite back into a mystery.
 */
function isConfigMissing(res) {
  const blob = JSON.stringify(res?.json || {}) + ' ' + String(res?.error || '');
  return /19502[6]|195003/.test(blob) || res?.httpStatus === 404;
}

export async function createDestination(env, { name, endpoint, verificationToken }, call = notifyCall) {
  return call(env, 'POST', '/destination', {
    name,
    status: 'ENABLED',
    deliveryConfig: { endpoint, verificationToken },
  });
}
export async function updateDestination(env, id, { name, endpoint, verificationToken }, call = notifyCall) {
  return call(env, 'PUT', '/destination/' + encodeURIComponent(id), {
    name,
    status: 'ENABLED',
    deliveryConfig: { endpoint, verificationToken },
  });
}
export const getDestination = (env, id, call = notifyCall) => call(env, 'GET', '/destination/' + encodeURIComponent(id));

export async function createSubscription(env, { destinationId, topicId, schemaVersion }, call = notifyCall) {
  return call(env, 'POST', '/subscription', {
    destinationId,
    topicId,
    // Created DISABLED so nothing is live until the destination has proved itself and the operator
    // has looked at the plan. enableSubscription is a separate, deliberate step.
    status: 'DISABLED',
    payload: { deliveryProtocol: 'HTTPS', format: 'JSON', schemaVersion },
  });
}
export const enableSubscription = (env, id, call = notifyCall) => call(env, 'POST', `/subscription/${encodeURIComponent(id)}/enable`);
export const disableSubscription = (env, id, call = notifyCall) => call(env, 'POST', `/subscription/${encodeURIComponent(id)}/disable`);
export const testSubscription = (env, id, call = notifyCall) => call(env, 'POST', `/subscription/${encodeURIComponent(id)}/test`);

/**
 * Highest schema version a topic offers over HTTPS/JSON.
 *
 * Read from eBay rather than hardcoded: ORDER_CONFIRMATION offers both 1.0 and 1.1 while every other
 * topic we want offers only 1.0, so a constant would either pin us to the older payload or ask for a
 * version most topics do not have.
 */
export function bestSchemaVersion(topic) {
  // `format` comes back as an ARRAY — {"format":["JSON"],"schemaVersion":"1.1","deliveryProtocol":"HTTPS"}
  // — not the string the docs' prose implies. Comparing it as a string filtered out every payload,
  // so this silently returned the '1.0' fallback for a topic that offers 1.1. Accept both shapes.
  const versions = (topic?.supportedPayloads || [])
    .filter((p) => {
      const formats = Array.isArray(p.format) ? p.format : [p.format || 'JSON'];
      const protos = Array.isArray(p.deliveryProtocol) ? p.deliveryProtocol : [p.deliveryProtocol || 'HTTPS'];
      return protos.includes('HTTPS') && formats.includes('JSON');
    })
    .map((p) => String(p.schemaVersion || '')).filter(Boolean);
  if (!versions.length) return '1.0';
  return versions.sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    return (pb[0] - pa[0]) || ((pb[1] || 0) - (pa[1] || 0));
  })[0];
}

/**
 * Work out what would have to change for eBay to match the config, WITHOUT changing anything.
 *
 * Returns a plan the operator can read before any of it happens. Everything that writes lives in
 * applyPlan, and the route that calls it needs the diagnostics token.
 */
export async function planReconcile(env, cfg, { call = notifyCall } = {}) {
  const plan = {
    ok: true, endpoint: cfg.public_endpoint, destination_name: cfg.destination_name,
    setConfig: null,
    destination: null, create: [], enable: [], updateDestination: false, disable: [], ok_already: [],
    warnings: [], errors: [], tokens: {},
  };

  const topicsRes = await getTopics(env, call);
  if (!topicsRes.ok) { plan.ok = false; plan.errors.push('getTopics: ' + topicsRes.error); return plan; }
  const topicById = new Map(topicsRes.items.map((t) => [t.topicId, t]));

  // App-level config comes first: without it the subscription endpoints answer 195003 and nothing
  // below this point can be read, let alone planned.
  const wantEmail = String(cfg.alert_email || '').trim();
  const cfgRes = await getConfig(env, call);
  const haveEmail = String(cfgRes?.json?.alertEmail || '').trim();
  if (!wantEmail) {
    plan.warnings.push('alert_email is not set — eBay emails that address when it marks the destination down, and the subscription API refuses to answer without an app config');
    if (!haveEmail) { plan.ok = false; plan.errors.push('alert_email must be set before eBay will accept subscriptions (error 195003)'); return plan; }
  } else if (!cfgRes.ok) {
    // Whatever went wrong, we know the address we want and PUT /config is how it gets there. An
    // unrecognised failure still plans the write, but says what it was rather than swallowing it —
    // silently leaving setConfig null is precisely what made this fail confusingly the first time.
    plan.setConfig = { action: 'create', alertEmail: wantEmail };
    if (!isConfigMissing(cfgRes)) {
      plan.warnings.push('getConfig failed unexpectedly (' + (firstErrorText(cfgRes.json) || cfgRes.error || ('http ' + cfgRes.httpStatus)) + ') — planning to set it anyway');
    }
  } else if (haveEmail !== wantEmail) {
    plan.setConfig = { action: 'update', from: haveEmail || null, alertEmail: wantEmail };
  }

  const destRes = await getDestinations(env, call);
  if (!destRes.ok) { plan.ok = false; plan.errors.push('getDestinations: ' + destRes.error); return plan; }

  // Match on the ENDPOINT, not the name. The endpoint is what eBay actually delivers to and what the
  // challenge hash is computed over; the name is a label we chose and could be edited at any time.
  const wanted = String(cfg.public_endpoint || '').replace(/\/+$/, '');
  const byEndpoint = destRes.items.find((d) => String(d.deliveryConfig?.endpoint || '').replace(/\/+$/, '') === wanted);
  const byName = destRes.items.find((d) => d.name === cfg.destination_name);
  const dest = byEndpoint || byName || null;

  if (!dest) {
    plan.destination = { action: 'create', name: cfg.destination_name, endpoint: wanted };
  } else {
    plan.destination = { action: 'reuse', id: dest.destinationId, name: dest.name, status: dest.status, endpoint: dest.deliveryConfig?.endpoint };
    if (!sameEndpoint(dest.deliveryConfig?.endpoint, wanted)) {
      plan.updateDestination = true;
      plan.destination.action = 'update-endpoint';
    } else if (dest.status && dest.status !== 'ENABLED') {
      // eBay marks a destination down after repeated delivery failures. Re-enabling is a PUT of the
      // same config, which re-runs the challenge — so it only succeeds once the endpoint is healthy.
      plan.updateDestination = true;
      plan.destination.action = 're-enable';
      plan.warnings.push(`destination is ${dest.status} — eBay disables one that keeps failing delivery`);
    }
  }

  const subsRes = await getSubscriptions(env, call);
  if (!subsRes.ok) {
    // Before the app config exists eBay refuses this endpoint outright. That is a prerequisite we are
    // already planning to satisfy, not a reason to abandon the plan — there can be no subscriptions
    // yet either, so treat the list as empty and let the plan describe creating them.
    if (isConfigMissing(subsRes) && plan.setConfig) {
      plan.warnings.push('subscriptions could not be read until the app config exists — planning as if none are registered');
      subsRes.items = [];
    } else {
      plan.ok = false; plan.errors.push('getSubscriptions: ' + subsRes.error); return plan;
    }
  }
  const destId = dest?.destinationId || null;
  const mine = destId ? subsRes.items.filter((s) => s.destinationId === destId) : [];
  const byTopic = new Map(mine.map((s) => [s.topicId, s]));

  for (const topicId of (cfg.topics || [])) {
    const t = topicById.get(topicId);
    if (!t) { plan.warnings.push(`topic ${topicId} is not in eBay's registry for this keyset`); continue; }
    const schemaVersion = bestSchemaVersion(t);
    const existing = byTopic.get(topicId);
    if (!existing) plan.create.push({ topicId, schemaVersion });
    else if (existing.status !== 'ENABLED') plan.enable.push({ topicId, id: existing.subscriptionId, from: existing.status });
    else plan.ok_already.push({ topicId, id: existing.subscriptionId, schemaVersion: existing.payload?.schemaVersion });
  }

  // Anything on our destination we no longer want gets disabled, never deleted.
  for (const s of mine) {
    if (!(cfg.topics || []).includes(s.topicId) && s.status === 'ENABLED') {
      plan.disable.push({ topicId: s.topicId, id: s.subscriptionId });
    }
  }

  plan.tokens = { config: cfgRes.usedToken, topics: topicsRes.usedToken, destinations: destRes.usedToken, subscriptions: subsRes.usedToken };
  plan.changes = plan.create.length + plan.enable.length + plan.disable.length + (plan.updateDestination ? 1 : 0)
    + (plan.destination?.action === 'create' ? 1 : 0) + (plan.setConfig ? 1 : 0);
  return plan;
}

/**
 * Carry out a plan. Ordered so a failure leaves the least mess: destination first (nothing can be
 * subscribed without it), then create-disabled, then enable. A subscription is only enabled once its
 * destination exists and eBay has accepted the challenge.
 */
export async function applyPlan(env, cfg, plan, { call = notifyCall } = {}) {
  const done = { config: null, created_destination: null, created: [], enabled: [], disabled: [], errors: [] };
  const fail = (what, r) => done.errors.push(`${what}: ${firstErrorText(r?.json) || r?.error || ('http ' + r?.httpStatus)}`);

  let destId = plan.destination?.id || null;
  const verificationToken = String(env.EBAY_NOTIFY_VERIFICATION_TOKEN || '').trim();
  if (!verificationToken) { done.errors.push('EBAY_NOTIFY_VERIFICATION_TOKEN is not set — eBay cannot validate the endpoint'); return done; }

  // App config before anything else: the subscription endpoints refuse to answer without it.
  if (plan.setConfig) {
    const r = await updateConfig(env, plan.setConfig.alertEmail, call);
    if (!r.ok) { fail('updateConfig', r); return done; }
    done.config = { alertEmail: plan.setConfig.alertEmail };
  }

  if (plan.destination?.action === 'create') {
    const r = await createDestination(env, { name: cfg.destination_name, endpoint: plan.endpoint, verificationToken }, call);
    if (!r.ok) { fail('createDestination', r); return done; }   // nothing else can proceed
    destId = r.json?.destinationId || null;
    if (!destId) {
      // eBay answers this one 201 Created with a Location header and NO body, so there is no id to
      // read — which stranded a successfully created (and challenge-validated) destination with
      // nothing subscribed to it. Rather than reach for header plumbing that ebayRest does not
      // expose, ask eBay what it now has and match on endpoint: the same identity rule planReconcile
      // uses, and it works whether or not a body ever appears.
      const back = await getDestinations(env, call);
      destId = back.ok ? (back.items.find((d) => sameEndpoint(d.deliveryConfig?.endpoint, plan.endpoint))?.destinationId || null) : null;
      if (!destId) fail('createDestination', { error: 'created, but eBay returned no destinationId and re-reading the list did not find it' });
    }
    done.created_destination = { id: destId, endpoint: plan.endpoint };
  } else if (plan.updateDestination && destId) {
    const r = await updateDestination(env, destId, { name: cfg.destination_name, endpoint: plan.endpoint, verificationToken }, call);
    if (!r.ok) { fail('updateDestination', r); return done; }
  }
  if (!destId) { done.errors.push('no destination id after apply — cannot touch subscriptions'); return done; }

  for (const c of plan.create) {
    const r = await createSubscription(env, { destinationId: destId, topicId: c.topicId, schemaVersion: c.schemaVersion }, call);
    if (!r.ok) { fail('createSubscription ' + c.topicId, r); continue; }
    const id = r.json?.subscriptionId;
    done.created.push({ topicId: c.topicId, id, schemaVersion: c.schemaVersion });
    const e = await enableSubscription(env, id, call);
    if (!e.ok) fail('enableSubscription ' + c.topicId, e); else done.enabled.push({ topicId: c.topicId, id });
  }
  for (const e of plan.enable) {
    const r = await enableSubscription(env, e.id, call);
    if (!r.ok) fail('enableSubscription ' + e.topicId, r); else done.enabled.push(e);
  }
  for (const d of plan.disable) {
    const r = await disableSubscription(env, d.id, call);
    if (!r.ok) fail('disableSubscription ' + d.topicId, r); else done.disabled.push(d);
  }
  return done;
}

export async function reconcile(env, cfg, { apply = false, call = notifyCall } = {}) {
  const plan = await planReconcile(env, cfg, { call });
  if (!plan.ok) return { ok: false, dry_run: !apply, plan };
  if (!apply) return { ok: true, dry_run: true, plan };
  const applied = await applyPlan(env, cfg, plan, { call });
  return { ok: applied.errors.length === 0, dry_run: false, plan, applied };
}

/** Health of the destination we deliver to — eBay disables one that keeps failing. */
export async function destinationHealth(env, cfg, call) {
  const res = await getDestinations(env, call);
  if (!res.ok) return { ok: false, error: res.error };
  const wanted = String(cfg.public_endpoint || '').replace(/\/+$/, '');
  const d = res.items.find((x) => String(x.deliveryConfig?.endpoint || '').replace(/\/+$/, '') === wanted);
  if (!d) return { ok: true, found: false, status: null };
  return { ok: true, found: true, id: d.destinationId, name: d.name, status: d.status, endpoint: d.deliveryConfig?.endpoint };
}
